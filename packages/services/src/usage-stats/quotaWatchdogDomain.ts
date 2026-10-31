import type { CodingPlanResetType } from "@zcode/shared";
import {
  RESUME_QUOTA_WAKE_MARGIN_MS,
  type CodingPlanResetStatusSnapshot,
  type QuotaWatchdogSettings,
  type QuotaWatchdogState,
} from "@zcode/shared";

// 配额守护纯领域逻辑（无 IO / 无时钟读取）：状态机迁移、轮询节奏、认领资格与
// /opportunity 冷却判定。规则来源 docs/quota-watchdog/spec.md §3.1/§3.2；
// 冷却常量与 renderer Coordinator（packages/ui/src/lib/codingPlanQuotaResetCoordinator.ts:5-9）
// 逐条对齐，独立成一份避免 services 反向依赖 ui。

/** CLAIMING 进入线固定 1%；设置只移动 WATCHING 进入线（spec §3.5）。 */
export const QUOTA_WATCHDOG_CLAIM_THRESHOLD_PERCENT = 1;

export const WATCHING_CADENCE_MIN_MS = 20_000;
export const WATCHING_CADENCE_MAX_MS = 120_000;
export const WATCHING_CADENCE_PERCENT_STEP_MS = 30_000;
export const CLAIMING_CADENCE_MS = 30_000;
/** waiting_reset 无 nextResetTime 时的兜底观察间隔。 */
export const WAITING_RESET_FALLBACK_POLL_MS = 5 * 60_000;
/** waiting_reset 唤醒后的核实轮询间隔（spec §3.1：醒后每 60s 一次直至 remaining > 0）。 */
export const RESET_VERIFY_POLL_MS = 60_000;

// 与 codingPlanQuotaResetCoordinator.ts 同值异源：granted → +10min；
// denied(3301) → max(next_try_at, +5min)；瞬时错误 → +5min（复用幂等 key）；
// 429/稳定错误 → +10min（换新 key）。
export const OPPORTUNITY_COOLDOWN_GRANTED_MS = 10 * 60_000;
export const OPPORTUNITY_COOLDOWN_MIN_RETRY_MS = 5 * 60_000;
export const OPPORTUNITY_COOLDOWN_TRANSIENT_MS = 5 * 60_000;
export const OPPORTUNITY_COOLDOWN_STABLE_MS = 10 * 60_000;

/** 看门狗一次观测的输入（service 层从 live entitlement 快照 + reset status 投影而来）。 */
export interface WatchdogObservation {
  /** entitlement remaining.percentage；快照不可用/无百分比时为 null（保持 last-good，不迁移状态）。 */
  remainingPercent: number | null;
  nextResetTime: number | null;
  /** reset status 是否存在未过期有效机会（任一类型）。 */
  hasClaimableCard: boolean;
}

/** 看门狗运行态（service 持有并持久化 checkpoint；此为内存投影形状）。 */
export interface WatchdogRuntimeStatus {
  state: QuotaWatchdogState;
  /** 当前（或刚结束的）耗尽周期 id；进入 watching 时新建，RESTORED 后保留一个周期供展示。 */
  exhaustionCycleId: string | null;
  lastGoodRemainingPercent: number | null;
  lastGoodNextResetTime: number | null;
  /** waiting_reset 的预计唤醒时刻。 */
  wakeAt: number | null;
}

export interface WatchdogTransition {
  status: WatchdogRuntimeStatus;
  /** 本耗尽周期内恰好一次：观察到 remaining > 0 离开主动状态。 */
  quotaRestored: boolean;
}

export function createInitialWatchdogStatus(): WatchdogRuntimeStatus {
  return {
    state: "idle",
    exhaustionCycleId: null,
    lastGoodRemainingPercent: null,
    lastGoodNextResetTime: null,
    wakeAt: null,
  };
}

/** 快照抛错（订阅未知/账号切换）时维持原状态与节奏（spec §3.1：保留 last-good，不清态）。 */
export function transitionOnObservationError(
  prev: WatchdogRuntimeStatus,
): WatchdogTransition {
  return { status: { ...prev, wakeAt: prev.state === "waiting_reset" ? prev.wakeAt : null }, quotaRestored: false };
}

/**
 * 状态机迁移（纯函数）。规则：
 * - idle：remaining ≤ 阈值 → watching（新建耗尽周期）；否则保持。
 * - watching：≤1% 且有卡 → claiming；≤0% 无卡 → waiting_reset；> 阈值 → RESTORED（发事件）回 idle。
 * - claiming：> 阈值 → RESTORED 回 idle（核销成功后的下一次观测走这里）；
 *   卡消失且 ≤0% → waiting_reset；否则保持。
 * - waiting_reset：remaining > 0 → RESTORED 回 idle；仍 ≈0 → 保持并刷新 wakeAt。
 * - remaining 未知（null）：任何状态都不迁移。
 */
export function transitionWatchdogState(
  prev: WatchdogRuntimeStatus,
  observation: WatchdogObservation,
  settings: QuotaWatchdogSettings,
  now: number,
  nextCycleId: () => string,
): WatchdogTransition {
  const lastGood = {
    lastGoodRemainingPercent: observation.remainingPercent ?? prev.lastGoodRemainingPercent,
    lastGoodNextResetTime: observation.nextResetTime ?? prev.lastGoodNextResetTime,
  };
  if (observation.remainingPercent === null) {
    return { status: { ...prev, ...lastGood }, quotaRestored: false };
  }
  const remaining = observation.remainingPercent;
  const threshold = settings.quotaWatchThresholdPercent;
  const wakeAtFor = (): number | null => {
    const base = observation.nextResetTime ?? prev.lastGoodNextResetTime ?? now;
    return Math.max(base, now) + RESUME_QUOTA_WAKE_MARGIN_MS;
  };

  const restored = (completedCycleId: string | null): WatchdogTransition => ({
    status: {
      ...prev,
      ...lastGood,
      state: "restored",
      exhaustionCycleId: completedCycleId,
      wakeAt: null,
    },
    quotaRestored: true,
  });

  switch (prev.state) {
    case "idle": {
      if (remaining <= threshold) {
        return {
          status: {
            ...prev,
            ...lastGood,
            state: "watching",
            exhaustionCycleId: nextCycleId(),
            wakeAt: null,
          },
          quotaRestored: false,
        };
      }
      return { status: { ...prev, ...lastGood, wakeAt: null }, quotaRestored: false };
    }
    case "watching": {
      if (remaining > threshold) {
        return restored(prev.exhaustionCycleId);
      }
      if (remaining <= QUOTA_WATCHDOG_CLAIM_THRESHOLD_PERCENT && observation.hasClaimableCard) {
        return { status: { ...prev, ...lastGood, state: "claiming", wakeAt: null }, quotaRestored: false };
      }
      if (remaining <= 0) {
        return {
          status: { ...prev, ...lastGood, state: "waiting_reset", wakeAt: wakeAtFor() },
          quotaRestored: false,
        };
      }
      return { status: { ...prev, ...lastGood, wakeAt: null }, quotaRestored: false };
    }
    case "claiming": {
      if (remaining > threshold) {
        return restored(prev.exhaustionCycleId);
      }
      if (!observation.hasClaimableCard && remaining <= 0) {
        return {
          status: { ...prev, ...lastGood, state: "waiting_reset", wakeAt: wakeAtFor() },
          quotaRestored: false,
        };
      }
      return { status: { ...prev, ...lastGood, wakeAt: null }, quotaRestored: false };
    }
    case "waiting_reset": {
      if (remaining > 0) {
        return restored(prev.exhaustionCycleId);
      }
      // 仍 ≈0：nextResetTime 后移（如重置卡改写锚点）或服务端未到点，刷新唤醒时刻。
      return {
        status: { ...prev, ...lastGood, wakeAt: wakeAtFor() },
        quotaRestored: false,
      };
    }
    case "restored": {
      // service 在发出事件后立即把 restored 折叠回 idle；此分支兜底处理残留观测。
      return {
        status: {
          ...prev,
          ...lastGood,
          state: remaining <= threshold ? "watching" : "idle",
          wakeAt: null,
        },
        quotaRestored: false,
      };
    }
    default: {
      return { status: { ...prev, ...lastGood }, quotaRestored: false };
    }
  }
}

/**
 * 轮询节奏（spec §3.1 表）。返回 null 表示不设周期定时器（idle/restored 被动）。
 * waiting_reset 由 wakeAt 驱动，不走该节奏。
 */
export function watchdogPollDelayMs(
  state: QuotaWatchdogState,
  remainingPercent: number | null,
): number | null {
  switch (state) {
    case "watching": {
      if (remainingPercent === null) return WATCHING_CADENCE_MIN_MS;
      const delay = remainingPercent * WATCHING_CADENCE_PERCENT_STEP_MS;
      return Math.min(Math.max(delay, WATCHING_CADENCE_MIN_MS), WATCHING_CADENCE_MAX_MS);
    }
    case "claiming":
      return CLAIMING_CADENCE_MS;
    case "waiting_reset":
    case "idle":
    case "restored":
    default:
      return null;
  }
}

/** waiting_reset 的下次唤醒延迟（wakeAt 驱动；至少 1s 防止空转）。 */
export function computeWakeDelayMs(wakeAt: number | null, now: number): number | null {
  if (wakeAt === null) return null;
  return Math.max(wakeAt - now, 1_000);
}

/** 主动状态（≤阈值）才允许触发 /opportunity 资格判断；idle/restored 绝不触发（spec §3.2）。 */
export function shouldAttemptOpportunityCall(
  state: QuotaWatchdogState,
  cooldownUntil: number,
  now: number,
): boolean {
  const activeStates: ReadonlyArray<QuotaWatchdogState> = [
    "watching",
    "claiming",
    "waiting_reset",
  ];
  return activeStates.includes(state) && now >= cooldownUntil;
}

/** /opportunity 结果 → 下次允许触发时刻（与 Coordinator 的 resolveOpportunityNextCheckAt 同构）。 */
export function nextOpportunityCooldownUntil(
  granted: boolean,
  nextTryAt: number | null,
  now: number,
): number {
  if (granted) return now + OPPORTUNITY_COOLDOWN_GRANTED_MS;
  if (nextTryAt !== null && Number.isFinite(nextTryAt) && nextTryAt > 0) {
    return Math.max(nextTryAt, now + OPPORTUNITY_COOLDOWN_MIN_RETRY_MS);
  }
  return now + OPPORTUNITY_COOLDOWN_GRANTED_MS;
}

/** 瞬时错误判定（移植 coordinator isOpportunityTransientError；services 无 DOM 依赖）。 */
export function isOpportunityTransientError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("coding_plan_reset_api_error:2007")) return true;
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  ) {
    return true;
  }
  return [
    "failed to fetch",
    "fetch failed",
    "network error",
    "network request failed",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "enotfound",
    "etimedout",
    "eai_again",
  ].some((fragment) => message.includes(fragment));
}

export function isOpportunityThrottleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("coding_plan_reset_opportunity_throttled") ||
    message.includes("coding_plan_reset_api_error:429")
  );
}

/**
 * 从 reset status 挑选可核销卡：优先 FIVE_HOUR（最小代价原则，WEEK 留给用户手动决策），
 * 同类多张取最早到期；全部过期返回 null。
 */
export function resolveClaimTarget(
  snapshot: CodingPlanResetStatusSnapshot,
  now: number,
): CodingPlanResetType | null {
  const usable = (cards: Array<{ expireAt: number }>): boolean =>
    cards.some((card) => card.expireAt > now);
  if (usable(snapshot.availableFiveHourResets)) return "FIVE_HOUR";
  if (usable(snapshot.availableWeekResets)) return "WEEK";
  return null;
}
