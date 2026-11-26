import { describe, expect, it } from "vitest";
import {
  claimTargetForFailure,
  classifyTurnFailure,
  computeWakeDelayMs,
  createInitialWatchdogStatus,
  isOpportunityTransientError,
  mayClaimCard,
  nextOpportunityCooldownUntil,
  observeQuotaUsage,
  planDispatchedFailureSettle,
  quotaProbeDelayMs,
  remainingPercentFromEntitlement,
  resolveClaimTarget,
  resolveExhaustedRecheckAt,
  resumeInitialDelayMs,
  transientRetryDelayMs,
  transitionWatchdogState,
  watchdogPollDelayMs,
  QUOTA_WATCHDOG_CLAIM_THRESHOLD_PERCENT,
  RESUME_AFTER_CLAIM_DELAY_MS,
  RESUME_PROGRESS_WINDOW_MS,
  RESUME_QUOTA_MAX_RECHECK_MS,
  WATCHING_CADENCE_MAX_MS,
  WATCHING_CADENCE_MIN_MS,
} from "@zcode/services/node";
import {
  QUOTA_WATCHDOG_DEFAULT_SETTINGS,
  RESUME_CONTEXT_COMPACT_DELAY_MS,
  RESUME_QUOTA_WAKE_MARGIN_MS,
  RESUME_TRANSIENT_BACKOFF_MS,
} from "@zcode/shared";

// 配额守护纯领域逻辑回归（docs/quota-watchdog/spec.md §3.1/§3.2）。

const SETTINGS = QUOTA_WATCHDOG_DEFAULT_SETTINGS;
const NOW = 1_700_000_000_000;
let cycleCounter = 0;
const nextCycleId = () => `cycle-${++cycleCounter}`;

function observation(overrides?: Partial<Parameters<typeof transitionWatchdogState>[1]>) {
  return {
    remainingPercent: null,
    nextResetTime: null,
    hasClaimableCard: false,
    ...overrides,
  };
}

describe("配额守护状态机", () => {
  it("idle：remaining ≤ 阈值进入 watching 并新建耗尽周期", () => {
    const result = transitionWatchdogState(
      createInitialWatchdogStatus(),
      observation({ remainingPercent: 10 }),
      SETTINGS,
      NOW,
      nextCycleId,
    );
    expect(result.status.state).toBe("watching");
    expect(result.status.exhaustionCycleId).toBe("cycle-1");
    expect(result.quotaRestored).toBe(false);
  });

  it("idle：remaining > 阈值保持被动，零新增周期请求", () => {
    const result = transitionWatchdogState(
      createInitialWatchdogStatus(),
      observation({ remainingPercent: 50 }),
      SETTINGS,
      NOW,
      nextCycleId,
    );
    expect(result.status.state).toBe("idle");
    expect(result.status.exhaustionCycleId).toBeNull();
  });

  it("watching：≤1% 且有卡进入 claiming", () => {
    const prev = {
      ...createInitialWatchdogStatus(),
      state: "watching" as const,
      exhaustionCycleId: "cycle-1",
    };
    const result = transitionWatchdogState(
      prev,
      observation({
        remainingPercent: QUOTA_WATCHDOG_CLAIM_THRESHOLD_PERCENT,
        hasClaimableCard: true,
      }),
      SETTINGS,
      NOW,
      nextCycleId,
    );
    expect(result.status.state).toBe("claiming");
  });

  it("watching：≤1% 无卡不进入 claiming（claim 线不看阈值设置）", () => {
    const prev = {
      ...createInitialWatchdogStatus(),
      state: "watching" as const,
      exhaustionCycleId: "cycle-1",
    };
    const result = transitionWatchdogState(
      prev,
      observation({ remainingPercent: 1, hasClaimableCard: false }),
      SETTINGS,
      NOW,
      nextCycleId,
    );
    expect(result.status.state).toBe("watching");
  });

  it("watching：0% 无卡进入 waiting_reset，wakeAt = nextResetTime + 裕量", () => {
    const prev = {
      ...createInitialWatchdogStatus(),
      state: "watching" as const,
      exhaustionCycleId: "cycle-1",
    };
    const nextResetTime = NOW + 60 * 60_000;
    const result = transitionWatchdogState(
      prev,
      observation({ remainingPercent: 0, nextResetTime }),
      SETTINGS,
      NOW,
      nextCycleId,
    );
    expect(result.status.state).toBe("waiting_reset");
    expect(result.status.wakeAt).toBe(nextResetTime + RESUME_QUOTA_WAKE_MARGIN_MS);
  });

  it("waiting_reset：唤醒后 remaining > 0 → RESTORED 恰好发一次并回到 idle 折叠", () => {
    const prev = {
      ...createInitialWatchdogStatus(),
      state: "waiting_reset" as const,
      exhaustionCycleId: "cycle-1",
      wakeAt: NOW - 1,
    };
    const result = transitionWatchdogState(
      prev,
      observation({ remainingPercent: 100 }),
      SETTINGS,
      NOW,
      nextCycleId,
    );
    expect(result.quotaRestored).toBe(true);
    expect(result.status.state).toBe("restored");
    expect(result.status.exhaustionCycleId).toBe("cycle-1");
  });

  it("waiting_reset：仍 ≈0 保持并刷新 wakeAt（重置锚点后移）", () => {
    const nextResetTime = NOW + 30 * 60_000;
    const prev = {
      ...createInitialWatchdogStatus(),
      state: "waiting_reset" as const,
      exhaustionCycleId: "cycle-1",
      wakeAt: NOW - 1,
    };
    const result = transitionWatchdogState(
      prev,
      observation({ remainingPercent: 0, nextResetTime }),
      SETTINGS,
      NOW,
      nextCycleId,
    );
    expect(result.status.state).toBe("waiting_reset");
    expect(result.status.wakeAt).toBe(nextResetTime + RESUME_QUOTA_WAKE_MARGIN_MS);
  });

  it("claiming：卡消失且 remaining ≈0 → waiting_reset", () => {
    const prev = {
      ...createInitialWatchdogStatus(),
      state: "claiming" as const,
      exhaustionCycleId: "cycle-1",
    };
    const result = transitionWatchdogState(
      prev,
      observation({ remainingPercent: 0, hasClaimableCard: false }),
      SETTINGS,
      NOW,
      nextCycleId,
    );
    expect(result.status.state).toBe("waiting_reset");
  });

  it("观测抛错（null）：任何状态都不迁移，保留 last-good", () => {
    const prev = {
      ...createInitialWatchdogStatus(),
      state: "watching" as const,
      exhaustionCycleId: "cycle-1",
      lastGoodRemainingPercent: 8,
    };
    const result = transitionWatchdogState(prev, observation(), SETTINGS, NOW, nextCycleId);
    expect(result.status.state).toBe("watching");
    expect(result.status.lastGoodRemainingPercent).toBe(8);
    expect(result.quotaRestored).toBe(false);
  });

  it("restored 兜底折叠：≤ 阈值回 watching，> 阈值回 idle", () => {
    const prev = {
      ...createInitialWatchdogStatus(),
      state: "restored" as const,
      exhaustionCycleId: "cycle-1",
    };
    expect(
      transitionWatchdogState(
        prev,
        observation({ remainingPercent: 5 }),
        SETTINGS,
        NOW,
        nextCycleId,
      ).status.state,
    ).toBe("watching");
    expect(
      transitionWatchdogState(
        prev,
        observation({ remainingPercent: 60 }),
        SETTINGS,
        NOW,
        nextCycleId,
      ).status.state,
    ).toBe("idle");
  });
});

describe("看门狗轮询节奏", () => {
  it("watching：clamp(remaining×30s, 20s, 2min)", () => {
    expect(watchdogPollDelayMs("watching", 0.5)).toBe(WATCHING_CADENCE_MIN_MS);
    expect(watchdogPollDelayMs("watching", 3)).toBe(90_000);
    expect(watchdogPollDelayMs("watching", 10)).toBe(WATCHING_CADENCE_MAX_MS);
  });

  it("claiming 固定 30s；idle/waiting_reset 不走周期节奏", () => {
    expect(watchdogPollDelayMs("claiming", 0.5)).toBe(30_000);
    expect(watchdogPollDelayMs("idle", 50)).toBeNull();
    expect(watchdogPollDelayMs("waiting_reset", 0)).toBeNull();
  });

  it("wakeAt 延迟至少 1s，null 不驱动", () => {
    expect(computeWakeDelayMs(null, NOW)).toBeNull();
    expect(computeWakeDelayMs(NOW - 10_000, NOW)).toBe(1_000);
    expect(computeWakeDelayMs(NOW + 5_000, NOW)).toBe(5_000);
  });
});

describe("重置卡认领与 /opportunity 冷却", () => {
  it("优先 FIVE_HOUR；全部过期返回 null；仅周卡可用时回退 WEEK", () => {
    expect(
      resolveClaimTarget(
        {
          availableFiveHourResets: [{ expireAt: NOW + 1_000 }],
          availableWeekResets: [{ expireAt: NOW + 2_000 }],
          latestFiveHourResetHistory: null,
          latestWeekResetHistory: null,
          hasUnreadHistory: false,
        },
        NOW,
      ),
    ).toBe("FIVE_HOUR");
    expect(
      resolveClaimTarget(
        {
          availableFiveHourResets: [{ expireAt: NOW - 1 }],
          availableWeekResets: [{ expireAt: NOW + 2_000 }],
          latestFiveHourResetHistory: null,
          latestWeekResetHistory: null,
          hasUnreadHistory: false,
        },
        NOW,
      ),
    ).toBe("WEEK");
    expect(
      resolveClaimTarget(
        {
          availableFiveHourResets: [{ expireAt: NOW - 1 }],
          availableWeekResets: [{ expireAt: NOW - 1 }],
          latestFiveHourResetHistory: null,
          latestWeekResetHistory: null,
          hasUnreadHistory: false,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("granted → +10min；denied 携带未来 nextTryAt → 取其值；过去时间至少 +5min", () => {
    expect(nextOpportunityCooldownUntil(true, null, NOW)).toBe(NOW + 10 * 60_000);
    expect(nextOpportunityCooldownUntil(false, NOW + 30 * 60_000, NOW)).toBe(NOW + 30 * 60_000);
    expect(nextOpportunityCooldownUntil(false, NOW - 1, NOW)).toBe(NOW + 5 * 60_000);
  });

  it("瞬时错误识别：网络中断/超时/2007 为瞬时，429 节流不是", () => {
    expect(isOpportunityTransientError(new Error("fetch failed"))).toBe(true);
    expect(isOpportunityTransientError(new Error("request timed out"))).toBe(true);
    expect(isOpportunityTransientError(new Error("coding_plan_reset_api_error:2007"))).toBe(true);
    expect(isOpportunityTransientError(new Error("coding_plan_reset_opportunity_throttled"))).toBe(
      false,
    );
    expect(isOpportunityTransientError(new Error("no_bigmodel_api_key"))).toBe(false);
  });
});

describe("v3 额度观测与失败归因（spec.md §9.1）", () => {
  it("remainingPercentFromEntitlement：快照已用占比反转为剩余占比（v1 未反转导致耗尽判定永不成立）", () => {
    expect(remainingPercentFromEntitlement(0)).toBe(100);
    expect(remainingPercentFromEntitlement(30)).toBe(70);
    expect(remainingPercentFromEntitlement(100)).toBe(0);
    expect(remainingPercentFromEntitlement(120)).toBe(0);
    expect(remainingPercentFromEntitlement(-5)).toBe(100);
    expect(remainingPercentFromEntitlement(null)).toBeNull();
    expect(remainingPercentFromEntitlement(undefined)).toBeNull();
    expect(remainingPercentFromEntitlement(Number.NaN)).toBeNull();
  });

  it("observeQuotaUsage：逐桶取最紧剩余；回退 remaining.percentage", () => {
    const resetA = NOW + 60 * 60_000;
    const resetB = NOW + 3 * 60 * 60_000;
    // 任一桶见底即耗尽，nextResetTime 取最早的桶。
    expect(
      observeQuotaUsage({
        quota: {
          limits: [
            { percentage: 30, nextResetTime: resetA },
            { percentage: 100, nextResetTime: resetB },
          ],
        },
        remaining: { percentage: 30 },
      }),
    ).toEqual({ remainingPercent: 0, exhausted: true, nextResetTime: resetA });
    // 两个桶都有余量：取最小剩余。
    expect(
      observeQuotaUsage({
        quota: {
          limits: [
            { percentage: 20, nextResetTime: resetA },
            { percentage: 55, nextResetTime: resetB },
          ],
        },
        remaining: null,
      }),
    ).toEqual({ remainingPercent: 45, exhausted: false, nextResetTime: resetA });
    // remaining / number 形式的桶按比例换算。
    expect(
      observeQuotaUsage({ quota: { limits: [{ remaining: 5, number: 100 }] } }).remainingPercent,
    ).toBe(5);
    // 无 limits 时回退 remaining.percentage（已用占比）。
    expect(observeQuotaUsage({ remaining: { percentage: 40, nextResetTime: resetB } })).toEqual({
      remainingPercent: 60,
      exhausted: false,
      nextResetTime: resetB,
    });
  });

  it("observeQuotaUsage：读不到额度 = 不可知（exhausted=false），绝不等于已耗尽", () => {
    // v2 线上事故：快照不可读被当成需要无限期守卫重排，任务卡死 10 小时。
    expect(observeQuotaUsage(null)).toEqual({
      remainingPercent: null,
      exhausted: false,
      nextResetTime: null,
    });
    expect(observeQuotaUsage({ remaining: null, quota: null }).exhausted).toBe(false);
    expect(
      observeQuotaUsage({ quota: { limits: [] }, remaining: { percentage: Number.NaN } }).exhausted,
    ).toBe(false);
  });

  it("observeQuotaUsage：服务端已用占比停在 99.x 也算耗尽", () => {
    expect(observeQuotaUsage({ remaining: { percentage: 99.6 } })).toMatchObject({
      remainingPercent: 0.4,
      exhausted: true,
    });
    expect(observeQuotaUsage({ remaining: { percentage: 98 } }).exhausted).toBe(false);
  });

  it("classifyTurnFailure：provider 业务码优先；1309=plan_expired、1308/1310=quota、1261=context、1305=transient", () => {
    expect(classifyTurnFailure({ providerErrorCode: "1309" })).toBe("plan_expired");
    expect(classifyTurnFailure({ providerErrorCode: "1308" })).toBe("quota");
    expect(classifyTurnFailure({ providerErrorCode: "1310" })).toBe("quota");
    expect(classifyTurnFailure({ providerErrorCode: "1261" })).toBe("context");
    expect(classifyTurnFailure({ providerErrorCode: "1305" })).toBe("transient");
    expect(classifyTurnFailure({ code: "1308" })).toBe("quota");
    expect(classifyTurnFailure({ code: "1261" })).toBe("context");
    expect(classifyTurnFailure({ code: "429" })).toBe("transient");
    expect(classifyTurnFailure({ attributionReason: "quota_exhausted" })).toBe("quota");
    expect(classifyTurnFailure({ attributionReason: "context_exceeded" })).toBe("context");
    expect(classifyTurnFailure({ attributionReason: "rate_limited" })).toBe("transient");
    expect(classifyTurnFailure({ attributionReason: "network_error" })).toBe("transient");
    expect(classifyTurnFailure({ source: "network" })).toBe("transient");
    expect(classifyTurnFailure({ message: "request context window exceeded" })).toBe("context");
    expect(classifyTurnFailure({ message: "exceed quota limit" })).toBe("quota");
    expect(classifyTurnFailure({ message: "plan has expired" })).toBe("plan_expired");
    expect(classifyTurnFailure({ message: "rate limit exceeded, retry later" })).toBe("transient");
    expect(classifyTurnFailure({})).toBeNull();
    expect(classifyTurnFailure({ code: "9999" })).toBeNull();
  });

  it("classifyTurnFailure：provider 业务码是额度/限流的唯一权威——CLI 对 1305 与 1308 发布同一套通用 reason", () => {
    // 归类码 + reason 都说是限流，但 provider 码说是额度耗尽：必须判额度。
    expect(
      classifyTurnFailure({
        code: "model_rate_limited",
        providerErrorCode: "1308",
        attributionReason: "rate_limited",
        message: "rate limit hit",
      }),
    ).toBe("quota");
    // 反之 1305 是限流：等 1 分钟即恢复，绝不能据此去等重置 / 烧卡。
    expect(
      classifyTurnFailure({
        code: "model_rate_limited",
        providerErrorCode: "1305",
        attributionReason: "rate_limited",
      }),
    ).toBe("transient");
    // 1310 周/月上限归 quota（卡型由 claimTargetForFailure 另行裁决）。
    expect(
      classifyTurnFailure({ providerErrorCode: "1310", attributionReason: "rate_limited" }),
    ).toBe("quota");
  });

  it("classifyTurnFailure：CLI 归类码（ModelErrorCode）——限流/超时/坏响应可续跑，鉴权/配置类不可恢复", () => {
    expect(classifyTurnFailure({ code: "model_rate_limited" })).toBe("transient");
    expect(classifyTurnFailure({ code: "model_request_timeout" })).toBe("transient");
    expect(classifyTurnFailure({ code: "invalid_model_response" })).toBe("transient");
    expect(classifyTurnFailure({ code: "model_context_exceeded" })).toBe("context");
    expect(classifyTurnFailure({ code: "model_request_failed" })).toBeNull();
    for (const code of [
      "invalid_model_selection",
      "model_config_missing",
      "provider_not_found",
      "provider_not_configured",
      "model_not_found",
      "invalid_model_request",
      "model_request_auth_missing",
      "model_request_cancelled",
    ]) {
      expect(classifyTurnFailure({ code }), code).toBe("non_recoverable");
    }
    expect(classifyTurnFailure({ attributionReason: "auth_failed" })).toBe("non_recoverable");
    expect(classifyTurnFailure({ attributionReason: "tls_error" })).toBe("non_recoverable");
    expect(classifyTurnFailure({ message: "Unauthorized: invalid api key" })).toBe(
      "non_recoverable",
    );
  });

  it("claimTargetForFailure：仅 quota 允许核销；1310 只认 WEEK 卡；1309/1311/1313 不烧卡", () => {
    const both = {
      availableFiveHourResets: [{ expireAt: NOW + 1_000 }],
      availableWeekResets: [{ expireAt: NOW + 1_000 }],
      latestFiveHourResetHistory: null,
      latestWeekResetHistory: null,
      hasUnreadHistory: false,
    };
    const fiveOnly = { ...both, availableWeekResets: [] };
    const weekOnly = { ...both, availableFiveHourResets: [] };
    // 其余额度类：5 小时卡优先（最小代价）。
    expect(claimTargetForFailure("quota", "1308", both, NOW)).toBe("FIVE_HOUR");
    expect(claimTargetForFailure("quota", null, both, NOW)).toBe("FIVE_HOUR");
    expect(claimTargetForFailure("quota", "1308", weekOnly, NOW)).toBe("WEEK");
    // 1310 周/月上限：只有 WEEK 卡有效，禁止拿 5 小时卡去撞。
    expect(claimTargetForFailure("quota", "1310", both, NOW)).toBe("WEEK");
    expect(claimTargetForFailure("quota", "1310", fiveOnly, NOW)).toBeNull();
    // 重置卡救不了的额度类。
    for (const code of ["1309", "1311", "1313"]) {
      expect(claimTargetForFailure("quota", code, both, NOW), code).toBeNull();
    }
    // 过期卡不可用。
    expect(
      claimTargetForFailure(
        "quota",
        "1308",
        { ...both, availableFiveHourResets: [{ expireAt: NOW - 1 }], availableWeekResets: [] },
        NOW,
      ),
    ).toBeNull();
    // 非额度类一律不烧卡。
    expect(claimTargetForFailure("plan_expired", "1309", both, NOW)).toBeNull();
    expect(claimTargetForFailure("context", "1261", both, NOW)).toBeNull();
    expect(claimTargetForFailure("transient", "1305", both, NOW)).toBeNull();
    expect(claimTargetForFailure(null, null, both, NOW)).toBeNull();
  });
});

describe("v3 调度阶梯（spec.md §9.4）", () => {
  it("quotaProbeDelayMs：1 → 5 → 15 → 30 分钟封顶", () => {
    expect(quotaProbeDelayMs(1)).toBe(60_000);
    expect(quotaProbeDelayMs(2)).toBe(5 * 60_000);
    expect(quotaProbeDelayMs(3)).toBe(15 * 60_000);
    expect(quotaProbeDelayMs(4)).toBe(30 * 60_000);
    expect(quotaProbeDelayMs(50)).toBe(30 * 60_000);
    expect(quotaProbeDelayMs(0)).toBe(60_000);
  });

  it("transientRetryDelayMs：1 → 5 → 15 分钟，之后封顶 15 分钟（v2 阶梯只有 3 档，第 4 次起没有到期时刻）", () => {
    expect(RESUME_TRANSIENT_BACKOFF_MS).toHaveLength(3);
    expect(transientRetryDelayMs(0)).toBe(60_000);
    expect(transientRetryDelayMs(1)).toBe(5 * 60_000);
    expect(transientRetryDelayMs(2)).toBe(15 * 60_000);
    expect(transientRetryDelayMs(3)).toBe(15 * 60_000);
    expect(transientRetryDelayMs(19)).toBe(15 * 60_000);
  });

  it("resolveExhaustedRecheckAt：min(nextReset + 裕量, now + 最长复核)；未知 / 已过则尽快复核", () => {
    const fourHours = NOW + 4 * 60 * 60_000;
    expect(resolveExhaustedRecheckAt(fourHours, NOW)).toBe(NOW + RESUME_QUOTA_MAX_RECHECK_MS);
    expect(resolveExhaustedRecheckAt(NOW + 2 * 60_000, NOW)).toBe(
      NOW + 2 * 60_000 + RESUME_QUOTA_WAKE_MARGIN_MS,
    );
    expect(resolveExhaustedRecheckAt(null, NOW)).toBe(NOW + RESUME_QUOTA_MAX_RECHECK_MS);
    expect(resolveExhaustedRecheckAt(NOW - 10 * 60_000, NOW)).toBe(
      NOW + RESUME_QUOTA_WAKE_MARGIN_MS,
    );
  });

  it("resumeInitialDelayMs：建意图一律很快到期，真正的等待由派发门裁决", () => {
    expect(resumeInitialDelayMs("quota", 0)).toBe(RESUME_AFTER_CLAIM_DELAY_MS);
    expect(resumeInitialDelayMs("context", 0)).toBe(RESUME_CONTEXT_COMPACT_DELAY_MS);
    expect(resumeInitialDelayMs("transient", 0)).toBe(60_000);
    expect(resumeInitialDelayMs("transient", 2)).toBe(15 * 60_000);
  });

  it("mayClaimCard：上次核销之后没有新的额度类失败时，不凭快照再烧第二张卡", () => {
    expect(mayClaimCard(0, 0, true)).toBe(true);
    expect(mayClaimCard(0, 0, false)).toBe(false);
    // 从未核销过：有额度失败即可核销。
    expect(mayClaimCard(0, NOW, true)).toBe(true);
    // 核销后才失败（新的耗尽周期）：可以再核销。
    expect(mayClaimCard(NOW, NOW + 1, true)).toBe(true);
    // 失败在核销之前（快照仍显示耗尽属于滞后）：不得再烧卡。
    expect(mayClaimCard(NOW, NOW - 1, true)).toBe(false);
    expect(mayClaimCard(NOW, NOW, true)).toBe(false);
  });
});

describe("v3 派发 turn 失败后的结算裁决（spec.md §9.4）", () => {
  const base = {
    intentKind: "quota" as const,
    attempt: 0,
    elapsedMs: 5_000,
    fastFails: 0,
    compactAttempts: 0,
    maxConsecutive: 5,
    message: "usage limit reached",
    now: NOW,
  };

  it("quota 快速失败：不计 attempt，按探测阶梯退避", () => {
    const first = planDispatchedFailureSettle({ ...base, classification: "quota" });
    expect(first.action).toEqual({
      type: "requeue",
      kind: "quota",
      nextEligibleAt: NOW + 60_000,
      attemptMode: "keep",
      quotaFastFail: true,
    });
    expect(first.fastFails).toBe(1);
    const third = planDispatchedFailureSettle({
      ...base,
      classification: "quota",
      fastFails: 2,
    });
    expect(third.action).toMatchObject({ attemptMode: "keep", nextEligibleAt: NOW + 15 * 60_000 });
    expect(third.fastFails).toBe(3);
  });

  it("quota 探测次数触顶（autoResumeMaxConsecutive）即 exhausted——不可知快照下不会无限空转", () => {
    const result = planDispatchedFailureSettle({
      ...base,
      classification: "quota",
      fastFails: 4,
    });
    expect(result.action.type).toBe("exhausted");
  });

  it("quota 运行了一段时间才耗尽 = 新的耗尽周期：连续计数清零并很快回到派发门", () => {
    const result = planDispatchedFailureSettle({
      ...base,
      classification: "quota",
      elapsedMs: 5 * 60_000,
      fastFails: 3,
    });
    expect(result.action).toEqual({
      type: "requeue",
      kind: "quota",
      nextEligibleAt: NOW + RESUME_AFTER_CLAIM_DELAY_MS,
      attemptMode: "reset",
      quotaFastFail: false,
    });
    expect(result.fastFails).toBe(0);
  });

  it("transient：退避并计 attempt，连续触顶 exhausted", () => {
    const first = planDispatchedFailureSettle({
      ...base,
      classification: "transient",
      intentKind: "transient",
    });
    expect(first.action).toEqual({
      type: "requeue",
      kind: "transient",
      nextEligibleAt: NOW + 5 * 60_000,
      attemptMode: "increment",
      quotaFastFail: false,
    });
    const last = planDispatchedFailureSettle({
      ...base,
      classification: "transient",
      intentKind: "transient",
      attempt: 4,
    });
    expect(last.action.type).toBe("exhausted");
  });

  it("transient 运行 ≥ 进展窗口才失败：有真实进展，连续计数清零", () => {
    const result = planDispatchedFailureSettle({
      ...base,
      classification: "transient",
      intentKind: "transient",
      attempt: 4,
      elapsedMs: RESUME_PROGRESS_WINDOW_MS,
    });
    expect(result.action).toMatchObject({ attemptMode: "reset", nextEligibleAt: NOW + 60_000 });
  });

  it("context：再给自发 compact 的机会（至多 2 次），仍溢出即 exhausted", () => {
    const first = planDispatchedFailureSettle({
      ...base,
      classification: "context",
      intentKind: "context",
    });
    expect(first.action).toMatchObject({
      type: "requeue",
      kind: "context",
      attemptMode: "keep",
      nextEligibleAt: NOW + RESUME_CONTEXT_COMPACT_DELAY_MS,
    });
    expect(first.disarmCompact).toBe(true);
    expect(first.compactAttempts).toBe(1);
    // 第二次压缩后的续跑仍溢出：压缩预算用尽。
    const second = planDispatchedFailureSettle({
      ...base,
      classification: "context",
      intentKind: "context",
      compactAttempts: 1,
    });
    expect(second.action.type).toBe("exhausted");
  });

  it("无法归因的失败：保持原类别并计 attempt，不适用进展清零，触顶 exhausted", () => {
    const quick = planDispatchedFailureSettle({
      ...base,
      classification: null,
      intentKind: "transient",
    });
    expect(quick.action).toMatchObject({
      type: "requeue",
      kind: "transient",
      attemptMode: "increment",
    });
    const longRun = planDispatchedFailureSettle({
      ...base,
      classification: null,
      intentKind: "transient",
      elapsedMs: 60 * 60_000,
      attempt: 4,
    });
    expect(longRun.action.type).toBe("exhausted");
  });

  it("plan_expired / non_recoverable：一律终态 exhausted，不建新回合", () => {
    for (const classification of ["plan_expired", "non_recoverable"] as const) {
      const result = planDispatchedFailureSettle({
        ...base,
        classification,
        elapsedMs: 60 * 60_000,
      });
      expect(result.action.type, classification).toBe("exhausted");
    }
  });
});
