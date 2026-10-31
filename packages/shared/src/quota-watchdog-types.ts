// ---- 配额守护与自动续跑(Quota Watchdog + Auto-Resume)领域类型 ----
// resume_intents 存 tasks-index.sqlite（与 off_peak_tasks 同库）。
// 领域规则见 docs/quota-watchdog/spec.md；模块放置与接线见 docs/quota-watchdog/tech-design.md。
// sqlite 列名 snake_case，此处为跨域 camelCase 领域类型。

/**
 * 看门狗状态机。运行态唯一所有者是 Host 进程内的 quotaWatchdogService（spec §4）：
 * idle=被动（remaining > 阈值，零新增周期请求）；watching=额度 ≤ 阈值，自适应观察；
 * claiming=额度 ≤1% 且存在可认领重置卡，正在核销；waiting_reset=额度 ≈0 无卡可领，
 * 休眠到 nextResetTime+60s；restored=核实 remaining > 0，本耗尽周期内发一次 quotaRestored。
 */
export type QuotaWatchdogState = "idle" | "watching" | "claiming" | "waiting_reset" | "restored";

/** 看门狗消费的 4 项设置（schema 见 validationAppSettings.ts；默认全开，opt-out）。 */
export interface QuotaWatchdogSettings {
  autoResumeEnabled: boolean;
  autoClaimResetCardsEnabled: boolean;
  /** WATCHING 进入线（百分比 1–50；≤1% 的 CLAIMING 线固定，不随设置变化）。 */
  quotaWatchThresholdPercent: number;
  /** 同一 task 连续自动续跑上限（无一次成功 turn 即停）。 */
  autoResumeMaxConsecutive: number;
}

export const QUOTA_WATCHDOG_DEFAULT_SETTINGS: QuotaWatchdogSettings = {
  autoResumeEnabled: true,
  autoClaimResetCardsEnabled: true,
  quotaWatchThresholdPercent: 10,
  autoResumeMaxConsecutive: 5,
};

/** 续跑意图类别：quota=等待套餐配额重置；transient=退避阶梯重试。 */
export type ResumeIntentKind = "quota" | "transient";

export type ResumeIntentStatus = "pending" | "dispatched" | "cancelled" | "exhausted";

/** 瞬时失败退避阶梯（毫秒）：1min → 5min → 15min，三档用尽交还用户。 */
export const RESUME_TRANSIENT_BACKOFF_MS = [60_000, 300_000, 900_000] as const;

/** 额度类意图的唤醒裕量：nextResetTime 之后再多等这段时间才派发（抵消服务端计时误差）。 */
export const RESUME_QUOTA_WAKE_MARGIN_MS = 60_000;

/**
 * 一条自动续跑意图。每 task 至多一条 pending（sqlite 部分唯一索引关闭 TOCTOU）；
 * 重复失败只更新既有 pending 行，不叠加。
 */
export interface ResumeIntent {
  resumeIntentId: string;
  /** 宿主 conversation/task id。 */
  taskId: string;
  /** 派发用真实 workspace 路径（服务调用需要；不随 identity 展示语义改写）。 */
  workspacePath: string;
  /** workspaceIdentity?.trim() || workspacePath；跨窗口/重启关联用。 */
  workspaceKey: string;
  workspaceIdentity?: string;
  kind: ResumeIntentKind;
  /** 已自动续跑次数；一次成功 turn 清零（随意图删除表达）。 */
  attempt: number;
  /** quota: nextResetTime+60s；transient: 阶梯下一档到期时刻。Unix 毫秒。 */
  nextEligibleAt: number;
  status: ResumeIntentStatus;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 看门狗状态投影事件：Host 侧状态机每次迁移后广播（进程内事件 + renderer 只读展示）。
 * renderer 不保存任何"已接纳"的续跑状态，全部展示来自该投影。
 */
export interface QuotaWatchdogStatus {
  state: QuotaWatchdogState;
  /** 最近一次 live 快照的剩余百分比；快照不可用时为 last-good 值，从未成功过则为 null。 */
  remainingPercent: number | null;
  /** 最近一次快照的下次重置时刻（Unix 毫秒），未知为 null。 */
  nextResetTime: number | null;
  /** waiting_reset 的预计唤醒时刻；其余状态为 null。 */
  wakeAt: number | null;
  /** 耗尽周期 id：从首次 ≤ 阈值观察到 remaining > 0 为止一段的唯一标记，防 quotaRestored 重发。 */
  exhaustionCycleId: string | null;
  updatedAt: number;
}

/** 归一化阈值设置输入：非法值回落默认，不抛错（设置面板手输场景）。 */
export function normalizeQuotaWatchdogSettings(raw: Partial<QuotaWatchdogSettings>): QuotaWatchdogSettings {
  const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : NaN;
    if (Number.isNaN(parsed) || parsed < min || parsed > max) {
      return fallback;
    }
    return parsed;
  };
  return {
    autoResumeEnabled: raw.autoResumeEnabled !== false,
    autoClaimResetCardsEnabled: raw.autoClaimResetCardsEnabled !== false,
    quotaWatchThresholdPercent: clampInt(
      raw.quotaWatchThresholdPercent,
      1,
      50,
      QUOTA_WATCHDOG_DEFAULT_SETTINGS.quotaWatchThresholdPercent,
    ),
    autoResumeMaxConsecutive: clampInt(
      raw.autoResumeMaxConsecutive,
      1,
      20,
      QUOTA_WATCHDOG_DEFAULT_SETTINGS.autoResumeMaxConsecutive,
    ),
  };
}
