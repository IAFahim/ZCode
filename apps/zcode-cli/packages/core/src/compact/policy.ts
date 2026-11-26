import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens, hasEnoughMessagesToCompact } from "./manual.js";
import type { LocalMicrocompactPolicyConfig } from "./microcompact.js";

export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
// 正常请求默认输出已收敛到 32K，auto compact 必须预留同一目标；
// 否则请求预算和压缩窗口会继续按两套常量计算。
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
export const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const AUTOCOMPACT_OUTPUT_RESERVE_CONTEXT_WINDOW_RATIO = 0.08;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export interface AutoCompactPolicyConfig {
  enabled?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  summaryReserveTokens?: number;
  bufferTokens?: number;
  /** 旧字段：已刻意停用（见 compact-policy.test.ts「旧 percent override 不再改变统一算法」），勿复用。 */
  thresholdPercentOverride?: number;
  /**
   * 用户可调压缩触发点（context bar 的百分比，1–100）。设置后阈值 =
   * min(floor(完整上下文窗口 × pct / 100), 统一算法阈值)：
   * 分母与 context bar 一致（窗口的一半就是 50% 处），上限保证不会晚于默认算法。
   * 未设置（或 100）时保持统一算法（effective − buffer）。
   */
  usagePercentTrigger?: number;
  maxConsecutiveFailures?: number;
  microcompact?: LocalMicrocompactPolicyConfig;
}

export type AutoCompactTokenSource = "estimate" | "provider_usage";

export interface AutoCompactTokenOverride {
  baseTokenCount?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokenCount?: number;
  incrementalTokenCount?: number;
  outputTokens?: number;
  source: Extract<AutoCompactTokenSource, "provider_usage">;
  tokenCount: number;
}

export interface AutoCompactDecision {
  shouldCompact: boolean;
  tokenCount: number;
  tokenSource: AutoCompactTokenSource;
  estimatedTokenCount: number;
  providerCacheReadTokens?: number;
  providerCacheWriteTokens?: number;
  providerBaseTokenCount?: number;
  providerContextUsageTokenCount?: number;
  providerIncrementalTokenCount?: number;
  providerOutputTokens?: number;
  threshold: number;
  contextWindow: number;
  effectiveContextWindow: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1";
  outputReserveTokens: number;
  thresholdPercent: number;
  reason:
    | "disabled"
    | "not_enough_messages"
    | "circuit_breaker"
    | "below_threshold"
    | "above_threshold";
}

export function getEffectiveContextWindowSize(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  // provider 的 context window 是 input + output 共享窗口；自动压缩只能让出输入侧，
  // 因此阈值分母必须先扣掉当前模型允许的 output token，而不是继续吃完整 contextWindow。
  const reserve = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  return Math.max(0, contextWindow - reserve);
}

export function getAutoCompactOutputReserveTokens(config: AutoCompactPolicyConfig = {}): number {
  const maxOutputTokens = positiveInt(config.maxOutputTokens);
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  // 旧 legacy 分支为完整模型输出预留窗口，既过早压缩又要求远端选择；现在至少保留 21K。
  // 修复原因：reserve 曾固定 21K、摘要固定封顶 20K，1M 窗口模型在约 96 万输入时才压缩，
  // 推理和摘要挤在 20K 里常被 length 截断。摘要上限现在等于 reserve，所以大窗口按窗口
  // 比例加大 reserve；不超过 262.5K 的窗口仍是 21K。
  const windowReserve = Math.max(
    PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
    Math.floor(contextWindow * AUTOCOMPACT_OUTPUT_RESERVE_CONTEXT_WINDOW_RATIO),
  );
  return Math.min(maxOutputTokens ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS, windowReserve);
}

export function getAutoCompactThreshold(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const buffer = positiveInt(config.bufferTokens) ?? AUTOCOMPACT_BUFFER_TOKENS;
  // 统一算法的最晚触发点：有效窗口（已扣输出预留）再留 buffer，压缩摘要与模型输出都有余量。
  const latest = Math.max(0, effectiveContextWindow - buffer);
  const triggerPercent = config.usagePercentTrigger;
  if (
    typeof triggerPercent === "number" &&
    Number.isFinite(triggerPercent) &&
    triggerPercent > 0 &&
    triggerPercent < 100
  ) {
    // Bugfix：百分比曾以"有效窗口"为分母（1M 窗口下 50% 实际在 46 万处触发），与 context bar
    // 显示的 335.6K/1M 口径不一致——用户选 50% 就是期望在一半窗口处压缩。改为按完整窗口取值，
    // 并以统一算法阈值为上限。
    return Math.max(0, Math.min(latest, Math.floor((contextWindow * triggerPercent) / 100)));
  }
  return latest;
}

export function shouldAutoCompact(input: {
  messages: readonly CompactModelMessage[];
  config?: AutoCompactPolicyConfig;
  consecutiveFailures?: number;
  tokenOverride?: AutoCompactTokenOverride;
  /** 调用方按存储的条目判断历史是否够压缩；不传时按 messages 判断。 */
  hasEnoughHistory?: boolean;
}): AutoCompactDecision {
  const config = input.config ?? {};
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const outputReserveTokens = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  const threshold = getAutoCompactThreshold(config);
  const thresholdPercent = DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT;
  const estimatedTokenCount = estimateMessageTokens(input.messages);
  const tokenCount = input.tokenOverride?.tokenCount ?? estimatedTokenCount;
  const tokenSource = input.tokenOverride?.source ?? "estimate";
  const common = {
    contextWindow,
    effectiveContextWindow,
    estimatedTokenCount,
    providerCacheReadTokens: input.tokenOverride?.cacheReadTokens,
    providerCacheWriteTokens: input.tokenOverride?.cacheWriteTokens,
    maxOutputTokens: positiveInt(config.maxOutputTokens),
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    outputReserveTokens,
    providerBaseTokenCount: input.tokenOverride?.baseTokenCount,
    providerContextUsageTokenCount: input.tokenOverride?.contextUsageTokenCount,
    providerIncrementalTokenCount: input.tokenOverride?.incrementalTokenCount,
    providerOutputTokens: input.tokenOverride?.outputTokens,
    threshold,
    thresholdPercent,
    tokenCount,
    tokenSource,
  } satisfies Omit<AutoCompactDecision, "reason" | "shouldCompact">;

  if (config.enabled === false) {
    return { ...common, shouldCompact: false, reason: "disabled" };
  }

  if (!(input.hasEnoughHistory ?? hasEnoughMessagesToCompact(input.messages))) {
    return {
      ...common,
      shouldCompact: false,
      reason: "not_enough_messages",
    };
  }

  const maxFailures =
    positiveInt(config.maxConsecutiveFailures) ?? MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
  if ((input.consecutiveFailures ?? 0) >= maxFailures) {
    return {
      ...common,
      shouldCompact: false,
      reason: "circuit_breaker",
    };
  }

  if (tokenCount < threshold) {
    return {
      ...common,
      shouldCompact: false,
      reason: "below_threshold",
    };
  }

  return { ...common, shouldCompact: true, reason: "above_threshold" };
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
