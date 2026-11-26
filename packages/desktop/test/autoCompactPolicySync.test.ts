import { describe, expect, it, vi } from "vitest";
import {
  createAutoCompactPolicySync,
  isLiveLifecycleState,
  resolveAutoCompactPolicy,
  type AutoCompactPolicySyncDeps,
} from "@zcode/services/node";

// 自动压缩策略即时下发（chat 输入区 context 面板的开关 / 阈值）的宿主侧行为回归。
// 缺陷背景：设置此前只在会话物化时读取一次，正在用的会话切换开关 / 阈值完全不受影响。
// 安全边界：只向确认 live 的会话发命令——对冷会话发命令会在 CLI 侧建出空 publisher，
// 并把空摘要扇进 sessions-index。

const WS = "/tmp/workspace";

type Deps = AutoCompactPolicySyncDeps & {
  settings: { autoCompactEnabled: boolean; autoCompactThresholdPercent: number };
  activity: Map<string, { phase: string } | undefined>;
  lifecycle: Map<string, { state: string } | null>;
};

function createHarness() {
  const deps = {
    settings: { autoCompactEnabled: true, autoCompactThresholdPercent: 100 },
    candidates: [] as Array<{ workspacePath: string; sessionId: string }>,
    activity: new Map(),
    lifecycle: new Map(),
    readSettings: vi.fn(async function (this: Deps) {
      return this.settings;
    }),
    listCandidateSessions: vi.fn(function (this: Deps) {
      return this.candidates;
    }),
    getSessionActivity: vi.fn(function (this: Deps, sessionId: string) {
      return this.activity.get(sessionId) ?? null;
    }),
    getSessionLifecycle: vi.fn(async function (this: Deps, target: { sessionId: string }) {
      const state = this.lifecycle.get(target.sessionId);
      if (state === undefined) throw new Error("agent offline");
      return state;
    }),
    sendPolicy: vi.fn(async () => {}),
  };
  const sync = createAutoCompactPolicySync(deps as unknown as AutoCompactPolicySyncDeps);
  return { deps: deps as unknown as Deps, sync };
}

function target(sessionId: string) {
  return { workspacePath: WS, sessionId };
}

describe("resolveAutoCompactPolicy", () => {
  it("100 / 缺省 / 非法阈值都等价于未设置（统一算法）", () => {
    expect(
      resolveAutoCompactPolicy({ autoCompactEnabled: true, autoCompactThresholdPercent: 100 }),
    ).toEqual({ enabled: true });
    expect(
      resolveAutoCompactPolicy({
        autoCompactEnabled: true,
        autoCompactThresholdPercent: undefined,
      } as never),
    ).toEqual({ enabled: true });
    for (const invalid of [0, 101, Number.NaN, 50.5]) {
      expect(
        resolveAutoCompactPolicy({
          autoCompactEnabled: true,
          autoCompactThresholdPercent: invalid,
        }),
      ).toEqual({ enabled: true });
    }
  });

  it("10–99 的整数阈值原样下发；关闭时 enabled=false", () => {
    expect(
      resolveAutoCompactPolicy({ autoCompactEnabled: true, autoCompactThresholdPercent: 10 }),
    ).toEqual({ enabled: true, usagePercentTrigger: 10 });
    expect(
      resolveAutoCompactPolicy({ autoCompactEnabled: false, autoCompactThresholdPercent: 50 }),
    ).toEqual({ enabled: false, usagePercentTrigger: 50 });
    // autoCompactEnabled 缺省视为开启。
    expect(
      resolveAutoCompactPolicy({
        autoCompactEnabled: undefined,
        autoCompactThresholdPercent: 75,
      } as never),
    ).toEqual({ enabled: true, usagePercentTrigger: 75 });
  });
});

describe("isLiveLifecycleState", () => {
  it("只有 starting / ready 表示 CLI 侧有 live record", () => {
    expect(isLiveLifecycleState("ready")).toBe(true);
    expect(isLiveLifecycleState("starting")).toBe(true);
    for (const state of ["unloaded", "stopping", "failed", undefined]) {
      expect(isLiveLifecycleState(state)).toBe(false);
    }
  });
});

describe("autoCompactPolicySync.syncLiveSessions（设置变更）", () => {
  it("正在 running 的会话无需再确认，立即下发最新策略", async () => {
    const { deps, sync } = createHarness();
    deps.candidates = [target("running")];
    deps.activity.set("running", { phase: "running" });

    deps.settings.autoCompactThresholdPercent = 50;
    await sync.syncLiveSessions();

    expect(deps.sendPolicy).toHaveBeenCalledTimes(1);
    expect(deps.sendPolicy).toHaveBeenCalledWith(target("running"), {
      enabled: true,
      usagePercentTrigger: 50,
    });
    // running 是确凿事实，不再查生命周期。
    expect(deps.getSessionLifecycle).not.toHaveBeenCalled();
  });

  it("空闲但 CLI 侧仍 ready 的会话也下发（下一次发送时就按新策略）", async () => {
    const { deps, sync } = createHarness();
    deps.candidates = [target("idle-ready")];
    deps.lifecycle.set("idle-ready", { state: "ready" });

    deps.settings.autoCompactEnabled = false;
    await sync.syncLiveSessions();

    expect(deps.sendPolicy).toHaveBeenCalledWith(target("idle-ready"), { enabled: false });
  });

  it("绝不向冷会话发命令：unloaded / 生命周期查不到 / 查询抛错", async () => {
    const { deps, sync } = createHarness();
    deps.candidates = [target("unloaded"), target("unknown"), target("offline")];
    deps.lifecycle.set("unloaded", { state: "unloaded" });
    deps.lifecycle.set("unknown", null);

    deps.settings.autoCompactThresholdPercent = 30;
    await sync.syncLiveSessions();

    expect(deps.sendPolicy).not.toHaveBeenCalled();
  });

  it("已是最新策略的会话不重复下发", async () => {
    const { deps, sync } = createHarness();
    deps.candidates = [target("a")];
    deps.activity.set("a", { phase: "running" });

    deps.settings.autoCompactThresholdPercent = 50;
    await sync.syncLiveSessions();
    await sync.syncLiveSessions();
    expect(deps.sendPolicy).toHaveBeenCalledTimes(1);

    // 之后没有候选会话时也不读设置、不发命令。
    deps.candidates = [];
    await sync.syncLiveSessions();
    expect(deps.sendPolicy).toHaveBeenCalledTimes(1);
  });

  it("下发失败不记录签名：下一次触发会重试", async () => {
    const { deps, sync } = createHarness();
    deps.candidates = [target("a")];
    deps.activity.set("a", { phase: "running" });
    deps.sendPolicy.mockRejectedValueOnce(new Error("ack=rejected"));

    deps.settings.autoCompactThresholdPercent = 50;
    await sync.syncLiveSessions();
    expect(deps.sendPolicy).toHaveBeenCalledTimes(1);

    await sync.syncLiveSessions();
    expect(deps.sendPolicy).toHaveBeenCalledTimes(2);
    expect(deps.sendPolicy).toHaveBeenLastCalledWith(
      target("a"),
      expect.objectContaining({ usagePercentTrigger: 50 }),
    );
  });

  it("一个会话失败不影响其他会话下发", async () => {
    const { deps, sync } = createHarness();
    deps.candidates = [target("bad"), target("good")];
    deps.activity.set("bad", { phase: "running" });
    deps.activity.set("good", { phase: "running" });
    deps.sendPolicy.mockImplementation(async (session: { sessionId: string }) => {
      if (session.sessionId === "bad") throw new Error("ack=rejected");
    });

    deps.settings.autoCompactThresholdPercent = 20;
    await sync.syncLiveSessions();

    expect(deps.sendPolicy).toHaveBeenCalledTimes(2);
    expect(deps.sendPolicy).toHaveBeenCalledWith(target("good"), {
      enabled: true,
      usagePercentTrigger: 20,
    });
  });
});

describe("autoCompactPolicySync.syncOnTurnStart（会话开始新一轮）", () => {
  it("该会话最后下发的策略与当前设置不一致时补发", async () => {
    const { deps, sync } = createHarness();
    deps.activity.set("s", { phase: "running" });

    await sync.syncOnTurnStart(target("s"));
    expect(deps.sendPolicy).toHaveBeenCalledWith(target("s"), { enabled: true });

    // 设置在别处改了（会话当时不在候选里）：本轮开始补发。
    deps.settings.autoCompactThresholdPercent = 75;
    await sync.syncOnTurnStart(target("s"));
    expect(deps.sendPolicy).toHaveBeenLastCalledWith(
      target("s"),
      expect.objectContaining({ usagePercentTrigger: 75 }),
    );

    // 已一致：不重复下发。
    await sync.syncOnTurnStart(target("s"));
    expect(deps.sendPolicy).toHaveBeenCalledTimes(2);
  });

  it("冷会话不补发（物化时本来就会带上最新设置）", async () => {
    const { deps, sync } = createHarness();
    deps.lifecycle.set("cold", { state: "unloaded" });

    await sync.syncOnTurnStart(target("cold"));

    expect(deps.sendPolicy).not.toHaveBeenCalled();
  });
});
