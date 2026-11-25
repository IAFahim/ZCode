import {
  RESUME_CONTEXT_COMPACT_DELAY_MS,
  normalizeQuotaWatchdogSettings,
  QUOTA_WATCHDOG_DEFAULT_SETTINGS,
  type CodingPlanResetScopeRequest,
  type CodingPlanResetStatusSnapshot,
  type QuotaWatchdogSettings,
  type QuotaWatchdogStatus,
  type ResumeIntent,
  type ResumeIntentKind,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  nextTransientEligibleAt,
  quotaEligibleAt,
  ResumeIntentRepo,
} from "#src/session/resumeIntentRepo.js";
import type { ISettingService } from "#src/setting/setting.js";
import type { IUsageStatsService } from "./usageStats.js";
import {
  classifyTurnFailure,
  computeWakeDelayMs,
  createInitialWatchdogStatus,
  remainingPercentFromEntitlement,
  resolveClaimTarget,
  shouldAttemptOpportunityCall,
  transitionOnObservationError,
  transitionWatchdogState,
  watchdogPollDelayMs,
  type WatchdogRuntimeStatus,
} from "./quotaWatchdogDomain.js";
import {
  createEmptyClaimBookkeeping,
  createQuotaResumeClaim,
  type QuotaResumeClaim,
} from "./quotaResumeClaim.js";
import {
  createQuotaResumeGate,
  SELF_COMPACT_ACTIVE_WINDOW_MS,
  type QuotaResumeGate,
} from "./quotaResumeGate.js";

// 配额守护与自动续跑（docs/quota-watchdog/spec.md）：
// Host 进程内唯一运行态所有者。renderer 只读展示（横幅/设置），不保存任何已接纳状态。
// - 看门狗状态机：idle/watching/claiming/waiting_reset/restored，节奏见 quotaWatchdogDomain。
// - 自动核销：只走既有 /use（幂等 key + reset_type），/opportunity 资格判断仅在主动状态且
//   冷却允许时触发（补位 renderer hidden 轮询真空），对账期间绝不调用 /opportunity。
// - 自动续跑：resume_intents 表持久化意图，派发经 dispatch port（retryTurn 优先，
//   attributed sendText 回退），成功 turn 删除意图，连续失败触顶转 exhausted。

/** 单次派发 turn 的结局等待上限；超时按 failed 收口（意图回队或转 exhausted）。 */
const TURN_OUTCOME_TIMEOUT_MS = 60 * 60_000;
/** nextResetTime 未知时额度类意图的兜底重试间隔。 */
const QUOTA_FALLBACK_RETRY_MS = 10 * 60_000;
/** checkpoint 单行 key（quota_watchdog_checkpoint 表）。 */
const CHECKPOINT_KEY = "watchdog";

/** 派发 turn 结局：失败时携带归因线索（code/attribution.reason）供结算权威归类。 */
export interface TurnOutcomeWaitResult {
  outcome: "completed" | "failed";
  errorMessage?: string;
  errorCode?: string | null;
  attributionReason?: string | null;
}

export interface QuotaResumeDispatchPort {
  /** 目标 task 是否正在运行/流式（用户已自行活动时不派发，转为取消）。 */
  isTaskActive(input: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean>;
  /** v4 retryTurn（canonical intent 重放）；host CAS 探测在 port 实现内收敛。 */
  retryTurn(input: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    rowTarget: { rowId: number; entityId: string };
    resumeIntentId: string;
  }): Promise<void>;
  /** attributed sendText 回退（retryTurn 不可用/探测失败时）。 */
  sendResumeText(input: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    resumeIntentId: string;
  }): Promise<void>;
  /** v4 compact 维护命令（idle 立即执行 / busy 进 FIFO），context 溢出先压缩再续跑。 */
  requestCompact(input: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
  /**
   * 等待该 session 下一个 turn 终态（task_complete / task_error）；超时按 failed 收口。
   * v2：task_error 携带 code/attribution.reason，结算据此权威归类（不依赖 renderer 上报）。
   */
  awaitTurnOutcome(input: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    timeoutMs?: number;
  }): Promise<TurnOutcomeWaitResult>;
}

export interface QuotaWatchdogServiceDeps {
  usageStatsService: IUsageStatsService;
  resumeIntentRepo: ResumeIntentRepo;
  settingService: ISettingService;
  dispatch: QuotaResumeDispatchPort;
  /** 解析当前 Coding Plan reset scope（preferredProviderId + accountAccess）；无连接时 null。 */
  resolveResetScope: () => Promise<CodingPlanResetScopeRequest | null>;
}

interface WatchdogCheckpointPayload {
  status: WatchdogRuntimeStatus;
}

const serviceLogger = createServiceLogger("quota-watchdog");

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class QuotaWatchdogService {
  private status: WatchdogRuntimeStatus = createInitialWatchdogStatus();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private disposed = false;
  /** /opportunity 与 /use 簿记（唯一实例由本 service 持有；逻辑在 quotaResumeClaim）。 */
  private readonly claimBookkeeping = createEmptyClaimBookkeeping();
  /** 核销/机会逻辑（claimResets / requestOpportunity）。 */
  private readonly claim: QuotaResumeClaim;
  /** 上次观测到的可认领卡事实；status 拉取失败时复用，避免误判落到 waiting_reset。 */
  private lastClaimableCard = false;
  /** 失败上报时暂存的 failed 行目标（retryTurn 用）；成功/取消后清除。 */
  private readonly failedRowTargets = new Map<string, { rowId: number; entityId: string }>();
  /** 在途派发结局等待（taskId → promise），tick 不重复派发同一 task。 */
  private readonly pendingOutcomes = new Map<string, Promise<void>>();
  /** v2：同 task 失败上报/结算串行化（消除 upsert 与 requeue 的 UNIQUE 竞态与 attempt 双计）。 */
  private readonly taskLocks = new Map<string, Promise<void>>();
  /** v2：已对 task 发起过 /compact 的 context 意图（第二次 context 失败即 exhausted）。 */
  private readonly contextCompactArmed = new Set<string>();
  /** v2：自发 compact 活动窗口（窗口内 isTaskActive 视为己方活动，守卫重排而非取消意图）。 */
  private readonly selfCompactUntil = new Map<string, number>();
  /** v2 派发门（quotaResumeGate）：核销前置 + 不盲放行；意图簿记经回调注入。 */
  private readonly gate: QuotaResumeGate;

  constructor(private readonly deps: QuotaWatchdogServiceDeps) {
    this.claim = createQuotaResumeClaim(deps.usageStatsService, this.claimBookkeeping);
    this.gate = createQuotaResumeGate({
      resumeIntentRepo: deps.resumeIntentRepo,
      usageStatsService: deps.usageStatsService,
      claimResetCard: (snapshot, scope) => this.claim.claimResets(snapshot, scope),
      requestCompact: (input) => this.deps.dispatch.requestCompact(input),
      isContextCompactArmed: (taskId) => this.contextCompactArmed.has(taskId),
      armContextCompact: (taskId) => this.contextCompactArmed.add(taskId),
      markSelfCompactActivity: (taskId) =>
        this.selfCompactUntil.set(taskId, Date.now() + SELF_COMPACT_ACTIVE_WINDOW_MS),
      scheduleNextTick: () => this.scheduleNextTick(),
    });
  }

  /** 同 task 串行执行（v2）：renderer 失败上报与派发结算竞态是 v1 UNIQUE 崩溃与计数漂移根因。 */
  private withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.taskLocks.get(taskId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined).then(() => undefined);
    this.taskLocks.set(taskId, tail);
    void tail.then(() => {
      if (this.taskLocks.get(taskId) === tail) {
        this.taskLocks.delete(taskId);
      }
    });
    return next;
  }

  /** Host 启动恢复：回收崩溃实例的 dispatched 行 + 重挂 checkpoint，再启动循环。
   *  v2：两步恢复各自收错——v1 一处抛错（如迁移期 UNIQUE）会连带跳过 checkpoint 重挂。 */
  async init(): Promise<void> {
    try {
      await this.deps.resumeIntentRepo.recoverStaleDispatched(Date.now());
    } catch (error) {
      serviceLogger.warn("watchdog init stale recovery failed", {
        error: toErrorMessage(error),
      });
    }
    try {
      const raw = await this.deps.resumeIntentRepo.getCheckpoint(CHECKPOINT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as WatchdogCheckpointPayload;
        if (parsed?.status?.state) {
          // 重启后 restored 不能重发：quotaRestored 只由状态机迁移产生，checkpoint 仅恢复观测底座。
          this.status = {
            ...createInitialWatchdogStatus(),
            ...parsed.status,
            state: parsed.status.state === "restored" ? "idle" : parsed.status.state,
          };
        }
      }
    } catch (error) {
      serviceLogger.warn("watchdog init checkpoint restore failed", {
        error: toErrorMessage(error),
      });
    }
    this.ensureLoop();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ---- 对 renderer 暴露的契约（IUsageStatsService 可选方法委托） ----

  async reportAutoResumeFailure(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    kind: "quota" | "transient";
    errorMessage: string;
    nextResetTime: number | null;
    failedRowTarget?: { rowId: number; entityId: string } | null;
    providerErrorCode?: string | null;
    attributionReason?: string | null;
  }): Promise<void> {
    const settings = await this.readSettings();
    if (!settings.autoResumeEnabled) {
      return;
    }
    if (params.failedRowTarget) {
      this.failedRowTargets.set(params.taskId, params.failedRowTarget);
    }
    // v2 权威归因：provider 业务码 > attribution.reason > 上报方粗分类。
    // plan_expired（1309）无自动动作，直接丢弃上报，绝不建意图/烧卡。
    const classified = classifyTurnFailure({
      code: params.providerErrorCode ?? null,
      message: params.errorMessage,
      attributionReason: params.attributionReason ?? null,
      source: null,
    });
    if (classified === "plan_expired") {
      serviceLogger.info("resume report dropped, plan expired has no auto action", {
        taskId: params.taskId,
        code: params.providerErrorCode ?? null,
      });
      return;
    }
    const kind: ResumeIntentKind =
      classified === "context"
        ? "context"
        : ((classified as ResumeIntentKind | null) ?? params.kind);
    await this.withTaskLock(params.taskId, async () => {
      try {
        const now = Date.now();
        const nextEligibleAt =
          kind === "quota"
            ? quotaEligibleAt(params.nextResetTime ?? now, now)
            : kind === "context"
              ? now + RESUME_CONTEXT_COMPACT_DELAY_MS
              : (nextTransientEligibleAt(0, now) ?? now + QUOTA_FALLBACK_RETRY_MS);
        // incrementAttempt=false：本次上报与派发结算描述同一次失败，attempt 由结算路径统一推进。
        const intent = await this.deps.resumeIntentRepo.upsertPending(
          {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            kind,
            nextEligibleAt,
            lastError: params.errorMessage,
          },
          { now, incrementAttempt: false },
        );
        serviceLogger.info("resume intent recorded", {
          taskId: params.taskId,
          kind,
          attempt: intent.attempt,
          nextEligibleAt,
        });
        this.ensureLoop();
      } catch (error) {
        serviceLogger.warn("resume intent record failed", {
          taskId: params.taskId,
          error: toErrorMessage(error),
        });
      }
    });
  }

  async cancelAutoResume(params: { taskId: string; reason: string }): Promise<void> {
    this.failedRowTargets.delete(params.taskId);
    try {
      const cancelled = await this.deps.resumeIntentRepo.cancel(params.taskId, params.reason);
      if (cancelled) {
        serviceLogger.info("resume intent cancelled", params);
      }
    } catch (error) {
      serviceLogger.warn("resume intent cancel failed", {
        ...params,
        error: toErrorMessage(error),
      });
    }
  }

  async getAutoResumeIntent(taskId: string): Promise<ResumeIntent | null> {
    try {
      return await this.deps.resumeIntentRepo.getEffectiveByTask(taskId);
    } catch (error) {
      serviceLogger.warn("resume intent read failed", {
        taskId,
        error: toErrorMessage(error),
      });
      return null;
    }
  }

  async getQuotaWatchdogStatus(): Promise<QuotaWatchdogStatus | null> {
    return {
      state: this.status.state,
      remainingPercent: this.status.lastGoodRemainingPercent,
      nextResetTime: this.status.lastGoodNextResetTime,
      wakeAt: this.status.wakeAt,
      exhaustionCycleId: this.status.exhaustionCycleId,
      updatedAt: Date.now(),
    };
  }

  // ---- 循环 ----

  private async readSettings(): Promise<QuotaWatchdogSettings> {
    try {
      const raw = await this.deps.settingService.get();
      return normalizeQuotaWatchdogSettings({
        autoResumeEnabled: raw.autoResumeEnabled,
        autoClaimResetCardsEnabled: raw.autoClaimResetCardsEnabled,
        quotaWatchThresholdPercent: raw.quotaWatchThresholdPercent,
        autoResumeMaxConsecutive: raw.autoResumeMaxConsecutive,
      });
    } catch (error) {
      serviceLogger.warn("watchdog settings read failed, using defaults", {
        error: toErrorMessage(error),
      });
      return QUOTA_WATCHDOG_DEFAULT_SETTINGS;
    }
  }

  private ensureLoop(): void {
    if (this.disposed || this.timer || this.ticking) {
      return;
    }
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.tick();
      },
      Math.max(delayMs, 0),
    );
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.disposed) {
      return;
    }
    this.ticking = true;
    try {
      await this.runTick();
    } catch (error) {
      serviceLogger.warn("watchdog tick failed", { error: toErrorMessage(error) });
    } finally {
      this.ticking = false;
      this.scheduleNextTick();
    }
  }

  private async runTick(): Promise<void> {
    const now = Date.now();
    const settings = await this.readSettings();
    const pendingIntents = await this.deps.resumeIntentRepo.listPending();

    if (!settings.autoResumeEnabled && pendingIntents.length > 0) {
      // 设置关闭：批转取消（一次即可；cancelled 行不再进入 pending 列表）。
      for (const intent of pendingIntents) {
        await this.deps.resumeIntentRepo.cancel(intent.taskId, "settings_disabled", { now });
      }
      serviceLogger.info("resume intents cancelled by settings", { count: pendingIntents.length });
    }

    const intentsActive = settings.autoResumeEnabled && pendingIntents.length > 0;
    const statusActive = this.status.state !== "idle";
    if (!intentsActive && !statusActive) {
      // 被动：>阈值且无意图时不保留任何周期定时器（spec §3.1）。
      this.persistCheckpointQuietly(now);
      return;
    }

    // ---- 观测（live 快照；抛错保留 last-good）----
    let observation = {
      remainingPercent: null as number | null,
      nextResetTime: null as number | null,
      hasClaimableCard: this.lastClaimableCard,
    };
    let resetSnapshot: CodingPlanResetStatusSnapshot | null = null;
    let scope: CodingPlanResetScopeRequest | null = null;
    try {
      const snapshot = await this.deps.usageStatsService.getEntitlementSnapshot();
      // v2 口径修正：快照 percentage 是"已用占比"，状态机/节奏全部消费"剩余占比"。
      // v1 未反转 → watching 进入线（≤10%）永不成立 → watchdog 永远 idle、reset 卡从未自动核销。
      observation.remainingPercent = remainingPercentFromEntitlement(
        snapshot.remaining?.percentage,
      );
      observation.nextResetTime = snapshot.remaining?.nextResetTime ?? null;
      scope = await this.deps.resolveResetScope();
      if (scope) {
        try {
          resetSnapshot = await this.deps.usageStatsService.getCodingPlanResetStatus(scope);
          observation.hasClaimableCard = resolveClaimTarget(resetSnapshot, now) !== null;
          this.lastClaimableCard = observation.hasClaimableCard;
        } catch (error) {
          serviceLogger.warn("reset status fetch failed, reuse last card fact", {
            error: toErrorMessage(error),
          });
        }
      } else {
        observation.hasClaimableCard = false;
        this.lastClaimableCard = false;
      }
    } catch (error) {
      serviceLogger.warn("entitlement snapshot failed, keep last-good", {
        error: toErrorMessage(error),
        state: this.status.state,
      });
      const applied = transitionOnObservationError(this.status);
      this.status = applied.status;
      return; // 无新观测：按原节奏继续（scheduleNextTick 按当前状态计算）。
    }

    // ---- 状态机迁移 ----
    let cycleCounter = 0;
    const transition = transitionWatchdogState(this.status, observation, settings, now, () => {
      cycleCounter += 1;
      return `cycle-${now}-${cycleCounter}`;
    });
    const quotaRestored = transition.quotaRestored;
    this.status = transition.status;
    if (quotaRestored) {
      serviceLogger.info("quota restored", {
        exhaustionCycleId: this.status.exhaustionCycleId,
        remainingPercent: observation.remainingPercent,
      });
      // restored 是瞬时态：发事件后立即折叠回 idle（spec §3.1）。
      this.status = { ...this.status, state: "idle" };
    }
    this.persistCheckpointQuietly(now);

    // ---- 自动核销（仅 claiming；/opportunity 与 /use 互斥见 spec §3.2）----
    if (
      resetSnapshot &&
      scope &&
      settings.autoClaimResetCardsEnabled &&
      this.status.state === "claiming" &&
      !this.claimBookkeeping.useInFlight
    ) {
      await this.claim.claimResets(resetSnapshot, scope);
    } else if (
      resetSnapshot &&
      scope &&
      settings.autoClaimResetCardsEnabled &&
      !this.claimBookkeeping.useInFlight &&
      shouldAttemptOpportunityCall(
        this.status.state,
        this.claimBookkeeping.opportunityCooldownUntil,
        now,
      )
    ) {
      // 主动状态无卡：补位触发服务端资格判断（renderer hidden 时无人触发，spec §3.2）。
      await this.claim.requestOpportunity(scope);
    }

    // ---- 派发到期意图 ----
    if (settings.autoResumeEnabled) {
      const claimed = await this.deps.resumeIntentRepo.claimDue(Date.now());
      for (const intent of claimed) {
        // v2 派发门（quotaResumeGate）：核销前置 + 不盲放行，见 spec §9.3。
        const admitted = await this.gate.admitClaimedIntent(intent, settings, scope);
        if (admitted) {
          void this.dispatchIntent(intent, settings);
        }
      }
    }
  }

  private dispatchIntent(intent: ResumeIntent, settings: QuotaWatchdogSettings): void {
    void (async () => {
      const now = Date.now();
      try {
        if (intent.attempt >= settings.autoResumeMaxConsecutive) {
          await this.deps.resumeIntentRepo.markExhausted(
            intent.resumeIntentId,
            `attempt limit ${settings.autoResumeMaxConsecutive}`,
            { now },
          );
          serviceLogger.info("resume intent exhausted", {
            taskId: intent.taskId,
            attempt: intent.attempt,
          });
          return;
        }
        if (
          await this.deps.dispatch.isTaskActive({
            taskId: intent.taskId,
            workspacePath: intent.workspacePath,
            workspaceIdentity: intent.workspaceIdentity,
          })
        ) {
          // 自发 compact 窗口内的活动是看门狗自己的 /compact 维护 turn：守卫重排，不取消意图。
          if (now < (this.selfCompactUntil.get(intent.taskId) ?? 0)) {
            await this.deps.resumeIntentRepo.reschedulePending(
              intent.resumeIntentId,
              now + RESUME_CONTEXT_COMPACT_DELAY_MS,
              { now },
            );
            this.scheduleNextTick();
            return;
          }
          // 用户已自行活动（新消息/手动重试在跑）：取消自动意图，admission 先到者胜。
          await this.deps.resumeIntentRepo.cancel(intent.taskId, "user_activity_active", { now });
          serviceLogger.info("resume intent cancelled, user activity", {
            taskId: intent.taskId,
          });
          return;
        }
        const rowTarget = this.failedRowTargets.get(intent.taskId) ?? null;
        const dispatchInput = {
          sessionId: intent.taskId,
          workspacePath: intent.workspacePath,
          workspaceIdentity: intent.workspaceIdentity,
          resumeIntentId: intent.resumeIntentId,
        };
        let dispatched = false;
        if (rowTarget) {
          try {
            await this.deps.dispatch.retryTurn({ ...dispatchInput, rowTarget });
            dispatched = true;
          } catch (error) {
            serviceLogger.warn("retryTurn dispatch failed, falling back to sendText", {
              taskId: intent.taskId,
              error: toErrorMessage(error),
            });
          }
        }
        if (!dispatched) {
          await this.deps.dispatch.sendResumeText(dispatchInput);
        }
        serviceLogger.info("auto-resume dispatched", {
          taskId: intent.taskId,
          attempt: intent.attempt + 1,
          kind: intent.kind,
          via: rowTarget ? "retryTurn" : "sendText",
        });
        const outcomePromise = this.deps.dispatch.awaitTurnOutcome({
          sessionId: intent.taskId,
          workspacePath: intent.workspacePath,
          workspaceIdentity: intent.workspaceIdentity,
          timeoutMs: TURN_OUTCOME_TIMEOUT_MS,
        });
        const tracked = outcomePromise
          .then(async (outcome) => {
            if (outcome.outcome === "completed") {
              await this.deps.resumeIntentRepo.deleteOnSuccess(intent.resumeIntentId);
              this.failedRowTargets.delete(intent.taskId);
              this.contextCompactArmed.delete(intent.taskId);
              this.selfCompactUntil.delete(intent.taskId);
              serviceLogger.info("auto-resume turn completed", { taskId: intent.taskId });
              return;
            }
            // 超时收口前核实任务是否仍在跑（长任务合法超 1h）：在跑则意图转取消（工作继续，
            // 无需自动动作），不按失败回队——v1 这里会把仍运行的任务重复派发。
            if (
              outcome.errorMessage === "dispatch outcome timeout" &&
              (await this.deps.dispatch.isTaskActive({
                taskId: intent.taskId,
                workspacePath: intent.workspacePath,
                workspaceIdentity: intent.workspaceIdentity,
              }))
            ) {
              await this.deps.resumeIntentRepo.cancel(intent.taskId, "task_still_running", {
                now: Date.now(),
              });
              this.failedRowTargets.delete(intent.taskId);
              serviceLogger.info("resume intent cancelled, task still running", {
                taskId: intent.taskId,
              });
              return;
            }
            await this.settleDispatchFailure(intent, outcome);
          })
          .catch(async (error: unknown) => {
            await this.settleDispatchFailure(intent, { errorMessage: toErrorMessage(error) });
          })
          .finally(() => {
            this.pendingOutcomes.delete(intent.taskId);
            this.ensureLoop();
          });
        this.pendingOutcomes.set(intent.taskId, tracked);
      } catch (error) {
        serviceLogger.warn("auto-resume dispatch failed", {
          taskId: intent.taskId,
          error: toErrorMessage(error),
        });
        await this.settleDispatchFailure(intent, { errorMessage: toErrorMessage(error) });
      }
    })();
  }

  /**
   * v2 结算：按派发 turn 的失败事实（code/attribution.reason）权威归类，替代 v1 仅按意图 kind。
   * - plan_expired：终态 exhausted（无自动动作，绝不烧卡）。
   * - context：未武装过 → 立即重排（派发门会先发 /compact）；已武装 → exhausted（压缩救不了）。
   * - transient：1/5/15min 退避阶梯（1305 类限流按用户实测 ~1min 可续）。
   * - quota：等重置或核销卡（派发门把关）；快照可读时按精确 nextReset 唤醒，替代固定 10min 兜底。
   */
  private async settleDispatchFailure(
    intent: ResumeIntent,
    failure: Omit<TurnOutcomeWaitResult, "outcome">,
  ): Promise<void> {
    await this.withTaskLock(intent.taskId, async () => {
      try {
        const settings = await this.readSettings();
        const nextAttempt = intent.attempt + 1;
        const message = failure.errorMessage ?? "turn failed";
        const classified = classifyTurnFailure({
          code: failure.errorCode ?? null,
          message,
          attributionReason: failure.attributionReason ?? null,
          source: null,
        });
        if (classified === "plan_expired") {
          await this.deps.resumeIntentRepo.markExhausted(
            intent.resumeIntentId,
            `${message} (plan expired; auto-resume stopped)`,
          );
          this.contextCompactArmed.delete(intent.taskId);
          this.selfCompactUntil.delete(intent.taskId);
          return;
        }
        if (classified === "context") {
          if (this.contextCompactArmed.has(intent.taskId)) {
            await this.deps.resumeIntentRepo.markExhausted(
              intent.resumeIntentId,
              `${message} (context overflow persists after auto-compact)`,
            );
          } else {
            await this.deps.resumeIntentRepo.requeueAfterFailure(intent.resumeIntentId, {
              kind: "context",
              nextEligibleAt: Date.now() + RESUME_CONTEXT_COMPACT_DELAY_MS,
              lastError: message,
            });
          }
          return;
        }
        if (classified === "transient" || (classified === null && intent.kind === "transient")) {
          const nextEligibleAt = nextTransientEligibleAt(nextAttempt, Date.now());
          if (nextEligibleAt === null || nextAttempt >= settings.autoResumeMaxConsecutive) {
            await this.deps.resumeIntentRepo.markExhausted(intent.resumeIntentId, message);
            return;
          }
          await this.deps.resumeIntentRepo.requeueAfterFailure(intent.resumeIntentId, {
            kind: "transient",
            nextEligibleAt,
            lastError: message,
          });
          return;
        }
        // quota（或无法归因的既有 quota 意图）：等重置/核销卡，派发门把关；可读快照时精确唤醒。
        if (nextAttempt >= settings.autoResumeMaxConsecutive) {
          await this.deps.resumeIntentRepo.markExhausted(intent.resumeIntentId, message);
          return;
        }
        let base = Date.now() + QUOTA_FALLBACK_RETRY_MS;
        try {
          const fresh = await this.deps.usageStatsService.getEntitlementSnapshot();
          base = fresh.remaining?.nextResetTime ?? base;
        } catch {
          // 快照不可用时退避兜底。
        }
        await this.deps.resumeIntentRepo.requeueAfterFailure(intent.resumeIntentId, {
          kind: "quota",
          nextEligibleAt: quotaEligibleAt(base, Date.now()),
          lastError: message,
        });
      } catch (error) {
        serviceLogger.warn("resume failure settle failed", {
          taskId: intent.taskId,
          error: toErrorMessage(error),
        });
      }
    });
  }

  private scheduleNextTick(): void {
    const now = Date.now();
    const delays: number[] = [];
    const cadence = watchdogPollDelayMs(this.status.state, this.status.lastGoodRemainingPercent);
    if (cadence !== null) delays.push(cadence);
    const wake = computeWakeDelayMs(this.status.wakeAt, now);
    if (wake !== null) delays.push(wake);
    // 主动状态下的机会冷却到期也要醒来。
    if (this.status.state !== "idle" && this.claimBookkeeping.opportunityCooldownUntil > now) {
      delays.push(this.claimBookkeeping.opportunityCooldownUntil - now);
    }
    if (this.pendingOutcomes.size === 0) {
      void (async () => {
        try {
          const pending = await this.deps.resumeIntentRepo.listPending();
          const nextEligible = pending[0]?.nextEligibleAt;
          if (nextEligible !== undefined) delays.push(Math.max(nextEligible - now, 0));
        } catch {
          // 查询失败时按当前节奏继续。
        }
        this.applyNextDelay(delays);
      })();
      return;
    }
    this.applyNextDelay(delays);
  }

  private applyNextDelay(delays: number[]): void {
    if (this.disposed) return;
    if (delays.length === 0) {
      // 无事可看：停止定时器（下次 report/init 会 ensureLoop）。
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return;
    }
    const next = Math.min(...delays.filter((d) => Number.isFinite(d) && d >= 0));
    this.scheduleNext(Number.isFinite(next) ? next : 60_000);
  }

  private persistCheckpointQuietly(now: number): void {
    void this.deps.resumeIntentRepo
      .setCheckpoint(
        CHECKPOINT_KEY,
        JSON.stringify({ status: this.status } satisfies WatchdogCheckpointPayload),
        { now },
      )
      .catch((error: unknown) => {
        serviceLogger.warn("watchdog checkpoint write failed", {
          error: toErrorMessage(error),
        });
      });
  }
}
