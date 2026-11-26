import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOutcomeForInput,
  QuotaWatchdogService,
  ResumeIntentRepo,
  RESUME_ACTIVE_DEFER_MS,
  RESUME_AFTER_CLAIM_DELAY_MS,
  RESUME_CLAIM_COOLDOWN_MS,
  RESUME_COMPACT_WAIT_MS,
  RESUME_QUOTA_MAX_RECHECK_MS,
  type QuotaResumeDispatchPort,
  type QuotaWatchdogSettings,
  type TaskActivity,
  type TurnOutcomeWaitResult,
} from "@zcode/services/node";
import {
  RESUME_CONTEXT_COMPACT_DELAY_MS,
  type CodingPlanResetScopeRequest,
  type CodingPlanResetStatusSnapshot,
  type CodingPlanResetType,
  type UsageEntitlementRequest,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";

// 配额守护 + 自动续跑的宿主侧行为回归（docs/quota-watchdog/spec.md §9）。
// 真实 ResumeIntentRepo（临时 sqlite）+ 假 usage / 假派发 port + 可控时钟：
// 每个用例对应一次线上事故或审计确认的缺陷。

const T0 = 1_700_000_000_000;
const WS = "/tmp/workspace";
/** claimResets 用真实时钟判断卡片过期，测试卡片一律给到 2100 年。 */
const FAR_FUTURE = 4_102_444_800_000;
const MAX_TICK_DELAY_MS = 5 * 60_000;

interface SentResume {
  taskId: string;
  resumeIntentId: string;
  inputId: string;
}

interface RecordedWait {
  taskId: string;
  inputId: string;
  resolve: (value: TurnOutcomeWaitResult) => void;
  dispose: ReturnType<typeof vi.fn>;
}

interface Harness {
  service: QuotaWatchdogService;
  repo: ResumeIntentRepo;
  usage: ReturnType<typeof createUsageStats>;
  dispatch: ReturnType<typeof createDispatch>;
  settings: {
    autoResumeEnabled: boolean;
    autoClaimResetCardsEnabled: boolean;
    quotaWatchThresholdPercent: number;
    autoResumeMaxConsecutive: number;
  };
  now: () => number;
  advance: (ms: number) => void;
  fail: (
    taskId: string,
    failure: { code?: string | null; providerErrorCode?: string | null; message?: string },
  ) => Promise<void>;
  failLatestTurn: (taskId: string, outcome?: Partial<TurnOutcomeWaitResult>) => Promise<void>;
  /** 线上真实顺序：终态先到（不带归因），detector 随后带回权威 lastError。 */
  failLatestTurnThenDetect: (
    taskId: string,
    failure: { code?: string | null; providerErrorCode?: string | null; message: string },
  ) => Promise<void>;
  completeLatestTurn: (taskId: string) => Promise<void>;
  dispose: () => Promise<void>;
}

function createUsageStats() {
  const state = {
    /** null = entitlement 快照不可读（抛错）。 */
    usedPercent: 20 as number | null,
    nextResetTime: null as number | null,
    fiveHourCards: 0,
    weekCards: 0,
    fiveHourUsedAt: null as number | null,
    weekUsedAt: null as number | null,
    opportunityGranted: false,
    snapshotRequests: [] as Array<UsageEntitlementRequest | undefined>,
    useCalls: [] as Array<{
      resetType: CodingPlanResetType;
      idempotencyKey: string;
      preferredProviderId: string;
    }>,
    opportunityCalls: 0,
  };
  const resetStatus = (): CodingPlanResetStatusSnapshot => ({
    availableFiveHourResets: state.fiveHourCards > 0 ? [{ expireAt: FAR_FUTURE }] : [],
    availableWeekResets: state.weekCards > 0 ? [{ expireAt: FAR_FUTURE }] : [],
    latestFiveHourResetHistory:
      state.fiveHourUsedAt === null ? null : { usedAt: state.fiveHourUsedAt },
    latestWeekResetHistory: state.weekUsedAt === null ? null : { usedAt: state.weekUsedAt },
    hasUnreadHistory: false,
  });
  const service = {
    async getEntitlementSnapshot(
      request?: UsageEntitlementRequest,
    ): Promise<UsageEntitlementSnapshot> {
      state.snapshotRequests.push(request);
      if (state.usedPercent === null) throw new Error("entitlement unavailable");
      return {
        generatedAt: 1,
        authenticated: true,
        provider: { id: "bigmodel", name: "BigModel" },
        remaining: {
          count: 0,
          isShow: true,
          percentage: state.usedPercent,
          nextResetTime: state.nextResetTime,
        },
        subscription: null,
        quota: null,
      } satisfies UsageEntitlementSnapshot;
    },
    async getCodingPlanResetStatus(): Promise<CodingPlanResetStatusSnapshot> {
      return resetStatus();
    },
    async useCodingPlanReset(
      request: CodingPlanResetScopeRequest & {
        resetType: CodingPlanResetType;
        idempotencyKey: string;
      },
    ) {
      state.useCalls.push(request);
      const usedAt = Date.now();
      if (request.resetType === "WEEK") {
        state.weekCards -= 1;
        state.weekUsedAt = usedAt;
      } else {
        state.fiveHourCards -= 1;
        state.fiveHourUsedAt = usedAt;
      }
      return { used: true as const };
    },
    async requestCodingPlanResetOpportunity() {
      state.opportunityCalls += 1;
      if (state.opportunityGranted) state.fiveHourCards += 1;
      // 未发卡时不给 nextTryAt：冷却按服务自身的时钟（now + 10min）计算。
      return { granted: state.opportunityGranted, nextTryAt: null };
    },
  };
  return { service, state, resetStatus };
}

function createDispatch() {
  const activity = new Map<string, TaskActivity>();
  const compactWork = new Set<string>();
  const sent: SentResume[] = [];
  const compacts: Array<{ taskId: string }> = [];
  const waits: RecordedWait[] = [];
  const state = {
    failSend: false,
    compactAck: "accepted" as "accepted" | "alreadyRunning" | "rejected",
  };
  const port: QuotaResumeDispatchPort = {
    getTaskActivity: ({ taskId }) => activity.get(taskId) ?? "idle",
    isCompactWorkActive: (sessionId) => compactWork.has(sessionId),
    sendResumeText: async (input) => {
      if (state.failSend) throw new Error("ZCODE_SESSION_TARGET_NOT_FOUND");
      sent.push({
        taskId: input.taskId,
        resumeIntentId: input.resumeIntentId,
        inputId: input.inputId,
      });
      return "accepted";
    },
    requestCompact: async (target) => {
      compacts.push({ taskId: target.taskId });
      if (state.compactAck === "accepted") compactWork.add(target.taskId);
      return state.compactAck;
    },
    subscribeOutcome: (input) => {
      let resolve!: (value: TurnOutcomeWaitResult) => void;
      const result = new Promise<TurnOutcomeWaitResult>((resolvePromise) => {
        resolve = resolvePromise;
      });
      const dispose = vi.fn();
      waits.push({ taskId: input.taskId, inputId: input.expectedInputId, resolve, dispose });
      return { result, dispose };
    },
  };
  return { port, activity, compactWork, sent, compacts, waits, state };
}

/** 让游离的 promise 链（结局结算 / 排程）跑完。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("QuotaWatchdogService（v3 自动续跑）", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  async function createHarness(
    options: { init?: boolean; settings?: Partial<QuotaWatchdogSettings> } = {},
  ): Promise<Harness> {
    const dir = await mkdtemp(join(tmpdir(), "quota-watchdog-"));
    const repo = new ResumeIntentRepo(join(dir, "tasks-index.sqlite"));
    const usage = createUsageStats();
    const dispatch = createDispatch();
    let now = T0;
    const settings = {
      autoResumeEnabled: true,
      autoClaimResetCardsEnabled: true,
      quotaWatchThresholdPercent: 10,
      autoResumeMaxConsecutive: 5,
      ...options.settings,
    };
    const service = new QuotaWatchdogService({
      usageStatsService: usage.service as never,
      resumeIntentRepo: repo,
      settingService: { get: async () => settings } as never,
      dispatch: dispatch.port,
      resolveResetScope: async () =>
        ({
          preferredProviderId: "bigmodel",
          accountAccess: "personal",
        }) satisfies CodingPlanResetScopeRequest,
      now: () => now,
      outcomeAttributionGraceMs: 40,
    });
    cleanups.push(async () => {
      service.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    });
    if (options.init) await service.init();
    const latestWait = (taskId: string) => {
      const wait = [...dispatch.waits].reverse().find((item) => item.taskId === taskId);
      if (!wait) throw new Error(`no outcome wait recorded for ${taskId}`);
      return wait;
    };
    return {
      service,
      repo,
      usage,
      dispatch,
      settings,
      now: () => now,
      advance: (ms) => {
        now += ms;
      },
      fail: (taskId, failure) =>
        service.handleSessionFailure({ taskId, workspacePath: WS, ...failure, via: "detector" }),
      failLatestTurn: async (taskId, outcome = {}) => {
        latestWait(taskId).resolve({ outcome: "failed", errorMessage: "turn failed", ...outcome });
        await flush();
      },
      failLatestTurnThenDetect: async (taskId, failure) => {
        latestWait(taskId).resolve({ outcome: "failed", errorMessage: "resume turn failed" });
        await flush();
        await service.handleSessionFailure({
          taskId,
          workspacePath: WS,
          ...failure,
          via: "detector",
        });
      },
      completeLatestTurn: async (taskId) => {
        latestWait(taskId).resolve({ outcome: "completed" });
        await flush();
      },
      dispose: async () => {
        service.dispose();
        repo.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  /** 活跃意图（pending / dispatched）；终态行为 null。 */
  const active = (h: Harness, taskId: string) => h.repo.getActiveByTask(taskId);
  /** 展示面意图（含 exhausted），用于断言终态。 */
  const effective = (h: Harness, taskId: string) => h.repo.getEffectiveByTask(taskId);

  it("额度耗尽且无卡：等重置期间不派发（不再是每 5 分钟一条 unavailable 的死循环），额度恢复后自动续跑", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = 100;
    h.usage.state.nextResetTime = T0 + 4 * 60 * 60_000;

    await h.fail("t1", {
      code: "model_rate_limited",
      providerErrorCode: "1308",
      message: "usage limit reached for 5 hour",
    });
    // 观测请求带 scope（与 renderer 同口径）——v2 的无 scope 快照读不到 percentage。
    expect(h.usage.state.snapshotRequests.at(-1)).toMatchObject({
      preferredProviderId: "bigmodel",
    });
    expect(await active(h, "t1")).toMatchObject({
      kind: "quota",
      status: "pending",
      nextEligibleAt: T0 + RESUME_AFTER_CLAIM_DELAY_MS,
    });

    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(0);
    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    // 到期后由派发门裁定：额度仍耗尽且无卡 → 不派发，最长 10 分钟复核一次。
    expect(h.dispatch.sent).toHaveLength(0);
    expect(await active(h, "t1")).toMatchObject({
      status: "pending",
      nextEligibleAt: h.now() + RESUME_QUOTA_MAX_RECHECK_MS,
    });
    h.advance(RESUME_QUOTA_MAX_RECHECK_MS);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(0);

    // 额度提前恢复：等待中的意图立即回到派发门，10 秒后派发，且只派发一次。
    h.usage.state.usedPercent = 40;
    await h.service.wake();
    expect(await active(h, "t1")).toMatchObject({
      status: "pending",
      nextEligibleAt: h.now() + RESUME_AFTER_CLAIM_DELAY_MS,
    });
    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);
    expect(h.dispatch.sent[0]!.taskId).toBe("t1");
    expect(await active(h, "t1")).toMatchObject({ status: "dispatched" });
    // 结局等待先于派发建立，且绑定本轮 inputId。
    expect(h.dispatch.waits).toHaveLength(1);
    expect(h.dispatch.waits[0]!.inputId).toBe(h.dispatch.sent[0]!.inputId);

    await h.completeLatestTurn("t1");
    expect(await active(h, "t1")).toBeNull();
  });

  it("额度快照不可读：放行有界探测（1→5→15→30 分钟），触顶即 exhausted，绝不无限空转", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = null;

    await h.fail("t2", { providerErrorCode: "1308", message: "usage limit" });
    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);

    const probe = async (expectedDelayMs: number, expectedAttempt: number) => {
      await h.failLatestTurn("t2", { providerErrorCode: "1308", message: "usage limit" });
      const intent = await active(h, "t2");
      expect(intent).toMatchObject({ status: "pending", attempt: expectedAttempt });
      expect(intent!.nextEligibleAt).toBe(h.now() + expectedDelayMs);
    };
    // 快速失败不消耗 attempt。
    await probe(60_000, 0);
    h.advance(60_000);
    await h.service.wake();
    await probe(5 * 60_000, 0);
    h.advance(5 * 60_000);
    await h.service.wake();
    await probe(15 * 60_000, 0);
    h.advance(15 * 60_000);
    await h.service.wake();
    await probe(30 * 60_000, 0);
    h.advance(30 * 60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(5);
    // 第 5 次探测仍失败：达到 autoResumeMaxConsecutive，终态 exhausted。
    await h.failLatestTurn("t2", { providerErrorCode: "1308", message: "usage limit" });
    expect(await effective(h, "t2")).toMatchObject({ status: "exhausted", attempt: 0 });
    h.advance(6 * 60 * 60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(5);
  });

  it("额度类失败当场核销重置卡（用户的头号诉求），10 秒后续跑", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = 100;
    h.usage.state.fiveHourCards = 2;

    await h.fail("t3", { providerErrorCode: "1308", message: "usage limit reached" });
    expect(h.usage.state.useCalls).toHaveLength(1);
    expect(h.usage.state.useCalls[0]!.resetType).toBe("FIVE_HOUR");
    expect(h.usage.state.useCalls[0]!.idempotencyKey).toBeTruthy();
    // 核销成功后意图被提前到 now + 10s。
    expect((await active(h, "t3"))!.nextEligibleAt).toBe(T0 + RESUME_AFTER_CLAIM_DELAY_MS);

    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    // 快照可能仍是耗尽态缓存：核销冷却内放行探测，不重复烧卡。
    expect(h.dispatch.sent).toHaveLength(1);

    // 探测秒败（卡尚未生效）：不烧第二张卡（冷却 + 核销资格）。
    await h.failLatestTurn("t3", { providerErrorCode: "1308" });
    expect(h.usage.state.useCalls).toHaveLength(1);
    expect(await active(h, "t3")).toMatchObject({
      status: "pending",
      nextEligibleAt: h.now() + 60_000,
    });
  });

  it("快照仍显示耗尽但上次核销之后没有新的额度失败：不凭快照再烧一张卡", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = 100;
    h.usage.state.fiveHourCards = 3;
    await h.fail("t4", { providerErrorCode: "1308" });
    expect(h.usage.state.useCalls).toHaveLength(1);
    // 续跑 turn 长时间正常完成（没有额度失败）。
    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    await h.completeLatestTurn("t4");
    expect(await active(h, "t4")).toBeNull();

    // 11 小时后另一个任务也以额度失败：有新的失败事实，才允许再核销。
    h.advance(11 * 60 * 60_000);
    await h.fail("t4b", { providerErrorCode: "1308" });
    expect(h.usage.state.useCalls).toHaveLength(2);
  });

  it("1310 周/月上限只核销 WEEK 卡；只有 5 小时卡时不烧，转为等重置", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = 100;
    h.usage.state.fiveHourCards = 2;
    h.usage.state.weekCards = 1;
    await h.fail("t5", { providerErrorCode: "1310", message: "weekly usage limit" });
    expect(h.usage.state.useCalls).toHaveLength(1);
    expect(h.usage.state.useCalls[0]!.resetType).toBe("WEEK");

    const only = await createHarness();
    only.usage.state.usedPercent = 100;
    only.usage.state.fiveHourCards = 2;
    await only.fail("t5", { providerErrorCode: "1310", message: "weekly usage limit" });
    expect(only.usage.state.useCalls).toHaveLength(0);
    expect(await active(only, "t5")).toMatchObject({ kind: "quota", status: "pending" });
  });

  it("1309 到期 / 配置鉴权类 / 无法归因的失败：不建意图、不烧卡", async () => {
    const h = await createHarness();
    h.usage.state.fiveHourCards = 2;
    await h.fail("t6", { providerErrorCode: "1309", message: "plan expired" });
    await h.fail("t7", { code: "invalid_model_selection", message: "model not available" });
    await h.fail("t8", { code: "tool_error", message: "bash exited with code 1" });
    expect(await active(h, "t6")).toBeNull();
    expect(await active(h, "t7")).toBeNull();
    expect(await active(h, "t8")).toBeNull();
    expect(h.usage.state.useCalls).toHaveLength(0);
    expect(h.dispatch.sent).toHaveLength(0);
  });

  it("限流（1305）：1→5→15→15→15 分钟退避，连续 5 次失败后 exhausted", async () => {
    const h = await createHarness();
    await h.fail("t9", { code: "model_rate_limited", providerErrorCode: "1305" });
    expect(await active(h, "t9")).toMatchObject({ kind: "transient", nextEligibleAt: T0 + 60_000 });

    const steps: Array<[number, number]> = [
      [60_000, 1],
      [5 * 60_000, 2],
      [15 * 60_000, 3],
      [15 * 60_000, 4],
      [15 * 60_000, 5],
    ];
    for (const [advanceMs, expectedAttempt] of steps) {
      h.advance(advanceMs);
      await h.service.wake();
      await h.failLatestTurn("t9", { code: "model_rate_limited", providerErrorCode: "1305" });
      const intent = await active(h, "t9");
      if (expectedAttempt < 5) {
        // v2 的阶梯只有 3 档，第 4 次续跑没有到期时刻；v3 封顶 15 分钟。
        const nextDelay = expectedAttempt === 1 ? 5 : 15;
        expect(intent).toMatchObject({
          status: "pending",
          attempt: expectedAttempt,
          nextEligibleAt: h.now() + nextDelay * 60_000,
        });
      }
    }
    expect(h.dispatch.sent).toHaveLength(5);
    // 行上的 attempt 记录的是此前连续失败的次数（第 5 次失败直接终态，不再 +1）。
    expect(await effective(h, "t9")).toMatchObject({ status: "exhausted", attempt: 4 });
  });

  it("限流但续跑已产出真实进展（运行 ≥ 2 分钟才失败）：连续计数清零，工作不停", async () => {
    const h = await createHarness();
    await h.fail("t10", { providerErrorCode: "1305" });
    for (let round = 0; round < 6; round += 1) {
      h.advance(60_000);
      await h.service.wake();
      // 这一轮跑了 10 分钟才又被限流。
      h.advance(10 * 60_000);
      await h.failLatestTurn("t10", { providerErrorCode: "1305" });
      expect(await active(h, "t10")).toMatchObject({ status: "pending", attempt: 0 });
    }
    expect(h.dispatch.sent).toHaveLength(6);
  });

  it("上下文溢出：先自发 compact，压缩落地后才续跑；至多 2 次压缩，仍溢出即 exhausted", async () => {
    const h = await createHarness();
    await h.fail("t11", { providerErrorCode: "1261", message: "prompt is too long" });
    expect(await active(h, "t11")).toMatchObject({ kind: "context" });

    // 派发门先请求 compact，不直接续跑（直接续跑必然再次溢出）。
    h.advance(RESUME_CONTEXT_COMPACT_DELAY_MS);
    await h.service.wake();
    expect(h.dispatch.compacts).toHaveLength(1);
    expect(h.dispatch.sent).toHaveLength(0);
    expect(await active(h, "t11")).toMatchObject({
      status: "pending",
      nextEligibleAt: h.now() + RESUME_COMPACT_WAIT_MS,
    });
    // 压缩仍在进行：继续等，不派发。
    h.advance(RESUME_COMPACT_WAIT_MS);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(0);

    // 压缩落地 → 续跑。
    h.dispatch.compactWork.delete("t11");
    h.advance(RESUME_COMPACT_WAIT_MS);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);

    // 续跑仍溢出：不消耗 attempt，重新走一次压缩。
    await h.failLatestTurn("t11", { providerErrorCode: "1261" });
    expect(await active(h, "t11")).toMatchObject({
      kind: "context",
      status: "pending",
      attempt: 0,
    });
    h.advance(RESUME_CONTEXT_COMPACT_DELAY_MS);
    await h.service.wake();
    expect(h.dispatch.compacts).toHaveLength(2);
    h.dispatch.compactWork.delete("t11");
    h.advance(RESUME_COMPACT_WAIT_MS);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(2);

    // 第二次压缩后仍溢出：终态 exhausted（压缩救不了，交还用户）。
    await h.failLatestTurn("t11", { providerErrorCode: "1261" });
    expect(await effective(h, "t11")).toMatchObject({ status: "exhausted" });
    h.advance(60 * 60_000);
    await h.service.wake();
    expect(h.dispatch.compacts).toHaveLength(2);
    expect(h.dispatch.sent).toHaveLength(2);
  });

  it("compact 请求被拒：重试有限次后放行续跑，由结局裁决，绝不无限请求", async () => {
    const h = await createHarness();
    h.dispatch.state.compactAck = "rejected";
    await h.fail("t12", { providerErrorCode: "1261" });
    h.advance(RESUME_CONTEXT_COMPACT_DELAY_MS);
    await h.service.wake();
    await h.service.wake();
    expect(h.dispatch.compacts).toHaveLength(1);
    expect(h.dispatch.sent).toHaveLength(0);
    h.advance(RESUME_COMPACT_WAIT_MS);
    await h.service.wake();
    expect(h.dispatch.compacts).toHaveLength(2);
    h.advance(RESUME_COMPACT_WAIT_MS);
    await h.service.wake();
    // 连续被拒 2 次后不再请求，直接续跑。
    expect(h.dispatch.compacts).toHaveLength(2);
    expect(h.dispatch.sent).toHaveLength(1);
  });

  it("任务仍在活动（用户已接管 / 自发 compact 在跑）：推迟而不是取消；持续 2 小时才取消", async () => {
    const h = await createHarness();
    await h.fail("t13", { providerErrorCode: "1305" });
    h.dispatch.activity.set("t13", "active");
    h.advance(60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(0);
    expect(await active(h, "t13")).toMatchObject({
      status: "pending",
      nextEligibleAt: h.now() + RESUME_ACTIVE_DEFER_MS,
    });

    h.advance(2 * 60 * 60_000);
    await h.service.wake();
    // 活动一直未停：任务早已不需要自动续跑，交还用户。
    expect(await active(h, "t13")).toBeNull();
    expect(h.dispatch.sent).toHaveLength(0);
  });

  it("结局等待到期但任务仍在跑：续等，绝不重复派发；终态属于其它 input 时忽略", async () => {
    expect(isOutcomeForInput(undefined, "resume-a")).toBe(true);
    expect(isOutcomeForInput("resume-a", "resume-a")).toBe(true);
    expect(isOutcomeForInput("user-input", "resume-a")).toBe(false);

    const h = await createHarness();
    await h.fail("t14", { providerErrorCode: "1305" });
    h.advance(60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);
    h.dispatch.activity.set("t14", "active");
    await h.failLatestTurn("t14", {
      outcome: "failed",
      errorMessage: "resume turn outcome timed out",
      timedOut: true,
    });
    // 重新挂了一个结局等待；行仍是 dispatched，没有第二次派发。
    expect(h.dispatch.waits).toHaveLength(2);
    expect(h.dispatch.sent).toHaveLength(1);
    expect(await active(h, "t14")).toMatchObject({ status: "dispatched" });

    // 长任务最终正常完成：意图删除，不会再被续跑。
    h.dispatch.activity.set("t14", "idle");
    await h.completeLatestTurn("t14");
    expect(await active(h, "t14")).toBeNull();
  });

  it("派发本身失败（会话无法恢复 / 命令被拒）：30 秒重试且不消耗 attempt；连续 10 次后 exhausted", async () => {
    const h = await createHarness();
    h.dispatch.state.failSend = true;
    await h.fail("t15", { providerErrorCode: "1305" });
    h.advance(60_000);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await h.service.wake();
      const intent = await active(h, "t15");
      if (attempt < 10) {
        expect(intent).toMatchObject({ status: "pending", attempt: 0 });
        expect(intent!.nextEligibleAt).toBe(h.now() + 30_000);
        h.advance(30_000);
      } else {
        expect(await effective(h, "t15")).toMatchObject({
          status: "exhausted",
          attempt: 0,
          lastError: expect.stringContaining("resume could not be dispatched"),
        });
      }
    }
    expect(h.dispatch.sent).toHaveLength(0);
  });

  it("同一次失败被 detector / 派发结局 / renderer 重复上报：只结算一次，attempt 不双计", async () => {
    const h = await createHarness();
    await h.fail("t16", { providerErrorCode: "1305" });
    h.advance(60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);
    const wait = h.dispatch.waits[0]!;
    // detector 与结局通道同时到达，描述同一次失败。
    wait.resolve({ outcome: "failed", providerErrorCode: "1305", errorMessage: "rate limited" });
    await h.service.handleSessionFailure({
      taskId: "t16",
      workspacePath: WS,
      providerErrorCode: "1305",
      message: "rate limited",
      via: "detector",
    });
    await flush();
    expect(await active(h, "t16")).toMatchObject({ status: "pending", attempt: 1 });
  });

  it("renderer 的陈旧重放上报被丢弃：已取消 / 已耗尽的意图不会被复活", async () => {
    const h = await createHarness();
    const report = (errorAt: number | null) =>
      h.service.reportAutoResumeFailure({
        taskId: "t17",
        workspacePath: WS,
        errorAt,
        errorMessage: "usage limit reached",
        providerErrorCode: "1308",
      });
    // 缺少失败时刻：无法判断新鲜度，直接丢弃。
    await report(null);
    expect(await active(h, "t17")).toBeNull();
    // SessionPane 重新挂载后重报 5 分钟前的旧错误。
    await report(T0 - 5 * 60_000);
    expect(await active(h, "t17")).toBeNull();
    // 新鲜的上报才建意图。
    await report(T0 - 1_000);
    expect(await active(h, "t17")).toMatchObject({ kind: "quota", status: "pending" });

    await h.service.cancelAutoResume({ taskId: "t17", reason: "user_manual_input" });
    expect(await active(h, "t17")).toBeNull();
    await report(T0 - 500);
    expect(await active(h, "t17")).toBeNull();
  });

  it("用户手动输入取消意图：清空全部簿记并释放在途结局等待，迟到的结局不再结算", async () => {
    const h = await createHarness();
    await h.fail("t18", { providerErrorCode: "1305" });
    h.advance(60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);
    await h.service.cancelAutoResume({ taskId: "t18", reason: "user_manual_input" });
    expect(await active(h, "t18")).toBeNull();
    expect(h.dispatch.waits[0]!.dispose).toHaveBeenCalled();

    await h.failLatestTurn("t18", { providerErrorCode: "1305" });
    expect(await active(h, "t18")).toBeNull();
    h.advance(60 * 60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);
  });

  it("关闭自动续跑：待派发意图批量取消，新失败不再建意图（自动核销设置不受影响）", async () => {
    const h = await createHarness();
    await h.fail("t19", { providerErrorCode: "1305" });
    h.settings.autoResumeEnabled = false;
    await h.service.wake();
    expect(await active(h, "t19")).toBeNull();
    await h.fail("t20", { providerErrorCode: "1305" });
    expect(await active(h, "t20")).toBeNull();
    expect(h.dispatch.sent).toHaveLength(0);
  });

  it("等待额度期间服务端发卡（/opportunity granted）：意图立即回到派发门并核销续跑", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = 100;
    await h.fail("t21", { providerErrorCode: "1308" });
    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    // 无卡：等重置。
    expect(h.dispatch.sent).toHaveLength(0);
    expect(h.usage.state.opportunityCalls).toBe(1);
    expect(h.usage.state.useCalls).toHaveLength(0);

    h.usage.state.opportunityGranted = true;
    h.advance(RESUME_QUOTA_MAX_RECHECK_MS);
    await h.service.wake();
    // 发卡成功：同一轮内就核销新卡（不必等下一次复核），并给服务端额度生效留 10 秒再续派发。
    expect(h.usage.state.useCalls).toHaveLength(1);
    expect(h.dispatch.sent).toHaveLength(0);
    expect(await active(h, "t21")).toMatchObject({
      status: "pending",
      nextEligibleAt: h.now() + RESUME_AFTER_CLAIM_DELAY_MS,
    });
    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);
  });

  it("进程启动：上一实例遗留的 dispatched 行全部回到 pending，启动后自动续跑", async () => {
    const h = await createHarness();
    await h.repo.upsertPending(
      {
        taskId: "t22",
        workspacePath: WS,
        kind: "transient",
        nextEligibleAt: T0 - 1,
        lastError: "rate limited",
      },
      { now: T0 - 60_000 },
    );
    await h.repo.claimDue(T0);
    expect(await active(h, "t22")).toMatchObject({ status: "dispatched" });

    await h.service.init();
    expect(await active(h, "t22")).toMatchObject({ status: "pending" });
    // init 只负责恢复与排程（首个 tick ≥1s 后）；这里直接驱动一轮。
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);
    expect(await active(h, "t22")).toMatchObject({ status: "dispatched" });
    expect(h.dispatch.sent[0]!.taskId).toBe("t22");
  });

  it("排程：长等待的定时器封顶 5 分钟（休眠唤醒后能及时重算），更早到期的意图会把定时器提前", async () => {
    const h = await createHarness();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const delays = () =>
      setTimeoutSpy.mock.calls
        .map((call) => call[1])
        .filter((delay): delay is number => typeof delay === "number");
    await h.repo.upsertPending(
      { taskId: "t23", workspacePath: WS, kind: "quota", nextEligibleAt: T0 + 4 * 60 * 60_000 },
      { now: T0 },
    );
    await h.service.wake();
    await flush();
    // 意图 4 小时后才到期：不允许出现 5 分钟～1 天之间的长定时器。
    expect(
      delays().filter((delay) => delay > MAX_TICK_DELAY_MS && delay < 24 * 60 * 60_000),
    ).toEqual([]);

    setTimeoutSpy.mockClear();
    await h.repo.upsertPending(
      { taskId: "t24", workspacePath: WS, kind: "quota", nextEligibleAt: T0 + 10_000 },
      { now: T0 },
    );
    await h.service.wake();
    await flush();
    // 新意图 10 秒后到期：定时器被提前（v2 有在途等待时跳过到期计算，其它意图被饿死）。
    expect(Math.min(...delays())).toBeLessThanOrEqual(10_000);
  });
  // ── 线上真实顺序：task index 先发 turn 终态（结局通道只知道"这一轮失败了"，不带任何归因），
  // 随后回源快照的 detector 才带回权威 lastError。v3 初版在此刻立即按"无法归因"结算：
  // 额度类快速失败错记 attempt 并走 5/15 分钟阶梯；续跑长时间正常运转后才耗尽也累计到上限提前停止。
  const detect = (taskId: string, providerErrorCode: string, message = "turn failed") => ({
    taskId,
    workspacePath: WS,
    providerErrorCode,
    message,
    via: "detector" as const,
  });

  it("真实顺序 · 额度快速失败：不计 attempt，走 1→5→15→30 分钟探测阶梯，第 5 次 exhausted", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = null;
    await h.fail("t30", { providerErrorCode: "1308", message: "usage limit" });
    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);

    const probe = async (expectedDelayMs: number) => {
      h.dispatch.waits.at(-1)!.resolve({ outcome: "failed", errorMessage: "resume turn failed" });
      await flush();
      // 宽限内把结算让给 detector：此刻不结算，行仍是 dispatched。
      expect(await active(h, "t30")).toMatchObject({ status: "dispatched" });
      await h.service.handleSessionFailure(detect("t30", "1308", "usage limit reached for 5 hour"));
      const intent = await active(h, "t30");
      expect(intent).toMatchObject({ status: "pending", kind: "quota", attempt: 0 });
      expect(intent!.nextEligibleAt).toBe(h.now() + expectedDelayMs);
    };
    await probe(60_000);
    h.advance(60_000);
    await h.service.wake();
    await probe(5 * 60_000);
    h.advance(5 * 60_000);
    await h.service.wake();
    await probe(15 * 60_000);
    h.advance(15 * 60_000);
    await h.service.wake();
    await probe(30 * 60_000);
    h.advance(30 * 60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(5);

    h.dispatch.waits.at(-1)!.resolve({ outcome: "failed", errorMessage: "resume turn failed" });
    await flush();
    await h.service.handleSessionFailure(detect("t30", "1308", "usage limit reached for 5 hour"));
    expect(await effective(h, "t30")).toMatchObject({
      status: "exhausted",
      attempt: 0,
      lastError: expect.stringContaining("quota did not recover"),
    });
    h.advance(6 * 60 * 60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(5);
  });

  it("真实顺序 · 续跑长时间正常运转后才再次耗尽：连续计数清零，6 轮都不停", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = null;
    await h.fail("t31", { providerErrorCode: "1308", message: "usage limit" });
    for (let round = 0; round < 6; round += 1) {
      h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
      await h.service.wake();
      // 这一轮跑了 40 分钟才再次耗尽：有真实进展。
      h.advance(40 * 60_000);
      await h.failLatestTurnThenDetect("t31", {
        providerErrorCode: "1308",
        message: "usage limit reached for 5 hour",
      });
      expect(await active(h, "t31")).toMatchObject({
        status: "pending",
        kind: "quota",
        attempt: 0,
      });
    }
    expect(h.dispatch.sent).toHaveLength(6);
  });

  it("真实顺序 · detector 迟迟不来：宽限后按无法归因结算，绝不卡在 dispatched", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = null;
    await h.fail("t32", { providerErrorCode: "1308", message: "usage limit" });
    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    h.dispatch.waits.at(-1)!.resolve({ outcome: "failed", errorMessage: "resume turn failed" });
    await flush();
    expect(await active(h, "t32")).toMatchObject({ status: "dispatched" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await active(h, "t32")).toMatchObject({ status: "pending", attempt: 1 });

    // 迟到的 detector：用权威归因刷新既有意图（同类不改写到期时刻），不重复计 attempt。
    await h.service.handleSessionFailure(detect("t32", "1308", "usage limit reached for 5 hour"));
    expect(await active(h, "t32")).toMatchObject({ status: "pending", attempt: 1, kind: "quota" });
  });

  it("真实顺序 · 宽限内用户手动输入：意图取消，宽限定时器不再结算", async () => {
    const h = await createHarness();
    h.usage.state.usedPercent = null;
    await h.fail("t33", { providerErrorCode: "1308", message: "usage limit" });
    h.advance(RESUME_AFTER_CLAIM_DELAY_MS);
    await h.service.wake();
    h.dispatch.waits.at(-1)!.resolve({ outcome: "failed", errorMessage: "resume turn failed" });
    await flush();
    await h.service.cancelAutoResume({ taskId: "t33", reason: "user_manual_input" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await active(h, "t33")).toBeNull();
    h.advance(60 * 60_000);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);
  });

  it("真实顺序 · 上下文溢出保留 context 类别并重新武装压缩；套餐到期直接 exhausted", async () => {
    const h = await createHarness();
    await h.fail("t34", { providerErrorCode: "1261", message: "prompt is too long" });
    h.advance(RESUME_CONTEXT_COMPACT_DELAY_MS);
    await h.service.wake();
    h.dispatch.compactWork.delete("t34");
    h.advance(RESUME_COMPACT_WAIT_MS);
    await h.service.wake();
    expect(h.dispatch.sent).toHaveLength(1);

    await h.failLatestTurnThenDetect("t34", { providerErrorCode: "1261", message: "too long" });
    // 不是 transient、也不是"无法归因"：仍是 context，attempt 不动，等下一次压缩。
    expect(await active(h, "t34")).toMatchObject({
      kind: "context",
      status: "pending",
      attempt: 0,
    });

    const expired = await createHarness();
    await expired.fail("t35", { providerErrorCode: "1305", message: "rate limited" });
    expired.advance(60_000);
    await expired.service.wake();
    await expired.failLatestTurnThenDetect("t35", {
      providerErrorCode: "1309",
      message: "plan expired",
    });
    expect(await effective(expired, "t35")).toMatchObject({
      status: "exhausted",
      lastError: expect.stringContaining("plan_expired"),
    });
  });

  it("带归因的结局（旧 Agent / 其它通道）仍立即结算，不等待 detector", async () => {
    const h = await createHarness();
    await h.fail("t36", { providerErrorCode: "1305", message: "rate limited" });
    h.advance(60_000);
    await h.service.wake();
    await h.failLatestTurn("t36", { providerErrorCode: "1305", message: "rate limited" });
    expect(await active(h, "t36")).toMatchObject({ status: "pending", attempt: 1 });
  });
});
