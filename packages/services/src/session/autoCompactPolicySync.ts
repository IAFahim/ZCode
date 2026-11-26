import type { AppSettings } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ZCodeAgentSessionTarget } from "../zcode-agent/zcodeAgent.js";

// 自动压缩策略的即时下发（chat 输入区 context 面板的开关 / 阈值）。
// Bugfix：设置此前只在会话"物化"（创建 / 冷恢复）时读取一次——用户在正在用的会话里切换
// 开关或阈值，这个会话完全不受影响，要重开或重启才生效。v3 经 v4 setAutoCompactPolicy
// 把策略即时写进 live 会话的 runtime（压缩策略每个模型步重新读取，运行中也立即生效）。
//
// 两条触发：
// 1. 设置变更 → 下发给所有仍 live 的会话（正在运行的立刻生效，不必等下一轮）。
// 2. 会话从空闲进入 running → 若该会话最后下发的策略与当前设置不一致，补发一次
//    （覆盖"改设置时会话空闲"以及"设置改在别的窗口"的情况；最迟本轮第二个模型步生效）。
//
// 安全边界：只向确认 live 的会话发命令。对冷会话发命令会在 CLI 侧建出空 publisher，
// 并把空摘要扇进 sessions-index；冷会话下次物化时本来就会带上最新设置。

const serviceLogger = createServiceLogger("auto-compact-policy-sync");

export interface AutoCompactPolicy {
  enabled: boolean;
  /** 1–99 生效；缺省 = 统一算法（尽量晚压缩）。 */
  usagePercentTrigger?: number;
}

export interface AutoCompactPolicySyncDeps {
  readSettings: () => Promise<
    Pick<AppSettings, "autoCompactEnabled" | "autoCompactThresholdPercent">
  >;
  /** 自当前 runtime 代际以来观察到处于运行态的会话（候选）。 */
  listCandidateSessions: () => ZCodeAgentSessionTarget[];
  /** sessions-index 最新态：正在 running / prewarming 的会话无需再确认。 */
  getSessionActivity(sessionId: string): { phase: string } | null;
  /** 会话生命周期（CLI 侧是否有 live record）。null = Agent 不支持，无法确认。 */
  getSessionLifecycle(target: ZCodeAgentSessionTarget): Promise<{ state: string } | null>;
  sendPolicy(target: ZCodeAgentSessionTarget, policy: AutoCompactPolicy): Promise<void>;
}

/** AppSettings → 下发给 Agent 的策略。100 等价于"未设置"。 */
export function resolveAutoCompactPolicy(
  settings: Pick<AppSettings, "autoCompactEnabled" | "autoCompactThresholdPercent">,
): AutoCompactPolicy {
  const percent = settings.autoCompactThresholdPercent;
  // Bugfix：协议要求阈值为整数，非整数曾原样下发——命令面必然拒绝，签名永不记录，
  // 于是每一轮开始都重发一次必然失败的命令。非整数在此按"未设置"收口。
  return {
    enabled: settings.autoCompactEnabled !== false,
    ...(typeof percent === "number" && Number.isInteger(percent) && percent >= 1 && percent < 100
      ? { usagePercentTrigger: percent }
      : {}),
  };
}

/** 会话生命周期是否表示 CLI 侧有 live record。 */
export function isLiveLifecycleState(state: string | undefined): boolean {
  return state === "ready" || state === "starting";
}

function policySignature(policy: AutoCompactPolicy): string {
  return `${policy.enabled ? "on" : "off"}:${policy.usagePercentTrigger ?? 100}`;
}

export function createAutoCompactPolicySync(deps: AutoCompactPolicySyncDeps) {
  /** 每个会话最后一次成功下发的策略（按签名去重，避免每轮开始都重复下发）。 */
  const pushed = new Map<string, string>();

  async function isLive(target: ZCodeAgentSessionTarget): Promise<boolean> {
    const phase = deps.getSessionActivity(target.sessionId)?.phase;
    if (phase === "running" || phase === "prewarming") return true;
    try {
      const lifecycle = await deps.getSessionLifecycle(target);
      // 读不到生命周期（旧 Agent / 查询失败）时无法确认 live：宁可不发。
      return lifecycle !== null && isLiveLifecycleState(lifecycle.state);
    } catch {
      return false;
    }
  }

  async function push(target: ZCodeAgentSessionTarget, policy: AutoCompactPolicy): Promise<void> {
    if (!(await isLive(target))) return;
    try {
      await deps.sendPolicy(target, policy);
      pushed.set(target.sessionId, policySignature(policy));
    } catch (error) {
      // 下发失败：下次触发会重试（签名不记录）。
      pushed.delete(target.sessionId);
      serviceLogger.warn("auto-compact policy push failed", {
        sessionId: target.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    /** 会话开始新一轮：策略与当前设置不一致才下发。 */
    async syncOnTurnStart(target: ZCodeAgentSessionTarget): Promise<void> {
      const policy = resolveAutoCompactPolicy(await deps.readSettings());
      if (pushed.get(target.sessionId) === policySignature(policy)) return;
      await push(target, policy);
    },

    /** 设置变更：下发给所有仍 live 的候选会话。 */
    async syncLiveSessions(): Promise<void> {
      const candidates = deps.listCandidateSessions();
      if (candidates.length === 0) return;
      const policy = resolveAutoCompactPolicy(await deps.readSettings());
      // 已是最新策略的会话不再重复下发（候选可能因别的设置键变更被带到）。
      const signature = policySignature(policy);
      const stale = candidates.filter((target) => pushed.get(target.sessionId) !== signature);
      if (stale.length === 0) return;
      serviceLogger.info("auto-compact setting changed, pushing to live sessions", {
        policy: signature,
        candidates: stale.length,
      });
      await Promise.all(stale.map((target) => push(target, policy)));
    },
  };
}

export type AutoCompactPolicySync = ReturnType<typeof createAutoCompactPolicySync>;
