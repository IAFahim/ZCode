import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

// 自动续跑在 v4 命令入口处的判定（纯函数 + 可注入 sleep；宿主 node.ts 把它们包在派发 port 与
// zcodeAgentService.sendConversationCommandV4 上）。两条都来自 v4.0.0-watchdog.3 首启实机：
// 1. 冷会话的 runtime 仍在初始化时，网关守卫拒绝命令（guard.runtimeInitializing）。守卫拒绝不记入
//    inbox 去重（command-inbox decide → remember:false），同一 commandId 原样重发即可；v3 却把它当成
//    派发失败丢进 30s 重试阶梯——重启后每个后台任务的首次续跑都白等半分钟，还消耗派发失败计数。
// 2. 桌面 composer / 手机 / Bot 直接走 sendConversationCommandV4，不经 zcodeTaskService.sendPrompt，
//    其 onManualPromptSubmitted 只覆盖 cron / 闲时派发。用户自己发消息 / 编辑重发 / 点重试之后旧意图
//    仍是 pending：用户那一轮结束后 watchdog 又注入一条续跑（spec §3.4「新消息即取消」落空）。

/** 守卫拒绝码：目标会话的 runtime 尚未 ready（bootstrap v4-gateway guard）。 */
export const RUNTIME_INITIALIZING_REASON = "guard.runtimeInitializing";
/** 轮询间隔与上限（≈30s）：覆盖大历史的冷恢复；触顶后交还意图的 30s 派发重试阶梯。 */
export const RESUME_RUNTIME_READY_RETRY_DELAY_MS = 1_000;
export const RESUME_RUNTIME_READY_MAX_RETRIES = 30;

/** 只读取判定需要的三个字段；CommandEnvelope 与宿主内其它信封构造器都能直接传入。 */
export interface CommandEnvelopeLike {
  type: string;
  sessionId?: string | null;
  payload?: unknown;
}

/** 用户主动开启 / 改投一轮的 v4 命令。 */
const USER_TURN_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "sendText",
  "editUserQuery",
  "retryTurn",
  "sendQueuedNow",
]);

/**
 * 用户接管 = 带会话的「开启 / 改投一轮」命令且无后台归因。归因字段与 v4 sendText payload 的
 * automationId / offPeakTaskId / resumeIntentId（互斥）一致：续跑自身、定时任务、闲时任务都不算接管。
 * 四种命令都只由 UI / 客户端发出：composer 发送、编辑重发、手动重试、立即发送排队项
 * （后三种同样绕过 sendPrompt，是 spec §3.4 一直"暂缓"的 renderer editUserQuery 一类）。
 */
export function isUserTakeoverCommand(envelope: CommandEnvelopeLike): boolean {
  if (!envelope.sessionId || !USER_TURN_COMMAND_TYPES.has(envelope.type)) return false;
  const { payload } = envelope;
  if (!payload || typeof payload !== "object") return false;
  const { automationId, offPeakTaskId, resumeIntentId } = payload as Record<string, unknown>;
  return !automationId && !offPeakTaskId && !resumeIntentId;
}

/** 编辑重发被拦下（文件冲突，composer 保留编辑态）：命令被接纳但没有开新一轮，不算接管。 */
function isBlockedEdit(ack: Pick<CommandAck, "result">): boolean {
  return ack.result?.type === "editUserQuery" && ack.result.disposition === "blocked";
}

/** 网关守卫以「runtime 未就绪」拒绝：不是命令本身有问题，稍后原样重发即可。 */
export function isRuntimeInitializingRejection(
  ack: Pick<CommandAck, "status" | "reasonCode">,
): boolean {
  return ack.status === "rejected" && ack.reasonCode === RUNTIME_INITIALIZING_REASON;
}

export interface RuntimeReadyRetryDeps {
  retryDelayMs: number;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 逐次重发，直到命令不再因 runtime 初始化被拒；重试触顶时返回最后一次 ack，由调用方按普通拒绝处理。
 * 只对 guard.runtimeInitializing 重发：其它 rejected / stale 不重试；duplicate / noop 不会开新一轮，
 * 重发只会得到同一个答复。
 */
export async function sendAfterRuntimeReady<T extends CommandAck>(
  send: () => Promise<T>,
  deps: RuntimeReadyRetryDeps = {
    retryDelayMs: RESUME_RUNTIME_READY_RETRY_DELAY_MS,
    maxRetries: RESUME_RUNTIME_READY_MAX_RETRIES,
  },
): Promise<T> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let ack = await send();
  for (
    let retries = 0;
    retries < deps.maxRetries && isRuntimeInitializingRejection(ack);
    retries++
  ) {
    await sleep(deps.retryDelayMs);
    ack = await send();
  }
  return ack;
}

/**
 * 包一层 v4 命令入口：被接纳的用户接管命令即取消该会话在途的自动续跑意图。
 * 只在 ack 为 accepted 后触发——被拒绝 / 过期的输入没有开新一轮，续跑仍应照常进行。
 * 取消失败不改变命令裁决（cancel 自身吞掉仓库错误；这里的 catch 只兜底意外的同步异常）。
 */
export function withUserTakeoverCancel<
  P extends { envelope: CommandEnvelopeLike },
  T extends Pick<CommandAck, "status" | "result">,
>(
  send: (params: P) => Promise<T>,
  cancel: (sessionId: string) => Promise<void>,
): (params: P) => Promise<T> {
  return async (params) => {
    const ack = await send(params);
    if (
      ack.status === "accepted" &&
      !isBlockedEdit(ack) &&
      isUserTakeoverCommand(params.envelope)
    ) {
      const sessionId = params.envelope.sessionId;
      if (sessionId) await cancel(sessionId).catch(() => undefined);
    }
    return ack;
  };
}
