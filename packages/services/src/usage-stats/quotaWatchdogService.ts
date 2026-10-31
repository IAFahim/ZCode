import { randomUUID } from "node:crypto";
import {
  RESUME_QUOTA_WAKE_MARGIN_MS,
  normalizeQuotaWatchdogSettings,
  QUOTA_WATCHDOG_DEFAULT_SETTINGS,
  type CodingPlanResetScopeRequest,
  type CodingPlanResetStatusSnapshot,
  type QuotaWatchdogSettings,
  type QuotaWatchdogStatus,
  type ResumeIntent,
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
  computeWakeDelayMs,
  createInitialWatchdogStatus,
  isOpportunityTransientError,
  isOpportunityThrottleError,
  nextOpportunityCooldownUntil,
  resolveClaimTarget,
  shouldAttemptOpportunityCall,
  transitionOnObservationError,
  transitionWatchdogState,
  watchdogPollDelayMs,
  type WatchdogRuntimeStatus,
} from "./quotaWatchdogDomain.js";

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
/** /use 后 status 对账重试阶梯（与 renderer hook USE_STATUS_RETRY_DELAYS_MS 同值）。 */
const USE_CONFIRM_RETRY_DELAYS_MS = [0, 250, 750, 1_500] as const;
/** checkpoint 单行 key（quota_watchdog_checkpoint 表）。 */
const CHECKPOINT_KEY = "watchdog";

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
  /** 等待该 session 下一个 turn 终态（task_complete / task_error）；超时按 failed 收口。 */
  awaitTurnOutcome(input: {
    sessionId: string;
    timeoutMs?: number;
  }): Promise<{ outcome: "completed" | "failed"; errorMessage?: string }>;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class QuotaWatchdogService {
  private status: WatchdogRuntimeStatus = createInitialWatchdogStatus();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private disposed = false;
  /** /opportunity 冷却与幂等 key 簿记（service 自持；renderer Coordinator 状态独立）。 */
  private opportunityCooldownUntil = 0;
  private opportunityIdempotencyKey: string | null = null;
  /** /use 对账进行中：期间绝不调用 /opportunity（发卡锁互斥，spec §3.2）。 */
  private useInFlight = false;
  private useIdempotencyKey: string | null = null;
  /** 上次观测到的可认领卡事实；status 拉取失败时复用，避免误判落到 waiting_reset。 */
  private lastClaimableCard = false;
  /** 失败上报时暂存的 failed 行目标（retryTurn 用）；成功/取消后清除。 */
  private readonly failedRowTargets = new Map<string, { rowId: number; entityId: string }>();
  /** 在途派发结局等待（taskId → promise），tick 不重复派发同一 task。 */
  private readonly pendingOutcomes = new Map<string, Promise<void>>();

  constructor(private readonly deps: QuotaWatchdogServiceDeps) {}

  /** Host 启动恢复：回收崩溃实例的 dispatched 行 + 重挂 checkpoint，再启动循环。 */
  async init(): Promise<void> {
    try {
      await this.deps.resumeIntentRepo.recoverStaleDispatched(Date.now());
      const raw = await this.deps.resumeIntentRepo.getCheckpoint(CHECKPOINT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as WatchdogCheckpointPayload;
        if (parsed?.status?.state) {
          // 重启后 restored 不能重发：quotaRestored 只由状态机迁移产生，checkpoint 仅恢复观测底座。
          this.status = { ...createInitialWatchdogStatus(), ...parsed.status, state: parsed.status.state === "restored" ? "idle" : parsed.status.state };
        }
      }
    } catch (error) {
      serviceLogger.warn("watchdog init recovery failed", { error: toErrorMessage(error) });
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
  }): Promise<void> {
    const settings = await this.readSettings();
    if (!settings.autoResumeEnabled) {
      return;
    }
    if (params.failedRowTarget) {
      this.failedRowTargets.set(params.taskId, params.failedRowTarget);
    }
    try {
      const now = Date.now();
      const nextEligibleAt =
        params.kind === "quota"
          ? quotaEligibleAt(params.nextResetTime ?? now, now)
          : (nextTransientEligibleAt(0, now) ?? now + QUOTA_FALLBACK_RETRY_MS);
      const intent = await this.deps.resumeIntentRepo.upsertPending(
        {
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          kind: params.kind,
          nextEligibleAt,
          lastError: params.errorMessage,
        },
        { now },
      );
      serviceLogger.info("resume intent recorded", {
        taskId: params.taskId,
        kind: params.kind,
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
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, Math.max(delayMs, 0));
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
      observation.remainingPercent = snapshot.remaining?.percentage ?? null;
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
      !this.useInFlight
    ) {
      await this.claimResets(resetSnapshot, scope);
    } else if (
      resetSnapshot &&
      scope &&
      settings.autoClaimResetCardsEnabled &&
      !this.useInFlight &&
      shouldAttemptOpportunityCall(this.status.state, this.opportunityCooldownUntil, now)
    ) {
      // 主动状态无卡：补位触发服务端资格判断（renderer hidden 时无人触发，spec §3.2）。
      await this.requestOpportunity(scope);
    }

    // ---- 派发到期意图 ----
    if (settings.autoResumeEnabled) {
      const claimed = await this.deps.resumeIntentRepo.claimDue(Date.now());
      for (const intent of claimed) {
        if (intent.kind === "quota") {
          // 派发门（tech-design §5）：事件与快照之间可能有新消耗/重置漂移，
          // 派发前必须用 live 快照证实额度已恢复；未恢复则守卫重排（不消耗 attempt）。
          try {
            const fresh = await this.deps.usageStatsService.getEntitlementSnapshot();
            const remaining = fresh.remaining?.percentage ?? null;
            if (remaining !== null && remaining <= 0) {
              const base = fresh.remaining?.nextResetTime ?? Date.now() + QUOTA_FALLBACK_RETRY_MS;
              await this.deps.resumeIntentRepo.reschedulePending(
                intent.resumeIntentId,
                quotaEligibleAt(base, Date.now()),
              );
              serviceLogger.info("quota intent deferred, quota not restored yet", {
                taskId: intent.taskId,
                remaining,
              });
              continue;
            }
          } catch (error) {
            // 快照失败不阻塞派发（下一轮失败结算会再兜底）。
            serviceLogger.warn("quota dispatch gate snapshot failed", {
              taskId: intent.taskId,
              error: toErrorMessage(error),
            });
          }
        }
        void this.dispatchIntent(intent, settings);
      }
    }
  }

  private async claimResets(
    resetSnapshot: CodingPlanResetStatusSnapshot,
    scope: CodingPlanResetScopeRequest,
  ): Promise<void> {
    const now = Date.now();
    const resetType = resolveClaimTarget(resetSnapshot, now);
    if (!resetType) {
      return;
    }
    // 对账后无可核销机会即放弃，不携带新幂等键重试（与 renderer 强制对账同语义）。
    let fresh: CodingPlanResetStatusSnapshot;
    try {
      fresh = await this.deps.usageStatsService.getCodingPlanResetStatus(scope);
    } catch (error) {
      serviceLogger.warn("pre-use reconciliation failed", { error: toErrorMessage(error) });
      return;
    }
    const stillClaimable = resolveClaimTarget(fresh, Date.now());
    if (stillClaimable !== resetType) {
      return;
    }
    const idempotencyKey = this.useIdempotencyKey ?? randomUUID();
    this.useIdempotencyKey = idempotencyKey;
    this.useInFlight = true;
    try {
      await this.deps.usageStatsService.useCodingPlanReset({
        ...scope,
        idempotencyKey,
        resetType,
      });
      // /use 接受后按既有对账协议确认 used_at 变化（[0,250,750,1500]ms）。
      const baseline =
        resetType === "WEEK"
          ? fresh.latestWeekResetHistory?.usedAt ?? null
          : fresh.latestFiveHourResetHistory?.usedAt ?? null;
      for (const delayMs of USE_CONFIRM_RETRY_DELAYS_MS) {
        await sleep(delayMs);
        const confirmed = await this.deps.usageStatsService.getCodingPlanResetStatus(scope);
        const usedAt =
          resetType === "WEEK"
            ? confirmed.latestWeekResetHistory?.usedAt ?? null
            : confirmed.latestFiveHourResetHistory?.usedAt ?? null;
        if (usedAt !== null && usedAt !== baseline) {
          serviceLogger.info("reset card auto-claimed", { resetType, usedAt });
          this.useIdempotencyKey = null;
          return;
        }
      }
      serviceLogger.warn("reset card claim not confirmed, will retry with same key", {
        resetType,
      });
    } catch (error) {
      // 失败保留幂等 key（同一次核销重试复用），下一 tick 再试。
      serviceLogger.warn("reset card auto-claim failed", {
        resetType,
        error: toErrorMessage(error),
      });
    } finally {
      this.useInFlight = false;
    }
  }

  private async requestOpportunity(scope: CodingPlanResetScopeRequest): Promise<void> {
    const now = Date.now();
    // 瞬时错误复用同一幂等 key；429/稳定错误换新 key（与 Coordinator 规则一致）。
    const idempotencyKey = this.opportunityIdempotencyKey ?? randomUUID();
    try {
      const result = await this.deps.usageStatsService.requestCodingPlanResetOpportunity({
        ...scope,
        idempotencyKey,
      });
      this.opportunityIdempotencyKey = null;
      this.opportunityCooldownUntil = nextOpportunityCooldownUntil(
        result.granted,
        result.nextTryAt,
        now,
      );
      serviceLogger.info("opportunity judged", {
        granted: result.granted,
        nextTryAt: result.nextTryAt,
      });
    } catch (error) {
      const transient = !isOpportunityThrottleError(error) && isOpportunityTransientError(error);
      this.opportunityIdempotencyKey = transient ? idempotencyKey : null;
      this.opportunityCooldownUntil =
        now + (transient ? 5 * 60_000 : 10 * 60_000);
      serviceLogger.warn("opportunity request failed", {
        transient,
        error: toErrorMessage(error),
      });
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
          // 用户已自行活动（新消息/手动重试在跑）：取消自动意图，admission 先到者胜。
          await this.deps.resumeIntentRepo.cancel(intent.taskId, "user_activity_active", { now });
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
          timeoutMs: TURN_OUTCOME_TIMEOUT_MS,
        });
        const tracked = outcomePromise
          .then(async (outcome) => {
            if (outcome.outcome === "completed") {
              await this.deps.resumeIntentRepo.deleteOnSuccess(intent.resumeIntentId);
              this.failedRowTargets.delete(intent.taskId);
              serviceLogger.info("auto-resume turn completed", { taskId: intent.taskId });
              return;
            }
            await this.settleDispatchFailure(intent, outcome.errorMessage ?? "turn failed");
          })
          .catch(async (error: unknown) => {
            await this.settleDispatchFailure(intent, toErrorMessage(error));
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
        await this.settleDispatchFailure(intent, toErrorMessage(error));
      }
    })();
  }

  private async settleDispatchFailure(intent: ResumeIntent, errorMessage: string): Promise<void> {
    try {
      const settings = await this.readSettings();
      const nextAttempt = intent.attempt + 1;
      if (intent.kind === "transient") {
        const nextEligibleAt = nextTransientEligibleAt(nextAttempt, Date.now());
        if (nextEligibleAt === null || nextAttempt >= settings.autoResumeMaxConsecutive) {
          await this.deps.resumeIntentRepo.markExhausted(intent.resumeIntentId, errorMessage);
          return;
        }
        await this.deps.resumeIntentRepo.requeueAfterFailure(intent.resumeIntentId, {
          kind: intent.kind,
          nextEligibleAt,
          lastError: errorMessage,
        });
        return;
      }
      // quota：重置时间未知时退避重试；触发上限同样生效。
      if (nextAttempt >= settings.autoResumeMaxConsecutive) {
        await this.deps.resumeIntentRepo.markExhausted(intent.resumeIntentId, errorMessage);
        return;
      }
      await this.deps.resumeIntentRepo.requeueAfterFailure(intent.resumeIntentId, {
        kind: "quota",
        nextEligibleAt: Date.now() + QUOTA_FALLBACK_RETRY_MS + RESUME_QUOTA_WAKE_MARGIN_MS,
        lastError: errorMessage,
      });
    } catch (error) {
      serviceLogger.warn("resume failure settle failed", {
        taskId: intent.taskId,
        error: toErrorMessage(error),
      });
    }
  }

  private scheduleNextTick(): void {
    const now = Date.now();
    const delays: number[] = [];
    const cadence = watchdogPollDelayMs(this.status.state, this.status.lastGoodRemainingPercent);
    if (cadence !== null) delays.push(cadence);
    const wake = computeWakeDelayMs(this.status.wakeAt, now);
    if (wake !== null) delays.push(wake);
    // 主动状态下的机会冷却到期也要醒来。
    if (this.status.state !== "idle" && this.opportunityCooldownUntil > now) {
      delays.push(this.opportunityCooldownUntil - now);
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
