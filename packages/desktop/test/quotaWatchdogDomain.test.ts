import { describe, expect, it } from "vitest";
import {
  claimTargetForFailure,
  classifyTurnFailure,
  computeWakeDelayMs,
  createInitialWatchdogStatus,
  isOpportunityTransientError,
  nextOpportunityCooldownUntil,
  remainingPercentFromEntitlement,
  resolveClaimTarget,
  transitionWatchdogState,
  watchdogPollDelayMs,
  QUOTA_WATCHDOG_CLAIM_THRESHOLD_PERCENT,
  WATCHING_CADENCE_MAX_MS,
  WATCHING_CADENCE_MIN_MS,
} from "@zcode/services/node";
import { QUOTA_WATCHDOG_DEFAULT_SETTINGS, RESUME_QUOTA_WAKE_MARGIN_MS } from "@zcode/shared";

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

describe("v2 额度口径与失败归因（spec.md §3.6）", () => {
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

  it("classifyTurnFailure：code 优先；1309=plan_expired、1308/1310=quota、1261=context、1305=transient", () => {
    expect(classifyTurnFailure({ code: "1309" })).toBe("plan_expired");
    expect(classifyTurnFailure({ code: "1308" })).toBe("quota");
    expect(classifyTurnFailure({ code: "1310" })).toBe("quota");
    expect(classifyTurnFailure({ code: "1261" })).toBe("context");
    expect(classifyTurnFailure({ code: "1305" })).toBe("transient");
    expect(classifyTurnFailure({ code: "429" })).toBe("transient");
    expect(classifyTurnFailure({ attributionReason: "quota_exhausted" })).toBe("quota");
    expect(classifyTurnFailure({ attributionReason: "context_exceeded" })).toBe("context");
    expect(classifyTurnFailure({ source: "network" })).toBe("transient");
    expect(classifyTurnFailure({ message: "request context window exceeded" })).toBe("context");
    expect(classifyTurnFailure({ message: "exceed quota limit" })).toBe("quota");
    expect(classifyTurnFailure({ message: "plan has expired" })).toBe("plan_expired");
    expect(classifyTurnFailure({ message: "rate limit exceeded, retry later" })).toBe("transient");
    expect(classifyTurnFailure({})).toBeNull();
    // code 类别优先于消息兜底：1308 即使消息含 rate limit 仍是额度类
    expect(classifyTurnFailure({ code: "1308", message: "rate limit" })).toBe("quota");
    // code 不在任何类别集 + 无归因 → null（调用方按意图 kind 兜底）
    expect(classifyTurnFailure({ code: "9999" })).toBeNull();
  });

  it("claimTargetForFailure：仅 quota（含 null 兜底）允许核销卡；plan_expired/context/transient 一律不烧", () => {
    const cards = {
      availableFiveHourResets: [{ expireAt: NOW + 1_000 }],
      availableWeekResets: [],
      latestFiveHourResetHistory: null,
      latestWeekResetHistory: null,
      hasUnreadHistory: false,
    };
    expect(claimTargetForFailure("quota", cards, NOW)).toBe("FIVE_HOUR");
    expect(claimTargetForFailure(null, cards, NOW)).toBe("FIVE_HOUR");
    expect(claimTargetForFailure("plan_expired", cards, NOW)).toBeNull();
    expect(claimTargetForFailure("context", cards, NOW)).toBeNull();
    expect(claimTargetForFailure("transient", cards, NOW)).toBeNull();
  });
});
