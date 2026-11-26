import {
  type CodingPlanResetScopeRequest,
  type CodingPlanResetStatusSnapshot,
  type CodingPlanResetType,
  type QuotaWatchdogSettings,
  type ResumeIntent,
  type ResumeIntentKind,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ResumeIntentRepo } from "#src/session/resumeIntentRepo.js";
import type { QuotaResumeDispatchPort, ResumeTaskBookkeeping } from "./quotaResumeTracker.js";
import {
  claimTargetForFailure,
  RESUME_AFTER_CLAIM_DELAY_MS,
  RESUME_CLAIM_COOLDOWN_MS,
  RESUME_COMPACT_WAIT_MS,
  RESUME_FIVE_HOUR_CAP_CODES,
  RESUME_WEEK_CAP_CODES,
  resolveExhaustedRecheckAt,
  type QuotaUsageObservation,
} from "./quotaWatchdogDomain.js";
import { RESUME_MAX_COMPACT_REJECTS } from "./quotaResumeSettlement.js";
import type { QuotaResumeClaim } from "./quotaResumeClaim.js";

// 派发门（docs/quota-watchdog/spec.md §9.3）：意图到期后、真正派发前的最后一道裁定。
// 设计原则——**"不可知"绝不等于"已耗尽"**：
// v2 在快照读不到额度时无限期守卫重排（线上表现为每 5 分钟一条 "snapshot unavailable"，
// 任务卡死 10 小时）。v3 规定：额度可读且耗尽 → 核销卡 / 等重置（有上限地复核）；
// 额度不可知 → 放行探测，节奏与次数由失败路径的探测阶梯约束。
// 纯编排：观测结果由宿主 service 传入，簿记状态经回调读写，自身不持有跨 tick 状态。

const serviceLogger = createServiceLogger("quota-watchdog-gate");

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 有卡但核销未确认（/use 失败或对账未达），以及观测不完整时的短重试间隔；幂等 key 复用，不会重复扣卡。 */
const QUOTA_CLAIM_RETRY_MS = 2 * 60_000;

/** 一次额度观测：scope + entitlement 快照 + 重置卡状态。usage.remainingPercent=null 表示不可知。 */
export interface QuotaObservation {
  scope: CodingPlanResetScopeRequest | null;
  snapshot: UsageEntitlementSnapshot | null;
  usage: QuotaUsageObservation;
  resetSnapshot: CodingPlanResetStatusSnapshot | null;
}

export function unknownQuotaObservation(): QuotaObservation {
  return {
    scope: null,
    snapshot: null,
    usage: { remainingPercent: null, exhausted: false, nextResetTime: null },
    resetSnapshot: null,
  };
}

/** 是否具备自动核销的资格：从未核销过，或上次核销之后又出现过真实的额度类失败。
 *  只凭"快照仍显示耗尽"不再烧第二张卡——核销已确认而快照滞后时，v2 会把卡一张张耗光。 */
export function mayClaimCard(
  lastClaimAt: number,
  lastQuotaFailureAt: number,
  autoClaimEnabled: boolean,
): boolean {
  if (!autoClaimEnabled) return false;
  return lastClaimAt === 0 || lastQuotaFailureAt > lastClaimAt;
}

export interface QuotaResumeGateDeps {
  resumeIntentRepo: ResumeIntentRepo;
  claim: QuotaResumeClaim;
  /** v4 compact 维护命令与会话活动状态（compact 维护工作是否在跑）。 */
  dispatch: Pick<QuotaResumeDispatchPort, "requestCompact" | "isCompactWorkActive">;
  /** 每任务簿记（compact 已发起标记 / 被拒计数）与宿主全局的最近额度类失败时刻。 */
  bookkeeping: ResumeTaskBookkeeping;
  /** 最近一次核销成功的时刻（0 = 无，宿主全局）。 */
  getLastClaimAt: () => number;
  /** 取一次新的额度观测（核销前用最新事实，不复用 tick 开头的旧快照）。 */
  observe: () => Promise<QuotaObservation>;
  /** 核销成功后的联动：把所有等待额度的意图提前到 now + RESUME_AFTER_CLAIM_DELAY_MS。 */
  onCardClaimed: (now: number) => Promise<void>;
  scheduleNextTick: () => void;
  now: () => number;
}

export function createQuotaResumeGate(deps: QuotaResumeGateDeps) {
  /**
   * 核销当前可用的一张卡。冷却内不重复发 /use（对账进行中或刚核销过）。
   * 返回是否核销成功。
   */
  async function claimIfAvailable(
    observation: QuotaObservation,
    resetType: CodingPlanResetType | undefined,
    now: number,
  ): Promise<boolean> {
    const { scope, resetSnapshot } = observation;
    if (
      !scope ||
      !resetSnapshot ||
      resetType === undefined ||
      now - deps.getLastClaimAt() < RESUME_CLAIM_COOLDOWN_MS ||
      !deps.claim.canRequest()
    ) {
      return false;
    }
    const claimed = await deps.claim.claimResets(resetSnapshot, scope, resetType);
    if (claimed) {
      serviceLogger.info("reset card consumed for auto-resume", { trigger: "resume-gate" });
      await deps.onCardClaimed(now);
    }
    return claimed;
  }

  /**
   * 返回是否放行派发。false = 意图已被守卫重排回 pending（不消耗 attempt）。
   */
  async function admitClaimedIntent(
    intent: ResumeIntent,
    settings: QuotaWatchdogSettings,
    observation: QuotaObservation,
  ): Promise<boolean> {
    const now = deps.now();
    const repo = deps.resumeIntentRepo;
    const bookkeeping = deps.bookkeeping;
    const defer = async (nextEligibleAt: number, kind: ResumeIntentKind = intent.kind) => {
      await repo.reschedulePending(intent.resumeIntentId, nextEligibleAt, { now, kind });
      deps.scheduleNextTick();
      return false;
    };

    // ---- context：先压缩再续跑----
    if (intent.kind === "context") {
      if (
        !bookkeeping.contextCompactArmed.has(intent.taskId) &&
        deps.dispatch.isCompactWorkActive(intent.taskId)
      ) {
        // 已有压缩在跑（用户手动 /compact，或上一进程发起后本进程重启）：复用它，不重复请求。
        bookkeeping.contextCompactArmed.add(intent.taskId);
        return defer(now + RESUME_COMPACT_WAIT_MS, "context");
      }
      if (!bookkeeping.contextCompactArmed.has(intent.taskId)) {
        if ((bookkeeping.compactRejects.get(intent.taskId) ?? 0) >= RESUME_MAX_COMPACT_REJECTS) {
          // 压缩请求一再被拒（草稿会话 / 命令面不可用等）：放行续跑交由结局裁决，
          // 仍溢出则按 RESUME_MAX_CONTEXT_COMPACTS 收口为 exhausted，绝不无限请求。
          return true;
        }
        let requestResult: "accepted" | "alreadyRunning" | "rejected" = "rejected";
        try {
          requestResult = await deps.dispatch.requestCompact({
            taskId: intent.taskId,
            workspacePath: intent.workspacePath,
            workspaceIdentity: intent.workspaceIdentity,
          });
        } catch (error) {
          serviceLogger.warn("context compact request failed, will retry", {
            taskId: intent.taskId,
            error: toErrorMessage(error),
          });
        }
        if (requestResult === "rejected") {
          bookkeeping.compactRejects.set(
            intent.taskId,
            (bookkeeping.compactRejects.get(intent.taskId) ?? 0) + 1,
          );
        } else {
          bookkeeping.contextCompactArmed.add(intent.taskId);
          bookkeeping.compactRejects.delete(intent.taskId);
        }
        serviceLogger.info("context compact requested before resume", {
          taskId: intent.taskId,
          requestResult,
        });
        // 无论是否被接受都稍后再看：已发起 → 等 compact 维护 turn 落地；被拒 → 重试。
        // 绝不在压缩未发起时直接续跑（否则必然再次溢出）。
        return defer(now + RESUME_COMPACT_WAIT_MS, "context");
      }
      if (deps.dispatch.isCompactWorkActive(intent.taskId)) {
        // 压缩仍在进行：此刻续跑文本只会进队列空等结局，等压缩落地再派发。
        return defer(now + RESUME_COMPACT_WAIT_MS, "context");
      }
      return true;
    }

    // ---- transient：快照明确显示额度已耗尽时转 quota（限流退避不再空转）----
    if (intent.kind === "transient") {
      if (observation.usage.exhausted) {
        serviceLogger.info("transient intent converted to quota, quota exhausted", {
          taskId: intent.taskId,
        });
        return defer(resolveExhaustedRecheckAt(observation.usage.nextResetTime, now), "quota");
      }
      return true;
    }

    // ---- quota ----
    // 额度可读且有余量，或额度不可知：放行（不可知时为探测派发，节奏与次数由探测阶梯约束）。
    if (!observation.usage.exhausted) return true;
    // 刚核销过（冷却内快照滞后）：放行探测，不重复烧卡也不死等。
    if (now - deps.getLastClaimAt() < RESUME_CLAIM_COOLDOWN_MS) return true;

    const claimEligible = mayClaimCard(
      deps.getLastClaimAt(),
      bookkeeping.lastQuotaFailureAt,
      settings.autoClaimResetCardsEnabled,
    );
    if (claimEligible) {
      if (!observation.scope || !observation.resetSnapshot) {
        // 观测不完整（scope / 重置卡状态拉取失败）：短重试，不进入等重置的长等待。
        serviceLogger.warn("quota intent deferred, reset status unavailable", {
          taskId: intent.taskId,
        });
        return defer(now + QUOTA_CLAIM_RETRY_MS);
      }
      const resetType = claimTargetForFailure("quota", null, observation.resetSnapshot, now);
      if (resetType) {
        if (await claimIfAvailable(observation, resetType, now)) {
          // 核销成功：给服务端额度生效留余量后再续派发（本行已是 dispatched，单独重排；
          // 其余等待额度的意图由 onCardClaimed 一并提前）。
          return defer(now + RESUME_AFTER_CLAIM_DELAY_MS);
        }
        // 有卡但本次未核销成功：短重试（claimResets 对同一次核销复用幂等 key）。
        return defer(now + QUOTA_CLAIM_RETRY_MS);
      }
    }
    // 无卡 / 不具备核销资格 / 未启用自动核销：等到 nextReset+裕量，但最长 RESUME_QUOTA_MAX_RECHECK_MS
    // 复核一次（卡可能出现、服务端可能提前恢复、快照可能滞后）。期间不派发，不产生空转 turn。
    const nextEligibleAt = resolveExhaustedRecheckAt(observation.usage.nextResetTime, now);
    await defer(nextEligibleAt);
    serviceLogger.info("quota intent deferred, quota exhausted", {
      taskId: intent.taskId,
      nextEligibleAt,
      autoClaim: settings.autoClaimResetCardsEnabled,
      claimEligible,
      hasCard:
        observation.resetSnapshot !== null &&
        claimTargetForFailure("quota", null, observation.resetSnapshot, now) !== null,
    });
    return false;
  }

  /**
   * 失败路径里的即时核销（任务刚以额度类失败时调用）：用户的头号诉求——有卡就当场消费、
   * 工作不停。卡型按 provider 业务码裁决（1310 周/月上限只认 WEEK 卡）。
   */
  async function claimOnFailure(
    observation: QuotaObservation,
    input: { providerErrorCode: string | null },
    autoClaimEnabled: boolean,
    now: number,
  ): Promise<boolean> {
    const { scope, resetSnapshot } = observation;
    if (!scope || !resetSnapshot) return false;
    if (
      !mayClaimCard(deps.getLastClaimAt(), deps.bookkeeping.lastQuotaFailureAt, autoClaimEnabled) ||
      now - deps.getLastClaimAt() < RESUME_CLAIM_COOLDOWN_MS
    ) {
      return false;
    }
    const resetType = claimTargetForFailure("quota", input.providerErrorCode, resetSnapshot, now);
    if (!resetType) return false;
    return claimIfAvailable(observation, resetType, now);
  }

  /**
   * 额度类失败后的即时核销（用户的核心诉求：有卡就当场消费，工作不停）。
   * 快照可读且明显有余量时不烧卡——失败可能来自别的额度桶或瞬时抖动；
   * provider 明确报用量上限（1308 / 1310）时无视快照直接核销。返回是否核销成功。
   */
  async function claimAfterFailure(
    providerErrorCode: string | null,
    settings: QuotaWatchdogSettings,
    now: number,
  ): Promise<boolean> {
    if (!settings.autoClaimResetCardsEnabled) return false;
    const observation = await deps.observe();
    if (!observation.resetSnapshot) return false;
    const code = providerErrorCode?.trim() ?? "";
    const providerSaysCapped =
      RESUME_WEEK_CAP_CODES.has(code) || RESUME_FIVE_HOUR_CAP_CODES.has(code);
    if (
      !providerSaysCapped &&
      observation.usage.remainingPercent !== null &&
      !observation.usage.exhausted
    ) {
      return false;
    }
    const claimed = await claimOnFailure(
      observation,
      { providerErrorCode },
      settings.autoClaimResetCardsEnabled,
      now,
    );
    if (claimed) deps.scheduleNextTick();
    return claimed;
  }

  return { admitClaimedIntent, claimOnFailure, claimAfterFailure };
}

export type QuotaResumeGate = ReturnType<typeof createQuotaResumeGate>;
