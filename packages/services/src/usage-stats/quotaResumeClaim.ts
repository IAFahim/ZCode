import { randomUUID } from "node:crypto";
import type { CodingPlanResetScopeRequest, CodingPlanResetStatusSnapshot } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  isOpportunityTransientError,
  isOpportunityThrottleError,
  nextOpportunityCooldownUntil,
  resolveClaimTarget,
} from "./quotaWatchdogDomain.js";
import type { IUsageStatsService } from "./usageStats.js";

// 自动核销与机会资格判断（docs/quota-watchdog/spec.md §3.2/§9.3；独立成文件以守住 800 行上限）：
// - claimResets：只走既有 /use（幂等 key + reset_type），/use 前强制对账，对账确认 used_at
//   变化后才算成功；失败保留幂等 key 同一轮核销重试复用。
// - requestOpportunity：补位 renderer hidden 的 /opportunity 资格判断真空；冷却与幂等 key
//   规则与 renderer Coordinator 对齐（granted +10min / denied max(next_try_at,+5min) /
//   瞬时 +5min 复用 key / 稳定 +10min 换 key）。
// 簿记状态（在途锁 + 幂等 key + 冷却）由宿主 service 持有，经 bookkeeping 对象注入。

const serviceLogger = createServiceLogger("quota-watchdog-claim");

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** /use 后 status 对账重试阶梯（与 renderer hook USE_STATUS_RETRY_DELAYS_MS 同值）。 */
const USE_CONFIRM_RETRY_DELAYS_MS = [0, 250, 750, 1_500] as const;

/** 核销/机会簿记（宿主持有唯一实例；本模块纯逻辑无状态）。 */
export interface QuotaResumeClaimBookkeeping {
  /** /use 对账进行中：期间绝不调用 /opportunity（发卡锁互斥，spec §3.2）。 */
  useInFlight: boolean;
  /** /use 幂等 key：失败保留（同一次核销重试复用），确认成功清空。 */
  useIdempotencyKey: string | null;
  /** /opportunity 冷却截止。 */
  opportunityCooldownUntil: number;
  /** /opportunity 幂等 key：瞬时错误复用，429/稳定错误换新。 */
  opportunityIdempotencyKey: string | null;
}

export function createEmptyClaimBookkeeping(): QuotaResumeClaimBookkeeping {
  return {
    useInFlight: false,
    useIdempotencyKey: null,
    opportunityCooldownUntil: 0,
    opportunityIdempotencyKey: null,
  };
}

export function createQuotaResumeClaim(
  usageStatsService: IUsageStatsService,
  bookkeeping: QuotaResumeClaimBookkeeping,
) {
  /**
   * 核销当前可用的重置卡。返回对账确认是否成功（false = 未确认，宿主短重试，
   * 幂等 key 保留 → 同一次核销不会重复扣卡）。
   */
  async function claimResets(
    resetSnapshot: CodingPlanResetStatusSnapshot,
    scope: CodingPlanResetScopeRequest,
  ): Promise<boolean> {
    const now = Date.now();
    const resetType = resolveClaimTarget(resetSnapshot, now);
    if (!resetType) {
      return false;
    }
    // 对账后无可核销机会即放弃，不携带新幂等键重试（与 renderer 强制对账同语义）。
    let fresh: CodingPlanResetStatusSnapshot;
    try {
      fresh = await usageStatsService.getCodingPlanResetStatus(scope);
    } catch (error) {
      serviceLogger.warn("pre-use reconciliation failed", { error: toErrorMessage(error) });
      return false;
    }
    const stillClaimable = resolveClaimTarget(fresh, Date.now());
    if (stillClaimable !== resetType) {
      return false;
    }
    const idempotencyKey = bookkeeping.useIdempotencyKey ?? randomUUID();
    bookkeeping.useIdempotencyKey = idempotencyKey;
    bookkeeping.useInFlight = true;
    try {
      await usageStatsService.useCodingPlanReset({
        ...scope,
        idempotencyKey,
        resetType,
      });
      // /use 接受后按既有对账协议确认 used_at 变化（[0,250,750,1500]ms）。
      const baseline =
        resetType === "WEEK"
          ? (fresh.latestWeekResetHistory?.usedAt ?? null)
          : (fresh.latestFiveHourResetHistory?.usedAt ?? null);
      for (const delayMs of USE_CONFIRM_RETRY_DELAYS_MS) {
        await sleep(delayMs);
        const confirmed = await usageStatsService.getCodingPlanResetStatus(scope);
        const usedAt =
          resetType === "WEEK"
            ? (confirmed.latestWeekResetHistory?.usedAt ?? null)
            : (confirmed.latestFiveHourResetHistory?.usedAt ?? null);
        if (usedAt !== null && usedAt !== baseline) {
          serviceLogger.info("reset card auto-claimed", { resetType, usedAt });
          bookkeeping.useIdempotencyKey = null;
          return true;
        }
      }
      serviceLogger.warn("reset card claim not confirmed, will retry with same key", {
        resetType,
      });
      return false;
    } catch (error) {
      // 失败保留幂等 key（同一次核销重试复用），下一 tick 再试。
      serviceLogger.warn("reset card auto-claim failed", {
        resetType,
        error: toErrorMessage(error),
      });
      return false;
    } finally {
      bookkeeping.useInFlight = false;
    }
  }

  /** 主动状态无卡时补位触发服务端资格判断（renderer hidden 时无人触发，spec §3.2）。 */
  async function requestOpportunity(scope: CodingPlanResetScopeRequest): Promise<void> {
    const now = Date.now();
    // 瞬时错误复用同一幂等 key；429/稳定错误换新 key（与 Coordinator 规则一致）。
    const idempotencyKey = bookkeeping.opportunityIdempotencyKey ?? randomUUID();
    try {
      const result = await usageStatsService.requestCodingPlanResetOpportunity({
        ...scope,
        idempotencyKey,
      });
      bookkeeping.opportunityIdempotencyKey = null;
      bookkeeping.opportunityCooldownUntil = nextOpportunityCooldownUntil(
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
      bookkeeping.opportunityIdempotencyKey = transient ? idempotencyKey : null;
      bookkeeping.opportunityCooldownUntil = now + (transient ? 5 * 60_000 : 10 * 60_000);
      serviceLogger.warn("opportunity request failed", {
        transient,
        error: toErrorMessage(error),
      });
    }
  }

  return { claimResets, requestOpportunity };
}

export type QuotaResumeClaim = ReturnType<typeof createQuotaResumeClaim>;
