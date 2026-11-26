import type { CodingPlanResetType } from "@zcode/shared";
import {
  RESUME_CONTEXT_COMPACT_DELAY_MS,
  RESUME_QUOTA_WAKE_MARGIN_MS,
  RESUME_TRANSIENT_BACKOFF_MS,
  type CodingPlanResetStatusSnapshot,
  type QuotaWatchdogSettings,
  type QuotaWatchdogState,
  type ResumeIntentKind,
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
export function transitionOnObservationError(prev: WatchdogRuntimeStatus): WatchdogTransition {
  return {
    status: { ...prev, wakeAt: prev.state === "waiting_reset" ? prev.wakeAt : null },
    quotaRestored: false,
  };
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
        return {
          status: { ...prev, ...lastGood, state: "claiming", wakeAt: null },
          quotaRestored: false,
        };
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
  const activeStates: ReadonlyArray<QuotaWatchdogState> = ["watching", "claiming", "waiting_reset"];
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
export function hasUsableResetCard(
  snapshot: CodingPlanResetStatusSnapshot,
  resetType: CodingPlanResetType,
  now: number,
): boolean {
  const cards =
    resetType === "WEEK" ? snapshot.availableWeekResets : snapshot.availableFiveHourResets;
  return cards.some((card) => card.expireAt > now);
}

export function resolveClaimTarget(
  snapshot: CodingPlanResetStatusSnapshot,
  now: number,
): CodingPlanResetType | null {
  if (hasUsableResetCard(snapshot, "FIVE_HOUR", now)) return "FIVE_HOUR";
  if (hasUsableResetCard(snapshot, "WEEK", now)) return "WEEK";
  return null;
}

// ---- 失败归因与调度纯逻辑（docs/quota-watchdog/spec.md §9）----
// 无 IO、无时钟读取；全部可单测。service 只做编排。

/**
 * entitlement 快照的 remaining.percentage 承袭 quota 接口的"已用占比"（0–100），
 * 与 UI codingPlanQuotaPresentation.getQuotaRemainingPercentage 同口径反转为剩余占比。
 * v1 直接把它当剩余值比较，导致耗尽判定永不成立（watchdog 永远 idle、reset 卡从未被核销）。
 */
export function remainingPercentFromEntitlement(
  percentage: number | null | undefined,
): number | null {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
    return null;
  }
  const used = Math.max(0, Math.min(100, percentage));
  // 保留 3 位小数：避免 99.6 → 0.4000000000000057 这类浮点噪声进入日志与展示。
  return Math.round(Math.max(0, Math.min(100, 100 - used)) * 1000) / 1000;
}

/** 剩余占比 ≤ 该值视为额度耗尽（服务端已用占比在耗尽时可能停在 99.x 而非 100）。 */
export const QUOTA_EXHAUSTED_REMAINING_PERCENT = 1;

/** 额度观测结果：remainingPercent 为 null 表示不可知（调用方绝不能把"不可知"当成"已耗尽"）。 */
export interface QuotaUsageObservation {
  remainingPercent: number | null;
  exhausted: boolean;
  /** 下次重置时刻（Unix 毫秒）；未知为 null。 */
  nextResetTime: number | null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 从 entitlement 快照求"最紧的额度桶"剩余占比。优先 quota.limits[]（逐桶取最小，
 * 5 小时桶与周桶任何一个见底都算耗尽），回退 remaining.percentage（已用占比）。
 */
export function observeQuotaUsage(
  snapshot:
    | {
        quota?: {
          limits?: Array<{
            percentage?: number;
            remaining?: number;
            number?: number;
            nextResetTime?: number;
          }>;
        } | null;
        remaining?: { percentage?: number; nextResetTime?: number | null } | null;
      }
    | null
    | undefined,
): QuotaUsageObservation {
  const limits = snapshot?.quota?.limits ?? [];
  let remainingPercent: number | null = null;
  let nextResetTime: number | null = finitePositive(snapshot?.remaining?.nextResetTime);
  for (const limit of limits) {
    const reset = finitePositive(limit.nextResetTime);
    if (reset !== null)
      nextResetTime = nextResetTime === null ? reset : Math.min(nextResetTime, reset);
    let bucketRemaining: number | null = null;
    if (typeof limit.percentage === "number" && Number.isFinite(limit.percentage)) {
      bucketRemaining = remainingPercentFromEntitlement(limit.percentage);
    } else if (
      typeof limit.remaining === "number" &&
      Number.isFinite(limit.remaining) &&
      finitePositive(limit.number) !== null
    ) {
      bucketRemaining = Math.max(
        0,
        Math.min(100, (limit.remaining / (limit.number as number)) * 100),
      );
    }
    if (bucketRemaining !== null) {
      remainingPercent =
        remainingPercent === null ? bucketRemaining : Math.min(remainingPercent, bucketRemaining);
    }
  }
  if (remainingPercent === null) {
    remainingPercent = remainingPercentFromEntitlement(snapshot?.remaining?.percentage);
  }
  return {
    remainingPercent,
    exhausted: remainingPercent !== null && remainingPercent <= QUOTA_EXHAUSTED_REMAINING_PERCENT,
    nextResetTime,
  };
}

/** 重置卡救不了的额度类：1309 套餐到期、1311 套餐无模型权限、1313 fair usage restriction。 */
export const RESUME_NO_CARD_QUOTA_CODES: ReadonlySet<string> = new Set(["1309", "1311", "1313"]);
/** 周/月额度上限：只有 WEEK 卡能恢复；FIVE_HOUR 卡对它无效，禁止误烧。 */
export const RESUME_WEEK_CAP_CODES: ReadonlySet<string> = new Set(["1310"]);
/** 文档明确"重置卡可恢复"的用量上限（1308 = 使用量上限 / 5 小时窗口）。 */
export const RESUME_FIVE_HOUR_CAP_CODES: ReadonlySet<string> = new Set(["1308"]);

/** 终端额度类 provider 业务码：等重置或核销卡（docs/bigmodel-business-error-retry.md）。 */
export const RESUME_USAGE_LIMIT_CODES: ReadonlySet<string> = new Set([
  "1005",
  "1304",
  "1308",
  "1309",
  "1310",
  "1311",
  "1313",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);
/** 套餐到期（无任何自动动作）。 */
export const RESUME_PLAN_EXPIRED_CODES: ReadonlySet<string> = new Set(["1309"]);
/** 限流/过载类：轮内重试预算耗尽后按退避自动续跑（1305 = 平台流量限制或过载）。 */
export const RESUME_RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  "429",
  "1120",
  "1230",
  "1234",
  "1302",
  "1303",
  "1305",
  "1312",
  "3002",
  "2007",
  "rate_limit_reached_error",
  "rate_limit_error",
  "overloaded_error",
  "engine_overloaded_error",
]);
/** 上下文超窗：先 /compact 再续跑一次。 */
export const RESUME_CONTEXT_OVERFLOW_CODES: ReadonlySet<string> = new Set([
  "1261",
  "model_context_exceeded",
]);
/** 可自动续跑的 CLI 归类码（contracts ModelErrorCode）。 */
export const RESUME_TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "model_rate_limited",
  "model_request_timeout",
  "invalid_model_response",
]);
/** 不可自动恢复的 CLI 归类码：重试只会重复失败，直接交还用户。 */
export const RESUME_NON_RECOVERABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_model_selection",
  "model_config_missing",
  "provider_not_found",
  "provider_not_configured",
  "model_not_found",
  "invalid_model_request",
  "model_request_auth_missing",
  "model_request_cancelled",
]);

/** CLI attribution.reason（ModelFailureReason）。 */
const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  "rate_limited",
  "provider_overloaded",
  "server_error",
  "network_error",
  "timeout",
  "stream_idle_timeout",
  "stale_connection",
  "auth_refresh",
  "proxy_error",
]);
const NON_RECOVERABLE_REASONS: ReadonlySet<string> = new Set([
  "auth_failed",
  "cancelled",
  "invalid_request",
  "provider_not_configured",
  "tls_error",
]);

export type ResumeFailureClassification =
  | "quota"
  | "plan_expired"
  | "context"
  | "transient"
  | "non_recoverable";

export interface TurnFailureInput {
  /** CLI 归类码（ModelErrorCode）或外层错误码。 */
  code?: string | null;
  /** provider 业务码（attribution.providerErrorCode）——额度/限流的权威判据。 */
  providerErrorCode?: string | null;
  message?: string | null;
  attributionReason?: string | null;
  /** attribution.source 或 SessionErrorInfo.source。 */
  source?: string | null;
}

const CONTEXT_MESSAGE =
  /context[ _-]?(length|window|overflow|limit|exceed)|prompt is too long|max_tokens|input length|too many tokens|compact (failed|rapid refill)|超出.{0,8}(上下文|长度)/i;
const AUTH_MESSAGE =
  /invalid api key|unauthori[sz]ed|authentication|\b40[13]\b|forbidden|permission denied|鉴权|认证失败/i;
const PLAN_EXPIRED_MESSAGE =
  /plan (has )?expired|subscription expired|coding plan .*(expired|到期)|套餐.{0,6}(到期|过期)/i;
const QUOTA_MESSAGE =
  /exceed (quota )?limit|quota exceeded|insufficient quota|credit balance|usage limit|balance exhausted|额度不足|用量上限|达到.{0,10}上限/i;
const TRANSIENT_MESSAGE =
  /rate limit|too many requests|overload|timed? ?out|timeout|network|econn(reset|refused)|socket hang up|fetch failed|service unavailable|bad gateway|gateway timeout|internal server error|\b(429|50[0234])\b|temporarily|try again|限流|频率|过载|超时|网络/i;

/**
 * 失败权威归类。优先级：provider 业务码 > CLI 归类码 > attribution.reason > source=network >
 * 消息文本。CLI 对 1305 与 1308 发布同一套通用 reason（rate_limited 类），因此额度类与限流类
 * 只能靠 provider 业务码区分——调用方必须尽可能透传 providerErrorCode。
 * 返回 null = 无法归因（不建意图）；non_recoverable = 自动重试无意义。
 */
export function classifyTurnFailure(input: TurnFailureInput): ResumeFailureClassification | null {
  const providerCode = input.providerErrorCode?.trim() ?? "";
  if (providerCode) {
    if (RESUME_PLAN_EXPIRED_CODES.has(providerCode)) return "plan_expired";
    if (RESUME_USAGE_LIMIT_CODES.has(providerCode)) return "quota";
    if (RESUME_CONTEXT_OVERFLOW_CODES.has(providerCode)) return "context";
    if (RESUME_RATE_LIMIT_CODES.has(providerCode)) return "transient";
  }
  const code = input.code?.trim() ?? "";
  if (providerCode === "" && code) {
    if (RESUME_PLAN_EXPIRED_CODES.has(code)) return "plan_expired";
    if (RESUME_USAGE_LIMIT_CODES.has(code)) return "quota";
    if (RESUME_CONTEXT_OVERFLOW_CODES.has(code)) return "context";
    if (RESUME_RATE_LIMIT_CODES.has(code)) return "transient";
    if (RESUME_NON_RECOVERABLE_ERROR_CODES.has(code)) return "non_recoverable";
    if (RESUME_TRANSIENT_ERROR_CODES.has(code)) return "transient";
  }
  const reason = input.attributionReason?.trim() ?? "";
  if (reason) {
    if (reason === "context_exceeded") return "context";
    if (reason === "quota_exhausted") return "quota";
    if (NON_RECOVERABLE_REASONS.has(reason)) return "non_recoverable";
    if (TRANSIENT_REASONS.has(reason)) return "transient";
  }
  const message = input.message ?? "";
  if (AUTH_MESSAGE.test(message)) return "non_recoverable";
  if (CONTEXT_MESSAGE.test(message)) return "context";
  if (PLAN_EXPIRED_MESSAGE.test(message)) return "plan_expired";
  if (QUOTA_MESSAGE.test(message)) return "quota";
  if (input.source === "network") return "transient";
  if (TRANSIENT_MESSAGE.test(message)) return "transient";
  return null;
}

/**
 * 失败 → 允许核销的卡型。只有额度类允许烧卡（卡是稀缺资源：限流等 1 分钟即恢复、
 * 上下文溢出靠 /compact、套餐到期/fair usage 卡救不了）。
 * - 1310 周/月上限：只认 WEEK 卡（FIVE_HOUR 卡对它无效）。
 * - 其余额度类：FIVE_HOUR 优先（最小代价），无 5 小时卡时回退 WEEK。
 */
export function claimTargetForFailure(
  classification: ResumeFailureClassification | null,
  providerCode: string | null | undefined,
  snapshot: CodingPlanResetStatusSnapshot,
  now: number,
): CodingPlanResetType | null {
  if (classification !== "quota") return null;
  const code = providerCode?.trim() ?? "";
  if (code && RESUME_NO_CARD_QUOTA_CODES.has(code)) return null;
  if (code && RESUME_WEEK_CAP_CODES.has(code)) {
    return hasUsableResetCard(snapshot, "WEEK", now) ? "WEEK" : null;
  }
  return resolveClaimTarget(snapshot, now);
}
/** 同一 task 同签名的失败在该窗口内只处理一次（detector / 结局通道 / renderer 上报描述同一次失败）。 */
export const RESUME_FAILURE_DEDUPE_WINDOW_MS = 5_000;
/** renderer 上报的失败超过该时长视为陈旧重放（重新挂载的 SessionPane 会重报旧错误），不建意图。 */
export const RESUME_REPORT_FRESH_WINDOW_MS = 60_000;
/** 任务仍在活动（用户已接管 / 自发 compact 在跑）时的重排间隔；持续超过上限即取消意图。 */
export const RESUME_ACTIVE_DEFER_MS = 60_000;
export const RESUME_ACTIVE_DEFER_LIMIT_MS = 2 * 60 * 60_000;

// ---- 调度阶梯（纯函数）----

/** 派发 turn 在该时长内就以额度类失败 = 额度并未恢复（核销生效延迟 / 快照滞后）。 */
export const RESUME_FAST_FAIL_WINDOW_MS = 20_000;
/** 额度未恢复时的探测退避：1 → 5 → 15 → 30 分钟（封顶 30 分钟，绝不定点死等）。 */
export const RESUME_QUOTA_PROBE_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
] as const;
/** 已知耗尽时的最长复核间隔：nextResetTime 可能数小时外，期间每 10 分钟复核一次
 *  （卡可能出现、服务端可能提前恢复、快照可能滞后）。复核只读快照，不派发空转 turn。 */
export const RESUME_QUOTA_MAX_RECHECK_MS = 10 * 60_000;
/** 派发本身失败（session 未加载/命令被拒）的重试间隔；不消耗 attempt。 */
export const RESUME_DISPATCH_RETRY_MS = 30_000;
/** 连续派发失败上限，超过即 exhausted（session 已删除等永久性失败）。 */
export const RESUME_MAX_DISPATCH_ERRORS = 10;
/** 核销冷却：/use 之后 entitlement 快照可能仍是耗尽态缓存，冷却内不得据快照再次烧卡。 */
export const RESUME_CLAIM_COOLDOWN_MS = 10 * 60_000;
/** 核销成功后到续派发的间隔（给服务端额度生效留余量）。 */
export const RESUME_AFTER_CLAIM_DELAY_MS = 10_000;
/** 自发 /compact 后等待其落地的轮询间隔。 */
export const RESUME_COMPACT_WAIT_MS = 15_000;

export function quotaProbeDelayMs(fastFails: number): number {
  const index = Math.max(
    0,
    Math.min(Math.floor(fastFails) - 1, RESUME_QUOTA_PROBE_BACKOFF_MS.length - 1),
  );
  return RESUME_QUOTA_PROBE_BACKOFF_MS[index] as number;
}

/** 瞬时类第 attempt+1 次续跑的等待：1 → 5 → 15 分钟（之后封顶 15 分钟，由 maxConsecutive 收口）。 */
export function transientRetryDelayMs(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), RESUME_TRANSIENT_BACKOFF_MS.length - 1));
  return RESUME_TRANSIENT_BACKOFF_MS[index] as number;
}

/** 已知耗尽时的下次复核时刻：min(nextReset + 裕量, now + 最长复核间隔)。 */
export function resolveExhaustedRecheckAt(nextResetTime: number | null, now: number): number {
  const resetAt =
    nextResetTime === null ? Infinity : Math.max(nextResetTime, now) + RESUME_QUOTA_WAKE_MARGIN_MS;
  return Math.min(resetAt, now + RESUME_QUOTA_MAX_RECHECK_MS);
}
