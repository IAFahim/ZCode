import type { QuotaWatchdogSettings, ResumeIntent, ResumeIntentKind } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ResumeIntentRepo } from "#src/session/resumeIntentRepo.js";
import {
  classifyTurnFailure,
  RESUME_ACTIVE_DEFER_LIMIT_MS,
  RESUME_ACTIVE_DEFER_MS,
  RESUME_DISPATCH_RETRY_MS,
  RESUME_FAILURE_DEDUPE_WINDOW_MS,
  RESUME_MAX_DISPATCH_ERRORS,
  RESUME_REPORT_FRESH_WINDOW_MS,
  type ResumeFailureClassification,
} from "./quotaWatchdogDomain.js";
import type { QuotaResumeGate } from "./quotaResumeGate.js";
import { planDispatchedFailureSettle, resumeInitialDelayMs } from "./quotaResumeSettlement.js";

// 自动续跑的"每任务"一侧（docs/quota-watchdog/spec.md §9.3/§9.4）：失败结算与派发。
// 与 quotaWatchdogService（额度观测 / 状态机 / 自动核销 / 循环排程）分离，各自可单测；
// 两者只经 ResumeTaskBookkeeping（内存簿记）与派发门（quotaResumeGate）耦合。

/** 单次派发 turn 的结局等待上限；到期仍在跑则续等（TURN_OUTCOME_MAX_REARMS），绝不重复派发。 */
const TURN_OUTCOME_TIMEOUT_MS = 60 * 60_000;
const TURN_OUTCOME_MAX_REARMS = 8;
/** ACK 已接受但 turn 迟迟不进入 running（命令被异步拒绝 / 会话无法恢复）：按派发失败处理。 */
const TURN_START_TIMEOUT_MS = 45_000;
/**
 * 结局通道先于 detector 到达且不带归因时，留给 detector（权威归因）结算的宽限。
 * 线上顺序：task index 先发 turn 终态，随后回源快照才拿到 lastError（毫秒到秒级）。
 */
const OUTCOME_ATTRIBUTION_GRACE_MS = 10_000;
const RESUME_INPUT_ID_PREFIX = "resume";

const serviceLogger = createServiceLogger("quota-watchdog-resume");

export interface QuotaResumeTarget {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 派发 turn 结局：失败时携带归因线索（code / attribution / provider 业务码）供结算权威归类。 */
export interface TurnOutcomeWaitResult {
  outcome: "completed" | "failed";
  errorMessage?: string;
  errorCode?: string | null;
  attributionReason?: string | null;
  providerErrorCode?: string | null;
  timedOut?: boolean;
}

export interface TurnOutcomeWait {
  result: Promise<TurnOutcomeWaitResult>;
  dispose(): void;
}

/**
 * 会话活动状态。
 * - active：有在途 turn / 预热 / compact 维护工作。
 * - idle：索引观察到该会话且不在活动。
 * - unknown：索引尚未观察到该会话（workspace 未订阅等）——调用方必须区别对待：
 *   派发前按"可派发"处理（否则冷会话永远无法续跑），判定"turn 是否启动 / 是否仍在跑"时按"无法下结论"处理。
 */
export type TaskActivity = "active" | "idle" | "unknown";

export interface QuotaResumeDispatchPort {
  /** 该 session 的活动状态（读 sessions-index 最新态；sqlite 任务行不保存 running 状态）。 */
  getTaskActivity(target: QuotaResumeTarget): TaskActivity | Promise<TaskActivity>;
  /** 该 session 当前是否有 compact 维护工作在跑。 */
  isCompactWorkActive(sessionId: string): boolean;
  /** 发续跑文本（归因 resumeIntentId）；只有 accepted 会开启新一轮。 */
  sendResumeText(
    input: QuotaResumeTarget & { resumeIntentId: string; inputId: string },
  ): Promise<"accepted" | "duplicate" | "noop">;
  /** v4 compact 维护命令（idle 立即执行 / busy 进 FIFO）。 */
  requestCompact(target: QuotaResumeTarget): Promise<"accepted" | "alreadyRunning" | "rejected">;
  /** 只收 expectedInputId 那一轮的终态；必须先订阅再派发。 */
  subscribeOutcome(
    input: QuotaResumeTarget & { expectedInputId: string; timeoutMs: number },
  ): TurnOutcomeWait;
}

/** 每任务簿记（内存态；持久事实只有 resume_intents 行）。 */
export interface ResumeTaskBookkeeping {
  /** 已对 task 发起过 /compact 的 context 意图（再次溢出时重新发起，至多 RESUME_MAX_CONTEXT_COMPACTS 次）。 */
  contextCompactArmed: Set<string>;
  compactRejects: Map<string, number>;
  fastFails: Map<string, number>;
  compactAttempts: Map<string, number>;
  dispatchErrors: Map<string, number>;
  activityDeferrals: Map<string, { since: number; count: number }>;
  /** 最近一次处理过的失败签名（去重用；不随 forgetTask 清除，否则迟到的重复上报会复活意图）。 */
  lastFailure: Map<string, { signature: string; at: number }>;
  /** 最近一次额度类失败（宿主全局，核销资格判据，见 mayClaimCard）。 */
  lastQuotaFailureAt: number;
}

export function createResumeTaskBookkeeping(): ResumeTaskBookkeeping {
  return {
    contextCompactArmed: new Set(),
    compactRejects: new Map(),
    fastFails: new Map(),
    compactAttempts: new Map(),
    dispatchErrors: new Map(),
    activityDeferrals: new Map(),
    lastFailure: new Map(),
    lastQuotaFailureAt: 0,
  };
}

/** 一次会话失败事实（任意来源）。 */
export interface SessionFailureInput extends QuotaResumeTarget {
  code?: string | null;
  providerErrorCode?: string | null;
  message?: string | null;
  attributionReason?: string | null;
  source?: string | null;
}

export type SessionFailureVia = "detector" | "outcome" | "report";

interface InFlightDispatch {
  intent: ResumeIntent;
  inputId: string;
  dispatchedAt: number;
  wait: TurnOutcomeWait;
  startTimer: NodeJS.Timeout | null;
  /** 无归因结局的宽限定时器（等 detector 的权威归因；见 deferUnattributedOutcome）。 */
  attributionTimer: NodeJS.Timeout | null;
  rearms: number;
  settled: boolean;
}

export interface QuotaResumeTrackerDeps {
  resumeIntentRepo: ResumeIntentRepo;
  dispatch: QuotaResumeDispatchPort;
  gate: QuotaResumeGate;
  bookkeeping: ResumeTaskBookkeeping;
  readSettings: () => Promise<QuotaWatchdogSettings>;
  /** 有新意图/状态变化时唤起属主的循环。 */
  onActivity: () => void;
  now: () => number;
  /** 无归因结局等待 detector 的宽限（测试注入；缺省 OUTCOME_ATTRIBUTION_GRACE_MS）。 */
  outcomeAttributionGraceMs?: number;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 终态是否属于本次派发的那一轮。结局通道只收 expectedInputId 那一轮：
 * 用户手动输入等其它 input 的终态一律忽略；旧 Agent / 无订阅路径下终态不带 inputId，
 * 无法区分时按"属于本轮"处理（派发前已确认会话不在活动，此后第一个终态就是本轮）。
 */
export function isOutcomeForInput(
  terminalInputId: string | undefined,
  expectedInputId: string,
): boolean {
  return terminalInputId === undefined || terminalInputId === expectedInputId;
}

/** 结局/失败事实是否带任何可用于权威归类的线索（code / provider 业务码 / attribution.reason）。 */
function hasFailureAttribution(input: {
  errorCode?: string | null;
  providerErrorCode?: string | null;
  attributionReason?: string | null;
}): boolean {
  return Boolean(
    input.errorCode?.trim() || input.providerErrorCode?.trim() || input.attributionReason?.trim(),
  );
}

function failureSignature(input: SessionFailureInput): string {
  return [input.code, input.providerErrorCode, input.attributionReason]
    .map((part) => part?.trim() ?? "")
    .join("|");
}

export class QuotaResumeTracker {
  private disposed = false;
  /** 在途派发（taskId → 记录）；同一 task 同时至多一个。 */
  private readonly inFlight = new Map<string, InFlightDispatch>();
  /** 同 task 失败处理串行化（detector / 结局 / 上报并发到达时消除竞态与双计）。 */
  private readonly taskLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: QuotaResumeTrackerDeps) {}

  hasInFlight(taskId: string): boolean {
    return this.inFlight.has(taskId);
  }

  dispose(): void {
    this.disposed = true;
    for (const record of this.inFlight.values()) this.releaseDispatch(record);
    this.inFlight.clear();
  }

  /** 丢弃过期的失败签名（> RESUME_REPORT_FRESH_WINDOW_MS 的重复上报不再可能出现）。 */
  pruneFailureMemory(now: number): void {
    const { lastFailure } = this.deps.bookkeeping;
    for (const [taskId, last] of lastFailure) {
      if (now - last.at > RESUME_REPORT_FRESH_WINDOW_MS) lastFailure.delete(taskId);
    }
  }

  /**
   * 处理一次会话失败（宿主 detector / 派发结局 / renderer 上报共用的唯一结算路径）。
   * 幂等：同 task 同签名的失败在短窗口内只结算一次。
   * - 有在途派发记录 → 这是看门狗自己续跑 turn 的结局，按结算规则回队/收口。
   * - 无在途派发、有 pending 意图 → 用新事实刷新既有意图（类别变化才改写，且只提前不推迟）。
   * - 无活跃意图 → 归类后建意图；无法归因 / 自动重试无意义的失败不建意图。
   */
  async handleSessionFailure(
    input: SessionFailureInput & {
      via: SessionFailureVia;
      /** renderer 上报必带：失败发生时刻，用于丢弃重新挂载后的陈旧重放。 */
      errorAt?: number | null;
      /** 结局通道专用：该失败所属的在途派发记录。 */
      record?: InFlightDispatch;
    },
  ): Promise<void> {
    if (this.disposed) return;
    const taskId = input.taskId;
    try {
      if (input.via === "report") {
        // v2 缺陷：SessionPane 每次重新挂载都会把旧错误再报一次，已取消/已耗尽的意图被复活。
        if (typeof input.errorAt !== "number" || !Number.isFinite(input.errorAt)) return;
        if (this.deps.now() - input.errorAt > RESUME_REPORT_FRESH_WINDOW_MS) return;
      }
      const settings = await this.deps.readSettings();
      if (!settings.autoResumeEnabled) return;
      const signature = failureSignature(input);
      await this.withTaskLock(taskId, async () => {
        // 去重必须与结算同处一把 task 锁内：v3 初版在锁外"先占签名再排队"，detector 与结局通道
        // 同时到达时，携带在途记录的结局通道会被先到的 detector 上报挤成重复而提前返回并释放记录，
        // detector 随后拿不到记录、只能按"无在途记录的 dispatched 行"收敛——attempt 永不推进，
        // 连续上限形同虚设。
        const now = this.deps.now();
        const last = this.deps.bookkeeping.lastFailure.get(taskId);
        if (
          last &&
          last.signature === signature &&
          now - last.at < RESUME_FAILURE_DEDUPE_WINDOW_MS
        ) {
          // 同一次失败已由另一条通道结算：本通道携带的在途记录（若尚未释放）就此收口。
          if (input.record && !input.record.settled) this.releaseDispatch(input.record);
          return;
        }
        const record =
          input.record ?? (input.via === "outcome" ? null : (this.inFlight.get(taskId) ?? null));
        await this.processFailure(input, settings, record, now);
        this.deps.bookkeeping.lastFailure.set(taskId, { signature, at: now });
      });
    } catch (error) {
      this.deps.bookkeeping.lastFailure.delete(taskId);
      serviceLogger.warn("session failure handling failed", {
        taskId,
        via: input.via,
        error: toErrorMessage(error),
      });
    } finally {
      // 结局通道在结算期间始终持有在途记录（并发到达的 detector 上报因此排在本轮结算之后，
      // 并据 record.settled 放弃重复结算）；无论走哪条出口（含去重提前返回）都在这里释放。
      if (input.record && !input.record.settled) this.releaseDispatch(input.record);
      this.deps.onActivity();
    }
  }

  /** 用户干预取消（新消息/编辑/删除/设置关闭）：pending/dispatched 均取消，并清空该 task 的簿记。 */
  async cancel(taskId: string, reason: string): Promise<void> {
    try {
      if (await this.deps.resumeIntentRepo.cancel(taskId, reason)) {
        serviceLogger.info("resume intent cancelled", { taskId, reason });
      }
    } catch (error) {
      serviceLogger.warn("resume intent cancel failed", { taskId, error: toErrorMessage(error) });
    }
    const record = this.inFlight.get(taskId);
    if (record) this.releaseDispatch(record);
    this.forgetTask(taskId);
  }

  // ---- 结算 ----

  /** 同 task 串行执行：并发结算是 v1/v2 UNIQUE 冲突与计数漂移的根因。 */
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

  private async processFailure(
    input: SessionFailureInput,
    settings: QuotaWatchdogSettings,
    record: InFlightDispatch | null,
    now: number,
  ): Promise<void> {
    const taskId = input.taskId;
    const repo = this.deps.resumeIntentRepo;
    // 结局通道与 detector 描述同一次失败：先到者结算并标记，后到者直接放弃。
    if (record?.settled) {
      return;
    }
    const failure = {
      code: input.code ?? null,
      providerErrorCode: input.providerErrorCode ?? null,
      message: input.message ?? null,
      attributionReason: input.attributionReason ?? null,
      source: input.source ?? null,
    };
    const classified = classifyTurnFailure(failure);
    const message = failure.message?.trim() || "turn failed";
    const active = await repo.getActiveByTask(taskId);

    if (classified === "plan_expired" || classified === "non_recoverable") {
      // 自动重试无意义：既有意图终态化，绝不建意图/烧卡。
      if (record) this.releaseDispatch(record);
      if (active) {
        await repo.markExhausted(
          active.resumeIntentId,
          `${message} (${classified}; auto-resume stopped)`,
          { now },
        );
      }
      this.forgetTask(taskId);
      serviceLogger.info("auto-resume stopped, failure is not recoverable", {
        taskId,
        classification: classified,
        code: failure.code,
        providerErrorCode: failure.providerErrorCode,
      });
      return;
    }
    if (record) {
      await this.settleDispatchedFailure(
        failure,
        classified,
        message,
        active,
        record,
        settings,
        now,
      );
      return;
    }
    if (active?.status === "dispatched") {
      // 没有在途记录的 dispatched 行（上一进程残留）：收敛回 pending，不消耗 attempt。
      const kind = classified ?? active.kind;
      await repo.upsertPending(
        {
          taskId,
          workspacePath: active.workspacePath,
          workspaceIdentity: active.workspaceIdentity,
          kind,
          nextEligibleAt: now + resumeInitialDelayMs(kind, active.attempt),
          lastError: message,
        },
        { now, attemptMode: "keep" },
      );
      return;
    }
    // 不是看门狗派发的失败且无法归因：不建意图，也不动既有意图。
    if (classified === null) return;
    if (active) {
      await this.refreshPendingIntent(active, failure, classified, message, settings, now);
      return;
    }
    await this.createIntent(input, classified, message, settings, now);
  }

  /** 看门狗自己派发的续跑 turn 失败：按 planDispatchedFailureSettle 的裁决回队或收口。 */
  private async settleDispatchedFailure(
    failure: { providerErrorCode: string | null },
    classified: ResumeFailureClassification | null,
    message: string,
    active: ResumeIntent | null,
    record: InFlightDispatch,
    settings: QuotaWatchdogSettings,
    now: number,
  ): Promise<void> {
    const taskId = record.intent.taskId;
    const repo = this.deps.resumeIntentRepo;
    const bookkeeping = this.deps.bookkeeping;
    const intentId = record.intent.resumeIntentId;
    if (classified === "quota") bookkeeping.lastQuotaFailureAt = now;
    // 行已被取消/删除（用户接管）：只释放在途记录。
    if (!active || active.resumeIntentId !== intentId || active.status !== "dispatched") {
      this.releaseDispatch(record);
      return;
    }
    const plan = planDispatchedFailureSettle({
      classification: classified,
      intentKind: record.intent.kind,
      attempt: active.attempt,
      elapsedMs: Math.max(0, now - record.dispatchedAt),
      fastFails: bookkeeping.fastFails.get(taskId) ?? 0,
      compactAttempts: bookkeeping.compactAttempts.get(taskId) ?? 0,
      maxConsecutive: settings.autoResumeMaxConsecutive,
      message,
      now,
    });
    bookkeeping.fastFails.set(taskId, plan.fastFails);
    bookkeeping.compactAttempts.set(taskId, plan.compactAttempts);
    if (plan.disarmCompact) bookkeeping.contextCompactArmed.delete(taskId);
    this.releaseDispatch(record);

    if (plan.action.type === "exhausted") {
      await repo.markExhausted(intentId, plan.action.lastError, { now });
      this.forgetTask(taskId);
      serviceLogger.info("resume intent exhausted", {
        taskId,
        classification: classified,
        message,
      });
      return;
    }
    const requeued = await repo.requeueAfterFailure(
      intentId,
      { kind: plan.action.kind, nextEligibleAt: plan.action.nextEligibleAt, lastError: message },
      { now, attemptMode: plan.action.attemptMode },
    );
    if (!requeued) {
      this.forgetTask(taskId);
      return;
    }
    serviceLogger.info("auto-resume turn failed, rescheduled", {
      taskId,
      classification: classified,
      kind: plan.action.kind,
      attempt: requeued.attempt,
      nextEligibleAt: requeued.nextEligibleAt,
      quotaFastFail: plan.action.quotaFastFail,
    });
    if (classified === "quota") {
      await this.deps.gate.claimAfterFailure(failure.providerErrorCode, settings, now);
    }
  }

  /** 既有 pending 意图 + 新的失败事实：同类不动（额度类顺带尝试核销），异类改写且只提前不推迟。 */
  private async refreshPendingIntent(
    active: ResumeIntent,
    failure: { providerErrorCode: string | null },
    classified: ResumeIntentKind,
    message: string,
    settings: QuotaWatchdogSettings,
    now: number,
  ): Promise<void> {
    const taskId = active.taskId;
    if (classified === "quota") this.deps.bookkeeping.lastQuotaFailureAt = now;
    if (classified !== active.kind) {
      await this.deps.resumeIntentRepo.upsertPending(
        {
          taskId,
          workspacePath: active.workspacePath,
          workspaceIdentity: active.workspaceIdentity,
          kind: classified,
          nextEligibleAt: Math.min(
            active.nextEligibleAt,
            now + resumeInitialDelayMs(classified, active.attempt),
          ),
          lastError: message,
        },
        { now, attemptMode: "keep" },
      );
      if (active.kind === "context") this.deps.bookkeeping.contextCompactArmed.delete(taskId);
      serviceLogger.info("resume intent reclassified", {
        taskId,
        from: active.kind,
        to: classified,
      });
    }
    if (classified === "quota") {
      await this.deps.gate.claimAfterFailure(failure.providerErrorCode, settings, now);
    }
  }

  private async createIntent(
    input: SessionFailureInput,
    classified: ResumeIntentKind,
    message: string,
    settings: QuotaWatchdogSettings,
    now: number,
  ): Promise<void> {
    const taskId = input.taskId;
    const bookkeeping = this.deps.bookkeeping;
    const kind = classified;
    bookkeeping.fastFails.delete(taskId);
    bookkeeping.compactAttempts.delete(taskId);
    bookkeeping.compactRejects.delete(taskId);
    bookkeeping.dispatchErrors.delete(taskId);
    bookkeeping.activityDeferrals.delete(taskId);
    if (kind === "context") bookkeeping.contextCompactArmed.delete(taskId);
    if (kind === "quota") bookkeeping.lastQuotaFailureAt = now;
    const intent = await this.deps.resumeIntentRepo.upsertPending(
      {
        taskId,
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
        kind,
        nextEligibleAt: now + resumeInitialDelayMs(kind, 0),
        lastError: message,
      },
      { now, attemptMode: "increment" },
    );
    serviceLogger.info("resume intent recorded", {
      taskId,
      kind,
      attempt: intent.attempt,
      nextEligibleAt: intent.nextEligibleAt,
    });
    if (kind === "quota") {
      await this.deps.gate.claimAfterFailure(input.providerErrorCode ?? null, settings, now);
    }
  }

  /** 清空某 task 的簿记（lastFailure 除外，见字段注释）。 */
  private forgetTask(taskId: string): void {
    const b = this.deps.bookkeeping;
    b.fastFails.delete(taskId);
    b.compactAttempts.delete(taskId);
    b.compactRejects.delete(taskId);
    b.dispatchErrors.delete(taskId);
    b.activityDeferrals.delete(taskId);
    b.contextCompactArmed.delete(taskId);
  }

  /** 释放一次在途派发的全部资源（标记 settled，迟到的重复结算据此放弃）。 */
  private releaseDispatch(record: InFlightDispatch): void {
    record.settled = true;
    if (record.startTimer) {
      clearTimeout(record.startTimer);
      record.startTimer = null;
    }
    if (record.attributionTimer) {
      clearTimeout(record.attributionTimer);
      record.attributionTimer = null;
    }
    record.wait.dispose();
    if (this.inFlight.get(record.intent.taskId) === record) {
      this.inFlight.delete(record.intent.taskId);
    }
  }

  // ---- 派发 ----

  /**
   * 派发一条到期意图（调用方已过派发门）。任何一步失败都不能让行卡在 dispatched：
   * 一律回到 failDispatch 短重试，不消耗 attempt。
   */
  async dispatch(intent: ResumeIntent, settings: QuotaWatchdogSettings): Promise<void> {
    if (this.disposed) return;
    const taskId = intent.taskId;
    const target: QuotaResumeTarget = {
      taskId,
      workspacePath: intent.workspacePath,
      workspaceIdentity: intent.workspaceIdentity,
    };
    const repo = this.deps.resumeIntentRepo;
    const bookkeeping = this.deps.bookkeeping;
    try {
      const now = this.deps.now();
      // 任务仍有在途活动（用户已接管 / compact 维护 turn 在跑）：不取消、不派发，稍后再看。
      // v2 的 isTaskActive 读的是 sqlite 状态列，从不为 running：该分支从未生效，
      // 而 1h 结局超时后又把仍在运行的长任务当成失败回队，造成重复续跑。
      if ((await this.deps.dispatch.getTaskActivity(target)) === "active") {
        const deferral = bookkeeping.activityDeferrals.get(taskId) ?? { since: now, count: 0 };
        deferral.count += 1;
        if (now - deferral.since >= RESUME_ACTIVE_DEFER_LIMIT_MS) {
          await repo.cancel(taskId, "task_still_running", { now });
          this.forgetTask(taskId);
          serviceLogger.info("resume intent cancelled, task kept running", {
            taskId,
            deferrals: deferral.count,
          });
          return;
        }
        bookkeeping.activityDeferrals.set(taskId, deferral);
        await repo.reschedulePending(intent.resumeIntentId, now + RESUME_ACTIVE_DEFER_MS, { now });
        serviceLogger.info("resume deferred, task is active", {
          taskId,
          deferrals: deferral.count,
        });
        return;
      }
      bookkeeping.activityDeferrals.delete(taskId);

      if (intent.attempt >= settings.autoResumeMaxConsecutive) {
        await repo.markExhausted(
          intent.resumeIntentId,
          `attempt limit ${settings.autoResumeMaxConsecutive}`,
          { now },
        );
        this.forgetTask(taskId);
        serviceLogger.info("resume intent exhausted", { taskId, attempt: intent.attempt });
        return;
      }
      if ((bookkeeping.dispatchErrors.get(taskId) ?? 0) >= RESUME_MAX_DISPATCH_ERRORS) {
        await repo.markExhausted(
          intent.resumeIntentId,
          "resume could not be dispatched repeatedly",
          { now },
        );
        this.forgetTask(taskId);
        return;
      }

      const inputId = `${RESUME_INPUT_ID_PREFIX}-${intent.resumeIntentId}-${now}`;
      // 先订阅再派发：额度未恢复时 turn 会在派发调用返回前就失败。
      const wait = this.deps.dispatch.subscribeOutcome({
        ...target,
        expectedInputId: inputId,
        timeoutMs: TURN_OUTCOME_TIMEOUT_MS,
      });
      const record: InFlightDispatch = {
        intent,
        inputId,
        dispatchedAt: now,
        wait,
        startTimer: null,
        attributionTimer: null,
        rearms: 0,
        settled: false,
      };
      this.inFlight.set(taskId, record);
      this.watchOutcome(wait, record);
      const ack = await this.deps.dispatch.sendResumeText({
        ...target,
        resumeIntentId: intent.resumeIntentId,
        inputId,
      });
      if (ack !== "accepted") {
        // duplicate / noop 不会开启新一轮，也就没有终态事件：不能干等。
        throw new Error(`resume command not started (ack=${ack})`);
      }
      bookkeeping.dispatchErrors.delete(taskId);
      serviceLogger.info("auto-resume dispatched", {
        taskId,
        attempt: intent.attempt + 1,
        kind: intent.kind,
        inputId,
      });
      record.startTimer = setTimeout(
        () =>
          void this.checkTurnStarted(record).catch((error: unknown) => {
            serviceLogger.warn("resume turn start check failed", {
              taskId,
              error: toErrorMessage(error),
            });
          }),
        TURN_START_TIMEOUT_MS,
      );
    } catch (error) {
      await this.failDispatch(intent, error);
    }
  }

  /** 派发本身失败（会话未加载/命令被拒/turn 未启动）：不计 attempt，短重试；连续失败触顶转 exhausted。 */
  private async failDispatch(intent: ResumeIntent, error: unknown): Promise<void> {
    const taskId = intent.taskId;
    const now = this.deps.now();
    const message = toErrorMessage(error);
    try {
      const record = this.inFlight.get(taskId);
      if (record && record.intent.resumeIntentId === intent.resumeIntentId) {
        this.releaseDispatch(record);
      }
      const active = await this.deps.resumeIntentRepo.getActiveByTask(taskId);
      // 行已被结局通道或用户收口（不再是这一次的 dispatched 行）：不重复处理。
      if (!active || active.resumeIntentId !== intent.resumeIntentId) return;
      if (active.status !== "dispatched") return;
      const count = (this.deps.bookkeeping.dispatchErrors.get(taskId) ?? 0) + 1;
      this.deps.bookkeeping.dispatchErrors.set(taskId, count);
      if (count >= RESUME_MAX_DISPATCH_ERRORS) {
        await this.deps.resumeIntentRepo.markExhausted(
          intent.resumeIntentId,
          `resume could not be dispatched: ${message}`,
          { now },
        );
        this.forgetTask(taskId);
        serviceLogger.warn("resume intent exhausted, dispatch kept failing", { taskId, count });
        return;
      }
      await this.deps.resumeIntentRepo.requeueAfterFailure(
        intent.resumeIntentId,
        {
          kind: intent.kind,
          nextEligibleAt: now + RESUME_DISPATCH_RETRY_MS,
          lastError: `dispatch failed: ${message}`,
        },
        { now, attemptMode: "keep" },
      );
      serviceLogger.warn("auto-resume dispatch failed, will retry", {
        taskId,
        count,
        error: message,
      });
    } catch (repoError) {
      serviceLogger.warn("resume dispatch failure handling failed", {
        taskId,
        error: toErrorMessage(repoError),
      });
    } finally {
      this.deps.onActivity();
    }
  }

  /** 启动看护：ACK 已接受但 turn 始终没有进入 running，按派发失败处理（否则要空等 1h 结局超时）。 */
  private async checkTurnStarted(record: InFlightDispatch): Promise<void> {
    const taskId = record.intent.taskId;
    if (record.settled || this.inFlight.get(taskId) !== record) return;
    let activity: TaskActivity;
    try {
      activity = await this.deps.dispatch.getTaskActivity(this.targetOf(record));
    } catch {
      return;
    }
    // 只有索引明确观察到"不在活动"才能断定 turn 没启动；读不到（unknown）时不下结论。
    if (activity !== "idle" || record.settled || this.inFlight.get(taskId) !== record) return;
    serviceLogger.warn("auto-resume turn did not start", { taskId, inputId: record.inputId });
    this.releaseDispatch(record);
    await this.failDispatch(record.intent, new Error("resume turn did not start"));
  }

  /** 结局等待 → 结算（吞掉结算链路上的异常：它是游离的 promise，不能变成 unhandled rejection）。 */
  private watchOutcome(wait: TurnOutcomeWait, record: InFlightDispatch): void {
    const settle = (outcome: TurnOutcomeWaitResult) =>
      this.settleOutcome(record, outcome).catch((error: unknown) => {
        serviceLogger.warn("auto-resume outcome settle failed", {
          taskId: record.intent.taskId,
          error: toErrorMessage(error),
        });
        this.deps.onActivity();
      });
    void wait.result.then(settle, (error: unknown) =>
      settle({ outcome: "failed", errorMessage: toErrorMessage(error) }),
    );
  }

  private targetOf(record: InFlightDispatch): QuotaResumeTarget {
    return {
      taskId: record.intent.taskId,
      workspacePath: record.intent.workspacePath,
      workspaceIdentity: record.intent.workspaceIdentity,
    };
  }

  private async settleOutcome(
    record: InFlightDispatch,
    outcome: TurnOutcomeWaitResult,
    attributionGraceElapsed = false,
  ): Promise<void> {
    const taskId = record.intent.taskId;
    if (record.settled || this.inFlight.get(taskId) !== record) {
      // 已由 detector 路径结算，或已被取消。
      record.wait.dispose();
      return;
    }
    const repo = this.deps.resumeIntentRepo;
    const now = this.deps.now();
    if (outcome.outcome === "completed") {
      this.releaseDispatch(record);
      try {
        await repo.deleteOnSuccess(record.intent.resumeIntentId);
        this.forgetTask(taskId);
        serviceLogger.info("auto-resume turn completed", {
          taskId,
          elapsedMs: now - record.dispatchedAt,
        });
      } catch (error) {
        serviceLogger.warn("resume intent cleanup failed", {
          taskId,
          error: toErrorMessage(error),
        });
      }
      this.deps.onActivity();
      return;
    }
    if (outcome.timedOut) {
      // 等待到期：长任务合法超过 1h。仍在跑 → 续等（绝不重复派发）；已停且没有终态 → 按失败结算。
      const settledByRearm = await this.rearmIfStillRunning(record, now);
      if (settledByRearm || record.settled || this.inFlight.get(taskId) !== record) return;
    }
    if (!attributionGraceElapsed && !hasFailureAttribution(outcome)) {
      this.deferUnattributedOutcome(record, outcome);
      return;
    }
    // 注意：这里不能先 releaseDispatch 再移交失败——release 会把记录标记为 settled，
    // processFailure 会把它当成"已被其它通道结算"而直接放弃，意图行就永远停在 dispatched。
    await this.handleSessionFailure({
      ...this.targetOf(record),
      code: outcome.errorCode ?? null,
      providerErrorCode: outcome.providerErrorCode ?? null,
      message: outcome.errorMessage ?? null,
      attributionReason: outcome.attributionReason ?? null,
      via: "outcome",
      record,
    });
  }

  /**
   * 结局通道先于 detector 到达、且不带任何归因（线上真实顺序，见 OUTCOME_ATTRIBUTION_GRACE_MS）。
   * 此刻立即结算只能按"无法归因"处理：额度类快速失败会错记 attempt 并走错退避阶梯，长时间正常
   * 运转后才耗尽的续跑也会一路累计到上限提前停止（工作停下来）。所以短暂保留在途记录，把结算
   * 让给随后到达的 detector（它携带回源快照的权威 lastError）；宽限内 detector 没来，再按无法
   * 归因结算——绝不因此把行卡在 dispatched。
   */
  private deferUnattributedOutcome(record: InFlightDispatch, outcome: TurnOutcomeWaitResult): void {
    if (record.attributionTimer || record.settled) return;
    record.attributionTimer = setTimeout(() => {
      record.attributionTimer = null;
      // detector 已结算（记录被释放）或已被取消：什么都不做。
      if (record.settled || this.inFlight.get(record.intent.taskId) !== record) return;
      void this.settleOutcome(record, outcome, true).catch((error: unknown) => {
        serviceLogger.warn("auto-resume outcome settle failed", {
          taskId: record.intent.taskId,
          error: toErrorMessage(error),
        });
        this.deps.onActivity();
      });
    }, this.deps.outcomeAttributionGraceMs ?? OUTCOME_ATTRIBUTION_GRACE_MS);
    // 宽限定时器不阻止进程退出。
    record.attributionTimer.unref?.();
  }

  /**
   * 结局等待到期且任务仍在跑：重新挂一个等待并返回 true。
   * 已连续等待 TURN_OUTCOME_MAX_REARMS × 1h：任务早已不需要自动续跑，取消意图交还用户。
   * 任务已停则返回 false，由调用方按失败结算。
   */
  private async rearmIfStillRunning(record: InFlightDispatch, now: number): Promise<boolean> {
    const taskId = record.intent.taskId;
    let stillRunning = true;
    try {
      // 读不到活动状态（unknown）时保守按"仍在跑"处理：宁可多等一轮，也不重复派发。
      stillRunning = (await this.deps.dispatch.getTaskActivity(this.targetOf(record))) !== "idle";
    } catch {
      // 查询失败同样保守按"仍在跑"处理。
    }
    if (record.settled || this.inFlight.get(taskId) !== record) return true;
    if (!stillRunning) return false;
    if (record.rearms < TURN_OUTCOME_MAX_REARMS) {
      const wait = this.deps.dispatch.subscribeOutcome({
        ...this.targetOf(record),
        expectedInputId: record.inputId,
        timeoutMs: TURN_OUTCOME_TIMEOUT_MS,
      });
      const next: InFlightDispatch = {
        ...record,
        wait,
        rearms: record.rearms + 1,
        startTimer: null,
        attributionTimer: null,
        settled: false,
      };
      record.settled = true;
      record.wait.dispose();
      this.inFlight.set(taskId, next);
      this.watchOutcome(wait, next);
      serviceLogger.info("auto-resume turn still running, keep waiting", {
        taskId,
        rearms: next.rearms,
      });
      return true;
    }
    this.releaseDispatch(record);
    await this.deps.resumeIntentRepo.cancel(taskId, "task_still_running", { now });
    this.forgetTask(taskId);
    serviceLogger.info("resume intent cancelled, long-running turn kept running", { taskId });
    this.deps.onActivity();
    return true;
  }
}
