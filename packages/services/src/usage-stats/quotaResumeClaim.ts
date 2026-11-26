import { randomUUID } from "node:crypto";
import type {
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  hasUsableResetCard,
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
  clock: () => number = () => Date.now(),
) {
  /**
   * 核销当前可用的重置卡。返回对账确认是否成功（false = 未确认，宿主短重试，
   * 幂等 key 保留 → 同一次核销不会重复扣卡）。
   */
  async function claimResets(
    resetSnapshot: CodingPlanResetStatusSnapshot,
    scope: CodingPlanResetScopeRequest,
    requestedType?: CodingPlanResetType,
  ): Promise<boolean> {
    const now = clock();
    // 卡型由调用方按 provider 业务码裁决（1310 周/月上限只有 WEEK 卡有效）；
    // 未指定时沿用"5 小时卡优先"的最小代价原则。
    const resetType = requestedType ?? resolveClaimTarget(resetSnapshot, now);
    if (!resetType) {
      return false;
    }
    // 对账后所请求的卡型已不可用即放弃，不携带新幂等键重试，也不退到另一卡型
    //（换卡型等于推翻调用方按业务码做过的裁决）。
    let fresh: CodingPlanResetStatusSnapshot;
    try {
      fresh = await usageStatsService.getCodingPlanResetStatus(scope);
    } catch (error) {
      serviceLogger.warn("pre-use reconciliation failed", { error: toErrorMessage(error) });
      return false;
    }
    if (!hasUsableResetCard(fresh, resetType, clock())) {
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

  /**
   * 主动状态无卡时补位触发服务端资格判断（renderer hidden 时无人触发，spec §3.2）。
   * 返回服务端是否本次发卡。
   */
  async function requestOpportunity(scope: CodingPlanResetScopeRequest): Promise<boolean> {
    const now = clock();
    let granted = false;
    // 瞬时错误复用同一幂等 key；429/稳定错误换新 key（与 Coordinator 规则一致）。
    const idempotencyKey = bookkeeping.opportunityIdempotencyKey ?? randomUUID();
    try {
      const result = await usageStatsService.requestCodingPlanResetOpportunity({
        ...scope,
        idempotencyKey,
      });
      bookkeeping.opportunityIdempotencyKey = null;
      granted = result.granted;
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
    return granted;
  }

  /** 是否可以发起核销（/use 对账进行中时绝不并发发第二次）。 */
  function canRequest(): boolean {
    return !bookkeeping.useInFlight;
  }

  return { claimResets, requestOpportunity, canRequest };
}

export type QuotaResumeClaim = ReturnType<typeof createQuotaResumeClaim>;
