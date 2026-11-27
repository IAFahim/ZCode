import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUserTakeoverCommand,
  isRuntimeInitializingRejection,
  QuotaWatchdogService,
  RESUME_AFTER_CLAIM_DELAY_MS,
  RESUME_DISPATCH_RETRY_MS,
  ResumeIntentRepo,
  RESUME_RUNTIME_READY_MAX_RETRIES,
  RESUME_RUNTIME_READY_RETRY_DELAY_MS,
  RUNTIME_INITIALIZING_REASON,
  sendAfterRuntimeReady,
  withUserTakeoverCancel,
  type CommandEnvelopeLike,
  type QuotaResumeDispatchPort,
  type TurnOutcomeWaitResult,
} from "@zcode/services/node";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

// v4 命令入口处的两条自动续跑规则（宿主 node.ts 装配），对应 v4.0.0-watchdog.3 首启实机的两个缺陷：
// 1. 冷会话 runtime 仍在初始化 → 网关守卫拒绝（guard.runtimeInitializing）。守卫拒绝不记入 inbox
//    去重，同一 commandId 原样重发即可；v3 却当成派发失败丢进 30s 阶梯，重启后每个后台任务白等半分钟。
// 2. 桌面 composer / 手机 / Bot 直接走 sendConversationCommandV4，不经 sendPrompt 的
//    onManualPromptSubmitted：用户自己发消息 / 编辑重发 / 点重试后旧意图仍是 pending，
//    用户那一轮结束后又被注入续跑。

const T0 = 1_700_000_000_000;
const WS = "/tmp/workspace";

const rejectedWhileInitializing = (): CommandAck =>
  ({
    commandId: "cmd",
    status: "rejected",
    reasonCode: RUNTIME_INITIALIZING_REASON,
    message: "runtime is initializing",
  }) as CommandAck;

const accepted = (): CommandAck => ({ commandId: "cmd", status: "accepted" }) as CommandAck;

describe("isUserTakeoverCommand", () => {
  it("带会话、无后台归因的 sendText 是用户接管", () => {
    expect(
      isUserTakeoverCommand({ type: "sendText", sessionId: "sess_1", payload: { text: "hi" } }),
    ).toBe(true);
    // payload 里还有别的字段（heldQueueDisposition / attachments / modelSelection …）不影响判定。
    expect(
      isUserTakeoverCommand({
        type: "sendText",
        sessionId: "sess_1",
        payload: { text: "hi", heldQueueDisposition: "keepQueueAndSend", clientId: "c" },
      }),
    ).toBe(true);
  });

  it("续跑 / 定时任务 / 闲时任务的 sendText 不算接管", () => {
    for (const attribution of [
      { resumeIntentId: "ri_1" },
      { automationId: "a_1" },
      { offPeakTaskId: "o_1" },
    ]) {
      expect(
        isUserTakeoverCommand({
          type: "sendText",
          sessionId: "sess_1",
          payload: { text: "continue", ...attribution },
        }),
      ).toBe(false);
    }
  });

  it("编辑重发 / 手动重试 / 立即发送排队项同样是用户接管（都只由 UI / 客户端发出，不带归因）", () => {
    for (const type of ["editUserQuery", "retryTurn", "sendQueuedNow"]) {
      expect(
        isUserTakeoverCommand({
          type,
          sessionId: "sess_1",
          payload: { target: { rowId: "row_1" } },
        }),
      ).toBe(true);
      // 带后台归因的同类命令（今后若有）不算接管。
      expect(
        isUserTakeoverCommand({
          type,
          sessionId: "sess_1",
          payload: { target: { rowId: "row_1" }, resumeIntentId: "ri_1" },
        }),
      ).toBe(false);
    }
  });

  it("其它命令、无会话、无 payload 都不算", () => {
    for (const type of ["compact", "interrupt", "forkAssistant", "applyFileRewind"]) {
      expect(isUserTakeoverCommand({ type, sessionId: "sess_1", payload: {} })).toBe(false);
    }
    expect(
      isUserTakeoverCommand({ type: "sendText", sessionId: null, payload: { text: "hi" } }),
    ).toBe(false);
    expect(isUserTakeoverCommand({ type: "sendText", payload: { text: "hi" } })).toBe(false);
    expect(isUserTakeoverCommand({ type: "sendText", sessionId: "sess_1" })).toBe(false);
    expect(isUserTakeoverCommand({ type: "sendText", sessionId: "sess_1", payload: "hi" })).toBe(
      false,
    );
    expect(isUserTakeoverCommand({ type: "retryTurn", sessionId: "sess_1" })).toBe(false);
  });
});

describe("isRuntimeInitializingRejection", () => {
  it("只认 rejected + guard.runtimeInitializing", () => {
    expect(isRuntimeInitializingRejection(rejectedWhileInitializing())).toBe(true);
    expect(isRuntimeInitializingRejection(accepted())).toBe(false);
    // runtime 初始化失败是终态：原样重发无济于事。
    expect(
      isRuntimeInitializingRejection({
        status: "rejected",
        reasonCode: "guard.runtimeInitializationFailed",
      }),
    ).toBe(false);
    expect(
      isRuntimeInitializingRejection({ status: "rejected", reasonCode: "proto.staleRevision" }),
    ).toBe(false);
    expect(isRuntimeInitializingRejection({ status: "rejected" })).toBe(false);
    expect(isRuntimeInitializingRejection({ status: "duplicate" })).toBe(false);
  });
});

describe("sendAfterRuntimeReady", () => {
  /** 记录每次 sleep 的假时钟：不真等，也不让事件循环空转。 */
  function createSleep() {
    const slept: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      slept.push(ms);
    });
    return { sleep, slept };
  }

  it("runtime 初始化期间被拒就原样重发，直到被接纳", async () => {
    const { sleep, slept } = createSleep();
    const send = vi
      .fn<() => Promise<CommandAck>>()
      .mockResolvedValueOnce(rejectedWhileInitializing())
      .mockResolvedValueOnce(rejectedWhileInitializing())
      .mockResolvedValueOnce(accepted());

    await expect(
      sendAfterRuntimeReady(send, { sleep, retryDelayMs: 1_000, maxRetries: 5 }),
    ).resolves.toEqual(accepted());
    expect(send).toHaveBeenCalledTimes(3);
    // commandId 由调用方闭包固定：守卫拒绝不记入去重，重发用的是同一个 id。
    expect(slept).toEqual([1_000, 1_000]);
  });

  it("首个 ack 不是守卫拒绝时不重试", async () => {
    const { sleep } = createSleep();
    for (const ack of [
      accepted(),
      { status: "duplicate" },
      { status: "noop" },
      { status: "rejected", reasonCode: "proto.staleRevision" },
    ] as CommandAck[]) {
      const send = vi.fn(async () => ack);
      await expect(
        sendAfterRuntimeReady(send, { sleep, retryDelayMs: 1_000, maxRetries: 5 }),
      ).resolves.toBe(ack);
      expect(send).toHaveBeenCalledTimes(1);
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("send 抛错原样上抛（不是守卫拒绝，由调用方按派发失败处理）", async () => {
    const { sleep } = createSleep();
    const send = vi.fn(async () => {
      throw new Error("agent offline");
    });
    await expect(
      sendAfterRuntimeReady(send, { sleep, retryDelayMs: 1_000, maxRetries: 5 }),
    ).rejects.toThrow("agent offline");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("一直被拒：重试触顶后交还最后一次 ack，不再无限等", async () => {
    const { sleep, slept } = createSleep();
    const send = vi.fn(async () => rejectedWhileInitializing());
    const last = await sendAfterRuntimeReady(send, {
      sleep,
      retryDelayMs: RESUME_RUNTIME_READY_RETRY_DELAY_MS,
      maxRetries: RESUME_RUNTIME_READY_MAX_RETRIES,
    });
    expect(last).toEqual(rejectedWhileInitializing());
    expect(send).toHaveBeenCalledTimes(RESUME_RUNTIME_READY_MAX_RETRIES + 1);
    expect(slept).toHaveLength(RESUME_RUNTIME_READY_MAX_RETRIES);
  });

  it("缺省参数：1s 间隔、30 次上限（≈ 最长 30s，交给意图的 30s 派发重试阶梯之前的有界等待）", () => {
    expect(RESUME_RUNTIME_READY_RETRY_DELAY_MS).toBe(1_000);
    expect(RESUME_RUNTIME_READY_MAX_RETRIES).toBe(30);
  });
});

describe("withUserTakeoverCancel", () => {
  interface Params {
    workspacePath: string;
    envelope: CommandEnvelopeLike;
  }

  it("被接纳的用户接管 → 取消该会话的在途续跑", async () => {
    const send = vi.fn(async (_params: Params) => accepted());
    const cancel = vi.fn(async (_sessionId: string) => {});
    const wrapped = withUserTakeoverCancel<Params, CommandAck>(send, cancel);

    const params: Params = {
      workspacePath: WS,
      envelope: { type: "sendText", sessionId: "sess_1", payload: { text: "continue myself" } },
    };
    await expect(wrapped(params)).resolves.toEqual(accepted());
    expect(send).toHaveBeenCalledWith(params);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("sess_1");

    // 用户自己点了重试：同样是接管。
    await wrapped({
      workspacePath: WS,
      envelope: { type: "retryTurn", sessionId: "sess_2", payload: { target: { rowId: "row_1" } } },
    });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenLastCalledWith("sess_2");
  });

  it("编辑重发被拦下（disposition=blocked）：命令被接纳但没有开新一轮，不取消", async () => {
    const cancel = vi.fn(async (_sessionId: string) => {});
    const editParams: Params = {
      workspacePath: WS,
      envelope: {
        type: "editUserQuery",
        sessionId: "sess_1",
        payload: { target: { rowId: "row_1" }, newText: "edited" },
      },
    };
    const blocked = {
      commandId: "cmd",
      status: "accepted",
      result: { type: "editUserQuery", disposition: "blocked", sessionId: "sess_1" },
    } as CommandAck;
    const blockedSend = withUserTakeoverCancel<Params, CommandAck>(async () => blocked, cancel);
    await expect(blockedSend(editParams)).resolves.toBe(blocked);
    expect(cancel).not.toHaveBeenCalled();

    // 真正改投成功（rewind）才算接管。
    const rewound = {
      commandId: "cmd",
      status: "accepted",
      result: { type: "editUserQuery", disposition: "rewind", sessionId: "sess_1" },
    } as CommandAck;
    const rewindSend = withUserTakeoverCancel<Params, CommandAck>(async () => rewound, cancel);
    await rewindSend(editParams);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("sess_1");
  });

  it("自动续跑自己的 sendText 不会把别的意图取消掉", async () => {
    const send = vi.fn(async (_params: Params) => accepted());
    const cancel = vi.fn(async (_sessionId: string) => {});
    const wrapped = withUserTakeoverCancel<Params, CommandAck>(send, cancel);

    await wrapped({
      workspacePath: WS,
      envelope: {
        type: "sendText",
        sessionId: "sess_1",
        payload: { text: "continue", resumeIntentId: "ri_1" },
      },
    });
    // 非手动命令（compact / setAutoCompactPolicy …）同样不触发。
    await wrapped({
      workspacePath: WS,
      envelope: { type: "compact", sessionId: "sess_1", payload: {} },
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("被拒绝 / 过期的接管命令没有开新一轮：不取消", async () => {
    for (const ack of [
      { status: "rejected" },
      { status: "stale" },
      { status: "failed" },
      { status: "duplicate" },
    ] as CommandAck[]) {
      const send = vi.fn(async (_params: Params) => ack);
      const cancel = vi.fn(async (_sessionId: string) => {});
      const wrapped = withUserTakeoverCancel<Params, CommandAck>(send, cancel);
      await expect(
        wrapped({
          workspacePath: WS,
          envelope: { type: "sendText", sessionId: "sess_1", payload: { text: "hi" } },
        }),
      ).resolves.toBe(ack);
      expect(cancel).not.toHaveBeenCalled();
    }
  });

  it("取消出错不改变命令裁决；下游抛错原样上抛", async () => {
    const ack = accepted();
    const failingCancel = withUserTakeoverCancel<Params, CommandAck>(
      async () => ack,
      async () => {
        throw new Error("repo locked");
      },
    );
    await expect(
      failingCancel({
        workspacePath: WS,
        envelope: { type: "sendText", sessionId: "sess_1", payload: { text: "hi" } },
      }),
    ).resolves.toBe(ack);

    const send = vi.fn(async () => {
      throw new Error("agent offline");
    });
    const wrapped = withUserTakeoverCancel<Params, CommandAck>(send, async () => {});
    await expect(
      wrapped({
        workspacePath: WS,
        envelope: { type: "sendText", sessionId: "sess_1", payload: { text: "hi" } },
      }),
    ).rejects.toThrow("agent offline");
  });
});

/** 与 node.ts 的 resume port 同形：sendResumeText = sendAfterRuntimeReady(sendConversationCommandV4)。 */
function createRuntimeAwarePort() {
  const activity = new Map<string, "active" | "idle" | "unknown">();
  const acks: CommandAck[] = [];
  const sleeps: number[] = [];
  const waits: Array<{ inputId: string; resolve: (value: TurnOutcomeWaitResult) => void }> = [];
  const state = {
    /** 每次调用的 ack 队列；用尽后恒为 accepted。 */
    script: [] as CommandAck[],
    useRuntimeReadyWait: true,
    maxRetries: RESUME_RUNTIME_READY_MAX_RETRIES,
  };
  const sendConversationCommandV4 = vi.fn(async (): Promise<CommandAck> => {
    const ack = state.script.length > 0 ? state.script.shift()! : accepted();
    acks.push(ack);
    return ack;
  });
  const send = () => sendConversationCommandV4();
  const port: QuotaResumeDispatchPort = {
    getTaskActivity: ({ taskId }) => activity.get(taskId) ?? "idle",
    isCompactWorkActive: () => false,
    sendResumeText: async () => {
      const ack = state.useRuntimeReadyWait
        ? await sendAfterRuntimeReady(send, {
            retryDelayMs: RESUME_RUNTIME_READY_RETRY_DELAY_MS,
            maxRetries: state.maxRetries,
            sleep: async (ms) => {
              sleeps.push(ms);
            },
          })
        : await send();
      if (ack.status === "accepted") return "accepted";
      throw new Error(
        `resume command rejected (${ack.status}${ack.reasonCode ? `: ${ack.reasonCode}` : ""})`,
      );
    },
    requestCompact: async () => "accepted",
    subscribeOutcome: (input) => {
      let resolve!: (value: TurnOutcomeWaitResult) => void;
      const result = new Promise<TurnOutcomeWaitResult>((resolvePromise) => {
        resolve = resolvePromise;
      });
      waits.push({ inputId: input.expectedInputId, resolve });
      return { result, dispose: () => {} };
    },
  };
  return { port, activity, acks, sleeps, waits, state, sendConversationCommandV4 };
}

describe("自动续跑 × runtime 初始化（真实 QuotaWatchdogService + 真实意图仓库）", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  async function createHarness(options: { wrapCommandEntry?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "quota-resume-guard-"));
    const repo = new ResumeIntentRepo(join(dir, "tasks-index.sqlite"));
    const runtime = createRuntimeAwarePort();
    let now = T0;
    const settings = {
      autoResumeEnabled: true,
      autoClaimResetCardsEnabled: true,
      quotaWatchThresholdPercent: 10,
      autoResumeMaxConsecutive: 5,
    };
    const service = new QuotaWatchdogService({
      usageStatsService: {
        // 额度未耗尽：失败走探测续跑，直接进派发门。
        async getEntitlementSnapshot() {
          return {
            generatedAt: 1,
            authenticated: true,
            provider: { id: "bigmodel", name: "BigModel" },
            remaining: { count: 0, isShow: true, percentage: 40, nextResetTime: null },
            subscription: null,
            quota: null,
          };
        },
        async getCodingPlanResetStatus() {
          return {
            availableFiveHourResets: [],
            availableWeekResets: [],
            latestFiveHourResetHistory: null,
            latestWeekResetHistory: null,
            hasUnreadHistory: false,
          };
        },
      } as never,
      resumeIntentRepo: repo,
      settingService: { get: async () => settings } as never,
      dispatch: runtime.port,
      resolveResetScope: async () => ({
        preferredProviderId: "bigmodel",
        accountAccess: "personal",
      }),
      now: () => now,
    });
    // 与 node.ts 相同的装配：v4 命令总入口包一层"用户接管即取消"。
    const sendConversationCommandV4 = options.wrapCommandEntry
      ? withUserTakeoverCancel<{ envelope: CommandEnvelopeLike }, CommandAck>(
          () => runtime.sendConversationCommandV4(),
          (taskId) => service.cancelAutoResume({ taskId, reason: "user_manual_input" }),
        )
      : undefined;
    cleanups.push(async () => {
      service.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    });
    /** 失败 → 到期 → 派发门放行，返回当前意图状态。 */
    const failAndDispatch = async (taskId: string) => {
      await service.handleSessionFailure({
        taskId,
        workspacePath: WS,
        providerErrorCode: "1308",
        message: "usage limit reached",
        via: "detector",
      });
      now += RESUME_AFTER_CLAIM_DELAY_MS;
      await service.wake();
      return repo.getActiveByTask(taskId);
    };
    return {
      service,
      repo,
      runtime,
      settings,
      sendConversationCommandV4,
      now: () => now,
      failAndDispatch,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("runtime 初始化期间被拒：原地重发直到接纳，不进 30s 派发失败阶梯", async () => {
    const h = await createHarness();
    // 冷会话：前两次命令被网关守卫拒绝（v4.0.0-watchdog.3 首启实机日志），第三次接纳。
    h.runtime.state.script.push(rejectedWhileInitializing(), rejectedWhileInitializing());

    const intent = await h.failAndDispatch("t1");
    expect(h.runtime.acks.map((ack) => ack.status)).toEqual(["rejected", "rejected", "accepted"]);
    expect(h.runtime.sleeps).toEqual([
      RESUME_RUNTIME_READY_RETRY_DELAY_MS,
      RESUME_RUNTIME_READY_RETRY_DELAY_MS,
    ]);
    expect(intent).toMatchObject({ status: "dispatched", attempt: 0 });
    // lastError 仍是原始失败信息，不是 "dispatch failed: …"。
    expect(intent?.lastError).not.toContain("dispatch failed");
    // 结局等待恰好一条，绑定本轮 inputId；没有多余的派发。
    expect(h.runtime.waits).toHaveLength(1);
    expect(h.runtime.waits[0]!.inputId).toMatch(/^resume-/);
  });

  it("对照：不等待 runtime 就绪时，同样的拒绝会让意图退回 pending 并白等 30 秒", async () => {
    const h = await createHarness();
    h.runtime.state.useRuntimeReadyWait = false;
    h.runtime.state.script.push(rejectedWhileInitializing());

    const intent = await h.failAndDispatch("t1");
    expect(h.runtime.acks.map((ack) => ack.status)).toEqual(["rejected"]);
    expect(intent).toMatchObject({
      status: "pending",
      attempt: 0,
      nextEligibleAt: h.now() + RESUME_DISPATCH_RETRY_MS,
    });
    expect(intent?.lastError).toContain("dispatch failed: resume command rejected");
    expect(intent?.lastError).toContain(RUNTIME_INITIALIZING_REASON);
    expect(h.runtime.waits).toHaveLength(1);
  });

  it("等待触顶（runtime 始终不就绪）：按普通派发失败处理，交给 30 秒阶梯", async () => {
    const h = await createHarness();
    h.runtime.state.maxRetries = 3;
    h.runtime.state.script.push(
      rejectedWhileInitializing(),
      rejectedWhileInitializing(),
      rejectedWhileInitializing(),
      rejectedWhileInitializing(),
    );

    const intent = await h.failAndDispatch("t1");
    expect(h.runtime.acks).toHaveLength(4);
    expect(h.runtime.sleeps).toHaveLength(3);
    expect(intent).toMatchObject({
      status: "pending",
      nextEligibleAt: h.now() + RESUME_DISPATCH_RETRY_MS,
    });
    expect(intent?.lastError).toContain(RUNTIME_INITIALIZING_REASON);
  });

  it("runtime 初始化失败是终态拒绝：不重试，直接按派发失败处理", async () => {
    const h = await createHarness();
    h.runtime.state.script.push({
      commandId: "cmd",
      status: "rejected",
      reasonCode: "guard.runtimeInitializationFailed",
    } as CommandAck);

    const intent = await h.failAndDispatch("t1");
    expect(h.runtime.acks).toHaveLength(1);
    expect(h.runtime.sleeps).toHaveLength(0);
    expect(intent).toMatchObject({ status: "pending" });
  });

  it("用户手动输入被接纳 → 该会话的 pending 续跑意图取消（不再于用户那一轮结束后注入续跑）", async () => {
    const h = await createHarness({ wrapCommandEntry: true });
    await h.service.handleSessionFailure({
      taskId: "t1",
      workspacePath: WS,
      providerErrorCode: "1308",
      message: "usage limit reached",
      via: "detector",
    });
    expect(await h.repo.getActiveByTask("t1")).toMatchObject({ status: "pending" });
    const repoCancel = vi.spyOn(h.repo, "cancel");

    // 桌面 composer 发出的用户消息：无归因的 sendText，经 v4 命令总入口。
    const ack = await h.sendConversationCommandV4!({
      envelope: { type: "sendText", sessionId: "t1", payload: { text: "I'll take it from here" } },
    });
    expect(ack.status).toBe("accepted");
    // 确实改到了行（changes > 0），理由与 adapter 钩子同款。
    expect(repoCancel).toHaveBeenCalledWith("t1", "user_manual_input");
    expect(await repoCancel.mock.results[0]!.value).toBe(true);
    // 取消后的意图对调度面与展示面都不可见。
    expect(await h.repo.getActiveByTask("t1")).toBeNull();
    expect(await h.repo.getEffectiveByTask("t1")).toBeNull();
    expect(await h.repo.listPending()).toEqual([]);

    // 用户的消息不是续跑：这一条 accept 之外没有别的命令发出；到期后 tick 也不再派发。
    expect(h.runtime.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    h.runtime.state.script.length = 0;
    const before = h.runtime.acks.length;
    await h.service.wake();
    expect(h.runtime.acks).toHaveLength(before);
  });

  it("其它会话的手动输入不影响本会话的续跑意图", async () => {
    const h = await createHarness({ wrapCommandEntry: true });
    await h.service.handleSessionFailure({
      taskId: "t1",
      workspacePath: WS,
      providerErrorCode: "1308",
      message: "usage limit reached",
      via: "detector",
    });
    await h.sendConversationCommandV4!({
      envelope: { type: "sendText", sessionId: "t_other", payload: { text: "hi" } },
    });
    expect(await h.repo.getActiveByTask("t1")).toMatchObject({ status: "pending" });
  });

  it("用户自己点了重试（retryTurn）并被接纳 → pending 意图取消；重试再失败则由 detector 重新建意图", async () => {
    const h = await createHarness({ wrapCommandEntry: true });
    await h.service.handleSessionFailure({
      taskId: "t1",
      workspacePath: WS,
      providerErrorCode: "1308",
      message: "usage limit reached",
      via: "detector",
    });
    expect(await h.repo.getActiveByTask("t1")).toMatchObject({ status: "pending" });

    const ack = await h.sendConversationCommandV4!({
      envelope: { type: "retryTurn", sessionId: "t1", payload: { target: { rowId: "row_1" } } },
    });
    expect(ack.status).toBe("accepted");
    expect(await h.repo.getActiveByTask("t1")).toBeNull();

    // 取消只作废那一条旧意图：用户的手动重试再次以 1308 失败，自动续跑照常重新接管
    // （同签名失败只在 5 秒内去重，为的是合并 detector 与结局通道的同一次上报；人工重试总在其后）。
    h.advance(6_000);
    await h.service.handleSessionFailure({
      taskId: "t1",
      workspacePath: WS,
      providerErrorCode: "1308",
      message: "usage limit reached",
      via: "detector",
    });
    expect(await h.repo.getActiveByTask("t1")).toMatchObject({ status: "pending", attempt: 0 });
  });
});
