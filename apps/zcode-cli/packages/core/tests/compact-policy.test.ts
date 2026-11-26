import { describe, expect, it } from "vitest";

import {
  estimateMessageTokens,
  getAutoCompactOutputReserveTokens,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  shouldAutoCompact,
} from "../src/compact/index.js";
import {
  resolveModelStepMaxOutputTokens,
  resolveNormalRequestMaxOutputTokens,
} from "../src/runtime/methods/model-token-limits.js";
import { getAutoCompactPolicy, updateConfig } from "../src/runtime/methods/config.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

const ENOUGH_MESSAGES = [
  { role: "user" as const, content: "old context" },
  { role: "assistant" as const, content: "old answer" },
];

describe("auto compact policy", () => {
  // 运行中即时应用（v4 setAutoCompactPolicy → runtime.updateConfig({ compact })）：
  // 策略每个模型步从 runtime.config.compact 重新读取，所以写入后下一个模型步就按新阈值判断。
  it("updateConfig(compact) 后阈值立即变化；原地更新保持对象引用；调回 100 清掉旧阈值", () => {
    const runtime = {
      config: { compact: { enabled: true, usagePercentTrigger: 50 } },
    } as unknown as AgentRuntimeInternal;
    const held = runtime.config.compact;
    const window = { contextWindow: 1_000_000, maxOutputTokens: 128_000 };
    const thresholdNow = () => getAutoCompactThreshold({ ...window, ...runtime.config.compact });
    expect(thresholdNow()).toBe(500_000);

    updateConfig.call(runtime, { compact: { enabled: true, usagePercentTrigger: 10 } });
    // context builder 等处可能持有同一引用：必须是原地更新。
    expect(runtime.config.compact).toBe(held);
    expect(thresholdNow()).toBe(100_000);
    expect(getAutoCompactPolicy.call(runtime)).toEqual({
      enabled: true,
      usagePercentTrigger: 10,
    });

    updateConfig.call(runtime, { compact: { enabled: true } });
    expect(runtime.config.compact).toBe(held);
    expect(thresholdNow()).toBe(907_000);
    expect(getAutoCompactPolicy.call(runtime)).toEqual({ enabled: true });
  });

  it("运行中关闭后不再压缩、重新开启并调低阈值后提前压缩", () => {
    const runtime = { config: {} } as unknown as AgentRuntimeInternal;
    const window = { contextWindow: 200_000, maxOutputTokens: 32_000 };
    const decide = (tokenCount: number) =>
      shouldAutoCompact({
        config: { ...window, ...runtime.config.compact },
        messages: ENOUGH_MESSAGES,
        tokenOverride: { source: "provider_usage", tokenCount },
      });
    // 默认（统一算法）阈值 166k：150k 还不压缩。
    expect(decide(170_000).shouldCompact).toBe(true);
    expect(decide(150_000)).toMatchObject({ reason: "below_threshold", shouldCompact: false });

    updateConfig.call(runtime, { compact: { enabled: false } });
    expect(decide(190_000)).toMatchObject({ reason: "disabled", shouldCompact: false });

    updateConfig.call(runtime, { compact: { enabled: true, usagePercentTrigger: 50 } });
    expect(decide(150_000)).toMatchObject({ shouldCompact: true, threshold: 100_000 });
  });
  it("counts reasoning blocks in the local fallback estimate", () => {
    expect(
      estimateMessageTokens([
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "r".repeat(40) }],
        },
      ]),
    ).toBe(14);
    expect(
      estimateMessageTokens([
        {
          role: "assistant",
          content: [
            { type: "text", text: "text" },
            { type: "reasoning", text: "think" },
          ],
        },
      ]),
    ).toBe(4);
  });

  it("uses reasoning-inclusive fallback only when provider usage is unavailable", () => {
    const messages = [
      { role: "user" as const, content: "u" },
      {
        role: "assistant" as const,
        content: [{ type: "reasoning" as const, text: "r".repeat(4_000) }],
      },
    ];
    const config = {
      bufferTokens: 1_000,
      contextWindow: 3_000,
      maxOutputTokens: 1_000,
      modelContextBudgetStrategy: "preflight-v1" as const,
    };

    expect(shouldAutoCompact({ config, messages })).toMatchObject({
      estimatedTokenCount: 1_335,
      reason: "above_threshold",
      shouldCompact: true,
      tokenCount: 1_335,
      tokenSource: "estimate",
    });
    expect(
      shouldAutoCompact({
        config,
        messages,
        tokenOverride: { source: "provider_usage", tokenCount: 999 },
      }),
    ).toMatchObject({
      estimatedTokenCount: 1_335,
      reason: "below_threshold",
      shouldCompact: false,
      tokenCount: 999,
      tokenSource: "provider_usage",
    });
  });

  it("uses explicit output token reserve when it is below the compact cap", () => {
    const config = {
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(16_000);
    expect(getEffectiveContextWindowSize(config)).toBe(184_000);
    expect(getAutoCompactThreshold(config)).toBe(171_000);
  });

  it("uses small effective output limits without raising them to the default", () => {
    const config = {
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(8_000);
    expect(getEffectiveContextWindowSize(config)).toBe(192_000);
    expect(getAutoCompactThreshold(config)).toBe(179_000);
  });

  it("defaults to preflight-v1 when the effective output target is unknown", () => {
    const config = {
      contextWindow: 200_000,
    };

    expect(getEffectiveContextWindowSize(config)).toBe(179_000);
    expect(getAutoCompactThreshold(config)).toBe(166_000);
  });

  it("OTB06 兼容 legacy 输入也使用 21k reserve 和 94k threshold", () => {
    const config = {
      contextWindow: 128_000,
      maxOutputTokens: 64_000,
      modelContextBudgetStrategy: "legacy" as const,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(21_000);
    expect(getEffectiveContextWindowSize(config)).toBe(107_000);
    expect(getAutoCompactThreshold(config)).toBe(94_000);
  });

  it("OTB08 defaults to preflight-v1, preserves 21k, and removes the 95 percent threshold", () => {
    const config = {
      contextWindow: 128_000,
      maxOutputTokens: 64_000,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(21_000);
    expect(getEffectiveContextWindowSize(config)).toBe(107_000);
    expect(getAutoCompactThreshold(config)).toBe(94_000);
    expect(
      shouldAutoCompact({
        config,
        messages: ENOUGH_MESSAGES,
        tokenOverride: { source: "provider_usage", tokenCount: 94_000 },
      }),
    ).toMatchObject({
      effectiveContextWindow: 107_000,
      modelContextBudgetStrategy: "preflight-v1",
      outputReserveTokens: 21_000,
      shouldCompact: true,
      threshold: 94_000,
      thresholdPercent: 100,
    });
  });

  it("keeps output reserves below 21k unchanged for preflight-v1", () => {
    const config = {
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      modelContextBudgetStrategy: "preflight-v1" as const,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(16_000);
    expect(getEffectiveContextWindowSize(config)).toBe(112_000);
    expect(getAutoCompactThreshold(config)).toBe(99_000);
  });

  it("兼容 legacy 输入仍以 preflight 阈值压缩并记录真实策略", () => {
    const below = shouldAutoCompact({
      config: {
        contextWindow: 128_000,
        maxOutputTokens: 32_000,
        modelContextBudgetStrategy: "legacy",
      },
      messages: ENOUGH_MESSAGES,
      tokenOverride: {
        source: "provider_usage",
        tokenCount: 93_999,
      },
    });
    const above = shouldAutoCompact({
      config: {
        contextWindow: 128_000,
        maxOutputTokens: 32_000,
        modelContextBudgetStrategy: "legacy",
      },
      messages: ENOUGH_MESSAGES,
      tokenOverride: {
        source: "provider_usage",
        tokenCount: 94_000,
      },
    });

    expect(below).toMatchObject({
      effectiveContextWindow: 107_000,
      outputReserveTokens: 21_000,
      reason: "below_threshold",
      threshold: 94_000,
    });
    expect(above).toMatchObject({
      reason: "above_threshold",
      shouldCompact: true,
      thresholdPercent: 100,
      modelContextBudgetStrategy: "preflight-v1",
    });
  });

  it("usagePercentTrigger：阈值按完整上下文窗口的百分比取值（与 context bar 同分母），钳制在统一算法阈值以内", () => {
    // 200k 窗口：reserve = max(21k, 8%×200k=16k) = 21k → 有效 179k；统一算法阈值 = 179k − 13k = 166k。
    // 75% = 完整窗口的 75% = 150k（曾按有效窗口算成 134,250，与 context bar 的 200k 分母不一致）。
    expect(
      getAutoCompactThreshold({
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        usagePercentTrigger: 75,
      }),
    ).toBe(150_000);
    // 高百分比被统一算法阈值（166k）钳制，绝不晚于默认压缩。
    expect(
      getAutoCompactThreshold({
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        usagePercentTrigger: 95,
      }),
    ).toBe(166_000);
    // 100 视为未设置（走统一算法），非法值同样忽略。
    expect(
      getAutoCompactThreshold({
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        usagePercentTrigger: 100,
      }),
    ).toBe(166_000);
    expect(
      getAutoCompactThreshold({
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        usagePercentTrigger: Number.NaN,
      }),
    ).toBe(166_000);
    // shouldAutoCompact 尊重该阈值。50% = 200k 的一半。
    const config = { contextWindow: 200_000, maxOutputTokens: 32_000, usagePercentTrigger: 50 };
    expect(getAutoCompactThreshold(config)).toBe(100_000);
    expect(
      shouldAutoCompact({
        config,
        messages: ENOUGH_MESSAGES,
        tokenOverride: { source: "provider_usage", tokenCount: 99_999 },
      }),
    ).toMatchObject({ reason: "below_threshold", threshold: 100_000 });
    expect(
      shouldAutoCompact({
        config,
        messages: ENOUGH_MESSAGES,
        tokenOverride: { source: "provider_usage", tokenCount: 100_000 },
      }),
    ).toMatchObject({ reason: "above_threshold", shouldCompact: true, threshold: 100_000 });
    // 1M 窗口（reserve = 8% = 80k，统一算法阈值 907k）：50% 就是一半窗口，10% 也能表达。
    const million = { contextWindow: 1_000_000, maxOutputTokens: 128_000 };
    expect(getAutoCompactThreshold({ ...million, usagePercentTrigger: 50 })).toBe(500_000);
    expect(getAutoCompactThreshold({ ...million, usagePercentTrigger: 10 })).toBe(100_000);
    expect(getAutoCompactThreshold({ ...million, usagePercentTrigger: 99 })).toBe(907_000);
    // 关闭时无论阈值如何都不压缩。
    expect(
      shouldAutoCompact({
        config: { ...config, enabled: false },
        messages: ENOUGH_MESSAGES,
        tokenOverride: { source: "provider_usage", tokenCount: 150_000 },
      }),
    ).toMatchObject({ reason: "disabled", shouldCompact: false });
  });

  it("旧 percent override 不再改变统一算法", () => {
    expect(
      getAutoCompactThreshold({
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        modelContextBudgetStrategy: "legacy",
        thresholdPercentOverride: 50,
      }),
    ).toBe(166_000);
  });

  it.each([
    // 8% 不足 21K 时保持 21K，阈值与旧算法相同。
    { contextWindow: 262_500, maxOutputTokens: 128_000, reserve: 21_000, threshold: 228_500 },
    { contextWindow: 500_000, maxOutputTokens: 128_000, reserve: 40_000, threshold: 447_000 },
    { contextWindow: 1_000_000, maxOutputTokens: 128_000, reserve: 80_000, threshold: 907_000 },
    // 比例 reserve 仍不超过模型输出上限。
    { contextWindow: 1_000_000, maxOutputTokens: 64_000, reserve: 64_000, threshold: 923_000 },
  ])(
    "reserves max(21K, 8% of $contextWindow) capped by $maxOutputTokens",
    ({ contextWindow, maxOutputTokens, reserve, threshold }) => {
      const config = { contextWindow, maxOutputTokens };

      expect(getAutoCompactOutputReserveTokens(config)).toBe(reserve);
      expect(getEffectiveContextWindowSize(config)).toBe(contextWindow - reserve);
      expect(getAutoCompactThreshold(config)).toBe(threshold);
      expect(
        shouldAutoCompact({
          config,
          messages: ENOUGH_MESSAGES,
          tokenOverride: { source: "provider_usage", tokenCount: threshold },
        }),
      ).toMatchObject({ outputReserveTokens: reserve, shouldCompact: true, threshold });
    },
  );

  it("surfaces provider context usage as the token count truth source", () => {
    const decision = shouldAutoCompact({
      config: {
        contextWindow: 200_000,
        maxOutputTokens: 131_072,
      },
      messages: ENOUGH_MESSAGES,
      tokenOverride: {
        contextUsageTokenCount: 170_000,
        incrementalTokenCount: 1_000,
        source: "provider_usage",
        tokenCount: 171_000,
      },
    });

    expect(decision).toMatchObject({
      providerContextUsageTokenCount: 170_000,
      providerIncrementalTokenCount: 1_000,
      reason: "above_threshold",
      shouldCompact: true,
      tokenCount: 171_000,
    });
  });
});

describe("normal request output target", () => {
  it.each([
    { caseId: "OTB01", expected: 32_000, modelLimit: undefined },
    { caseId: "OTB02", expected: 16_000, modelLimit: 16_000 },
    { caseId: "OTB03", expected: 64_000, modelLimit: 64_000 },
    { caseId: "invalid zero", expected: 32_000, modelLimit: 0 },
    { caseId: "invalid negative", expected: 32_000, modelLimit: -1 },
    { caseId: "invalid non-finite", expected: 32_000, modelLimit: Number.NaN },
  ])("$caseId resolves model limit $modelLimit to $expected", ({ expected, modelLimit }) => {
    expect(
      resolveNormalRequestMaxOutputTokens({
        modelMaxOutputTokens: modelLimit,
      }),
    ).toBe(expected);
  });

  it.each([
    { available: 62_999, expected: 62_999 },
    { available: 3_000, expected: 3_000 },
    { available: 2_999, expected: 2_999 },
    { available: 1, expected: 1 },
    { available: 0, expected: 64_000 },
    { available: -1, expected: 64_000 },
  ])("preflight-v1 sends the positive available budget $available", ({ available, expected }) => {
    expect(
      resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens: 64_000,
        contextWindow: 128_000,
        estimatedCurrentUsage: 127_000 - available,
        modelContextBudgetStrategy: "preflight-v1",
      }),
    ).toBe(expected);
  });

  it("legacy 也应用 preflight cap，非法估算仍保留 baseline", () => {
    const common = {
      baselineMaxOutputTokens: 64_000,
      contextWindow: 128_000,
    };
    expect(
      resolveModelStepMaxOutputTokens({
        ...common,
        estimatedCurrentUsage: 64_001,
        modelContextBudgetStrategy: "legacy",
      }),
    ).toBe(62_999);
    expect(
      resolveModelStepMaxOutputTokens({
        ...common,
        estimatedCurrentUsage: Number.NaN,
        modelContextBudgetStrategy: "preflight-v1",
      }),
    ).toBe(64_000);
  });

  it("defaults a missing strategy to the preflight-v1 model-step cap", () => {
    expect(
      resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens: 64_000,
        contextWindow: 128_000,
        estimatedCurrentUsage: 64_001,
        modelContextBudgetStrategy: undefined,
      }),
    ).toBe(62_999);
  });

  it("keeps provider-specific reasoning out of the Core preflight calculation", () => {
    expect(
      resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens: 64_000,
        contextWindow: 128_000,
        estimatedCurrentUsage: 116_000,
        modelContextBudgetStrategy: "preflight-v1",
      }),
    ).toBe(11_000);
  });
});
