import {
  normalizeQuotaWatchdogSettings,
  QUOTA_WATCHDOG_DEFAULT_SETTINGS,
  type CodingPlanResetScopeRequest,
  type QuotaWatchdogSettings,
  type QuotaWatchdogStatus,
  type ResumeIntent,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { ResumeIntentRepo } from "#src/session/resumeIntentRepo.js";
import type { ISettingService } from "#src/setting/setting.js";
import type { AutoResumeFailureReport, IUsageStatsService } from "./usageStats.js";
import {
  computeWakeDelayMs,
  createInitialWatchdogStatus,
  observeQuotaUsage,
  RESUME_AFTER_CLAIM_DELAY_MS,
  RESUME_ACTIVE_DEFER_MS,
  RESUME_CLAIM_COOLDOWN_MS,
  resolveClaimTarget,
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
  mayClaimCard,
  unknownQuotaObservation,
  type QuotaObservation,
  type QuotaResumeGate,
} from "./quotaResumeGate.js";
import {
  createResumeTaskBookkeeping,
  QuotaResumeTracker,
  type QuotaResumeDispatchPort,
  type ResumeTaskBookkeeping,
  type SessionFailureInput,
  type SessionFailureVia,
} from "./quotaResumeTracker.js";

export type {
  QuotaResumeDispatchPort,
  QuotaResumeTarget,
  SessionFailureInput,
  SessionFailureVia,
  TurnOutcomeWait,
  TurnOutcomeWaitResult,
} from "./quotaResumeTracker.js";

// 配额守护（docs/quota-watchdog/spec.md）：
// Host 进程内唯一运行态所有者。renderer 只读展示（横幅/设置），不保存任何已接纳状态。
// - 看门狗状态机：idle/watching/claiming/waiting_reset/restored，节奏见 quotaWatchdogDomain。
// - 自动核销：只走既有 /use（幂等 key + reset_type），/opportunity 资格判断在主动状态或有任务
//   等额度时按冷却触发（补位 renderer hidden 轮询真空），对账期间绝不调用 /opportunity。
// - 自动续跑：每任务的失败结算与派发在 QuotaResumeTracker；意图持久化于 resume_intents。
// v3 修订：额度观测带 scope（与 renderer 同口径）；派发门不把"额度不可知"当成"已耗尽"。

/** tick 间隔下限：防止"到期却派不出去"的意图把循环打成忙等。 */
const MIN_TICK_DELAY_MS = 1_000;
/**
 * tick 间隔上限：系统休眠期间 Node 定时器不走（monotonic clock），长定时器会在唤醒后迟到；
 * 到点重算一次很便宜（listPending + 比较），却能把迟到压在上限以内。
 */
const MAX_TICK_DELAY_MS = 5 * 60_000;
/** checkpoint 单行 key（quota_watchdog_checkpoint 表）。 */
const CHECKPOINT_KEY = "watchdog";

interface WatchdogCheckpointPayload {
  status: WatchdogRuntimeStatus;
}

const serviceLogger = createServiceLogger("quota-watchdog");

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface QuotaWatchdogServiceDeps {
  usageStatsService: IUsageStatsService;
  resumeIntentRepo: ResumeIntentRepo;
  settingService: ISettingService;
  dispatch: QuotaResumeDispatchPort;
  /** 解析当前 Coding Plan reset scope（preferredProviderId + accountAccess）；无连接时 null。 */
  resolveResetScope: () => Promise<CodingPlanResetScopeRequest | null>;
  now?: () => number;
  /** 无归因结局等待 detector 权威归因的宽限（测试注入）。 */
  outcomeAttributionGraceMs?: number;
}

export class QuotaWatchdogService {
  private status: WatchdogRuntimeStatus = createInitialWatchdogStatus();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private disposed = false;
  private scheduleGeneration = 0;
  private readonly now: () => number;
  /** /opportunity 与 /use 簿记（唯一实例由本 service 持有；逻辑在 quotaResumeClaim）。 */
  private readonly claimBookkeeping = createEmptyClaimBookkeeping();
  private readonly claim: QuotaResumeClaim;
  /** 每任务续跑簿记（tracker 与派发门共享）。 */
  private readonly bookkeeping: ResumeTaskBookkeeping = createResumeTaskBookkeeping();
  private readonly gate: QuotaResumeGate;
  private readonly tracker: QuotaResumeTracker;
  /** 最近一次核销成功的时刻（宿主全局，0 = 无）。 */
  private lastClaimAt = 0;
  /** 上次观测到的可认领卡事实；status 拉取失败时复用，避免误判落到 waiting_reset。 */
  private lastClaimableCard = false;
  private readonly readSettings: () => Promise<QuotaWatchdogSettings>;

  constructor(private readonly deps: QuotaWatchdogServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.claim = createQuotaResumeClaim(deps.usageStatsService, this.claimBookkeeping, this.now);
    this.readSettings = async () => {
      try {
        const raw = await deps.settingService.get();
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
    };
    this.gate = createQuotaResumeGate({
      resumeIntentRepo: deps.resumeIntentRepo,
      claim: this.claim,
      dispatch: deps.dispatch,
      bookkeeping: this.bookkeeping,
      getLastClaimAt: () => this.lastClaimAt,
      observe: () => this.observeQuota(),
      onCardClaimed: async (now) => {
        this.lastClaimAt = now;
        await deps.resumeIntentRepo.bringPendingForward("quota", now + RESUME_AFTER_CLAIM_DELAY_MS);
        this.scheduleNextTick();
      },
      scheduleNextTick: () => this.scheduleNextTick(),
      now: this.now,
    });
    this.tracker = new QuotaResumeTracker({
      resumeIntentRepo: deps.resumeIntentRepo,
      dispatch: deps.dispatch,
      gate: this.gate,
      bookkeeping: this.bookkeeping,
      readSettings: this.readSettings,
      onActivity: () => this.ensureLoop(),
      now: this.now,
      outcomeAttributionGraceMs: deps.outcomeAttributionGraceMs,
    });
  }

  /** Host 启动恢复：回收上一进程的全部 dispatched 行 + 重挂 checkpoint，再启动循环。 */
  async init(): Promise<void> {
    try {
      // 进程刚启动，不可能有上一实例的在途派发还活着：回收全部 dispatched 行
      //（v2 只回收 15 分钟前的行，崩溃前 15 分钟内派发的意图因此永远卡在 dispatched）。
      await this.deps.resumeIntentRepo.recoverStaleDispatched(this.now(), { olderThanMs: 0 });
    } catch (error) {
      serviceLogger.warn("watchdog init stale recovery failed", { error: toErrorMessage(error) });
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
    this.tracker.dispose();
  }

  // ---- 对宿主 / renderer 暴露的契约（IUsageStatsService 可选方法委托） ----

  /**
   * 宿主 detector 入口：task index 同步器观察到 running→error 的真实迁移时调用。
   * 失败事实的接纳/去重/调度全部在宿主（QuotaResumeTracker.handleSessionFailure）。
   */
  handleSessionFailure(
    input: SessionFailureInput & { via: SessionFailureVia; errorAt?: number | null },
  ): Promise<void> {
    return this.tracker.handleSessionFailure(input);
  }

  /** renderer 可选契约：可见会话的冗余失败通道，语义并入 handleSessionFailure（via=report）。 */
  reportAutoResumeFailure(params: AutoResumeFailureReport): Promise<void> {
    return this.tracker.handleSessionFailure({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      code: params.code ?? null,
      providerErrorCode: params.providerErrorCode ?? null,
      message: params.errorMessage,
      attributionReason: params.attributionReason ?? null,
      source: params.source ?? null,
      errorAt: params.errorAt,
      via: "report",
    });
  }

  /** 用户干预取消（新消息/编辑/删除）：pending/dispatched 均取消，并清空该 task 的全部簿记。 */
  cancelAutoResume(params: { taskId: string; reason: string }): Promise<void> {
    return this.tracker.cancel(params.taskId, params.reason);
  }

  async getAutoResumeIntent(taskId: string): Promise<ResumeIntent | null> {
    try {
      return await this.deps.resumeIntentRepo.getEffectiveByTask(taskId);
    } catch (error) {
      serviceLogger.warn("resume intent read failed", { taskId, error: toErrorMessage(error) });
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
      updatedAt: this.now(),
    };
  }

  /**
   * 立即执行一轮观测/核销/派发（唤醒、网络恢复、设置变更等外部事件时调用）；
   * 正在执行时直接返回，由那一轮的收尾负责重排。
   */
  async wake(): Promise<void> {
    await this.tick();
  }

  // ---- 观测与状态机 ----

  /** 一次额度观测：scope + entitlement 快照 + 重置卡状态；任一环节失败只降级对应部分，不整体放弃。 */
  private async observeQuota(): Promise<QuotaObservation> {
    const observation = unknownQuotaObservation();
    try {
      observation.scope = await this.deps.resolveResetScope();
    } catch (error) {
      serviceLogger.warn("reset scope resolve failed", { error: toErrorMessage(error) });
    }
    try {
      // v2 缺陷：不带 scope 的快照读不到 percentage，派发门因此永远判"不可知 → 守卫重排"。
      // 与 renderer 同口径：用当前选中的 Coding Plan 连接限定请求。
      observation.snapshot = await this.deps.usageStatsService.getEntitlementSnapshot(
        observation.scope ?? undefined,
      );
      observation.usage = observeQuotaUsage(observation.snapshot);
    } catch (error) {
      serviceLogger.warn("entitlement snapshot failed", { error: toErrorMessage(error) });
    }
    if (observation.scope) {
      try {
        observation.resetSnapshot = await this.deps.usageStatsService.getCodingPlanResetStatus(
          observation.scope,
        );
      } catch (error) {
        serviceLogger.warn("reset status fetch failed, reuse last card fact", {
          error: toErrorMessage(error),
        });
      }
    }
    return observation;
  }

  private applyStateTransition(
    observation: QuotaObservation,
    settings: QuotaWatchdogSettings,
    now: number,
  ): void {
    const { remainingPercent, nextResetTime } = observation.usage;
    this.lastClaimableCard = observation.resetSnapshot
      ? resolveClaimTarget(observation.resetSnapshot, now) !== null
      : this.lastClaimableCard;
    if (remainingPercent === null) {
      // 观测未知：保留 last-good 与当前节奏，不迁移状态（spec §3.1）。
      this.status = transitionOnObservationError(this.status).status;
      return;
    }
    let cycleCounter = 0;
    const transition = transitionWatchdogState(
      this.status,
      { remainingPercent, nextResetTime, hasClaimableCard: this.lastClaimableCard },
      settings,
      now,
      () => `cycle-${now}-${++cycleCounter}`,
    );
    this.status = transition.status;
    if (transition.quotaRestored) {
      serviceLogger.info("quota restored", {
        exhaustionCycleId: this.status.exhaustionCycleId,
        remainingPercent,
      });
      // restored 是瞬时态：发事件后立即折叠回 idle（spec §3.1）。
      this.status = { ...this.status, state: "idle" };
    }
    this.persistCheckpointQuietly(now);
  }

  /**
   * 自动核销（仅主动状态；/opportunity 与 /use 互斥见 spec §3.2）。
   * 核销资格见 mayClaimCard：上次核销之后没有再出现额度类失败时，不凭"快照仍耗尽"烧第二张卡。
   * 返回本轮是否核销或发卡（调用方据此刷新观测：本轮开头的快照已过期）。
   */
  private async runAutoClaim(
    observation: QuotaObservation,
    settings: QuotaWatchdogSettings,
    now: number,
    quotaIntentWaiting: boolean,
  ): Promise<boolean> {
    if (!settings.autoClaimResetCardsEnabled) return false;
    const { scope, resetSnapshot } = observation;
    if (!scope || !resetSnapshot || !this.claim.canRequest()) return false;
    if (this.status.state === "claiming") {
      const resetType = resolveClaimTarget(resetSnapshot, now);
      if (
        resetType &&
        mayClaimCard(this.lastClaimAt, this.bookkeeping.lastQuotaFailureAt, true) &&
        now - this.lastClaimAt >= RESUME_CLAIM_COOLDOWN_MS &&
        (await this.claim.claimResets(resetSnapshot, scope, resetType))
      ) {
        this.lastClaimAt = this.now();
        await this.deps.resumeIntentRepo.bringPendingForward(
          "quota",
          this.lastClaimAt + RESUME_AFTER_CLAIM_DELAY_MS,
        );
        serviceLogger.info("reset card auto-claimed", { trigger: "watchdog-claiming" });
      }
      return true;
    }
    // 有任务在等额度但无卡，或状态机主动无卡：补位触发服务端资格判断（renderer hidden 时无人触发）。
    if (!quotaIntentWaiting && this.status.state === "idle") return false;
    if (this.claimBookkeeping.opportunityCooldownUntil > now) return false;
    const granted = await this.claim.requestOpportunity(scope);
    if (granted) {
      // 发卡成功：等待额度的意图立即回到派发门（否则要等到各自的 nextResetTime 才会再看一眼）。
      await this.deps.resumeIntentRepo.bringPendingForward(
        "quota",
        this.now() + RESUME_AFTER_CLAIM_DELAY_MS,
      );
      this.scheduleNextTick();
    }
    return granted;
  }

  // ---- 循环 ----

  /** 有新意图/状态变化时重排定时器：总是按最新的到期时刻重算，不会把更早的意图挡在现有定时器之后。 */
  private ensureLoop(): void {
    if (this.disposed || this.ticking) return;
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (this.disposed) return;
    const generation = ++this.scheduleGeneration;
    void (async () => {
      const now = this.now();
      const delays: number[] = [];
      try {
        const cadence = watchdogPollDelayMs(
          this.status.state,
          this.status.lastGoodRemainingPercent,
        );
        if (cadence !== null) delays.push(cadence);
        const wake = computeWakeDelayMs(this.status.wakeAt, now);
        if (wake !== null) delays.push(wake);
        if (this.status.state !== "idle" && this.claimBookkeeping.opportunityCooldownUntil > now) {
          delays.push(this.claimBookkeeping.opportunityCooldownUntil - now);
        }
        // v2 缺陷：有在途结局等待时跳过意图到期计算，导致其它任务的意图被饿死。
        // 在途派发由各自的结局等待收口，不参与 tick 排程。
        const pending = await this.deps.resumeIntentRepo.listPending();
        const nextEligible = pending[0]?.nextEligibleAt;
        if (nextEligible !== undefined) delays.push(Math.max(nextEligible - now, 0));
      } catch {
        // 查询失败时按当前节奏继续。
      }
      if (this.disposed || generation !== this.scheduleGeneration) return; // 已被更新的一次排程取代。
      this.applyNextDelay(delays);
    })();
  }

  private applyNextDelay(delays: number[]): void {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const finite = delays.filter((d) => Number.isFinite(d) && d >= 0);
    if (finite.length === 0) return; // 无事可看：停止定时器（下次失败上报会 ensureLoop）。
    const next = Math.max(Math.min(...finite), MIN_TICK_DELAY_MS);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.tick();
      },
      Math.min(next, MAX_TICK_DELAY_MS),
    );
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
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
    const now = this.now();
    const settings = await this.readSettings();
    const repo = this.deps.resumeIntentRepo;
    const pending = await repo.listPending();
    this.tracker.pruneFailureMemory(now);

    if (!settings.autoResumeEnabled && pending.length > 0) {
      // 设置关闭：批转取消（一次即可；cancelled 行不再进入 pending 列表）。
      for (const intent of pending) {
        await repo.cancel(intent.taskId, "settings_disabled", { now });
      }
      serviceLogger.info("resume intents cancelled by settings", { count: pending.length });
    }

    let observation = await this.observeQuota();
    this.applyStateTransition(observation, settings, now);
    const quotaIntentWaiting =
      settings.autoResumeEnabled && pending.some((intent) => intent.kind === "quota");
    const cardsChanged = await this.runAutoClaim(observation, settings, now, quotaIntentWaiting);
    if (!settings.autoResumeEnabled) return;
    if (cardsChanged) {
      // 本轮刚核销或刚发卡：开头的重置卡快照已过期，重新观测后再交给派发门
      //（否则刚到手的卡要等下一轮复核才会被用上）。
      observation = await this.observeQuota();
    }

    if (
      quotaIntentWaiting &&
      observation.usage.remainingPercent !== null &&
      !observation.usage.exhausted
    ) {
      // 额度不再耗尽（提前恢复 / 核销生效 / 快照滞后纠正）：等待额度的意图立即回到派发门重新裁决，
      // 不必等到各自的 nextResetTime。
      const moved = await repo.bringPendingForward(
        "quota",
        this.now() + RESUME_AFTER_CLAIM_DELAY_MS,
      );
      if (moved > 0) {
        serviceLogger.info("quota recovered, resuming waiting intents", { count: moved });
      }
    }

    const claimed = await repo.claimDue(this.now());
    for (const intent of claimed) {
      if (this.tracker.hasInFlight(intent.taskId)) {
        // 同一 task 已有在途派发（不应出现）：放回 pending，由那次的结局收口。
        await repo.reschedulePending(intent.resumeIntentId, this.now() + RESUME_ACTIVE_DEFER_MS);
        continue;
      }
      // 派发门（quotaResumeGate）：context 先压缩、quota 核销/等重置、transient 退避，见 spec §9.3。
      const admitted = await this.gate.admitClaimedIntent(intent, settings, observation);
      if (admitted) {
        await this.tracker.dispatch(intent, settings);
      }
    }
  }

  private persistCheckpointQuietly(now: number): void {
    void this.deps.resumeIntentRepo
      .setCheckpoint(
        CHECKPOINT_KEY,
        JSON.stringify({ status: this.status } satisfies WatchdogCheckpointPayload),
        { now },
      )
      .catch((error: unknown) => {
        serviceLogger.warn("watchdog checkpoint write failed", { error: toErrorMessage(error) });
      });
  }
}
