// 自动压缩策略（chat 输入区 context 面板的开关 / 阈值）→ runtime compact 配置的单一映射。
// 无依赖的叶子模块，放在 v4 原生层：v4 命令 setAutoCompactPolicy、旧协议层的 session 创建
//（createRecord）共用，两处必须完全同形，否则"设置只在部分路径生效"。
// 边界：v4 原生层不得 import 旧协议目录（08-phasing M4「无桥」），因此叶子模块只能落在这一侧。

export interface AutoCompactPolicyInput {
  enabled: boolean;
  /** 1–99 生效；100 / 缺省 = 统一算法（尽量晚压缩），行为与未设置完全一致。 */
  usagePercentTrigger?: number;
}

export function toRuntimeCompactConfig(input: AutoCompactPolicyInput): AutoCompactPolicyInput {
  return {
    enabled: input.enabled,
    // 关闭时阈值无意义，不写入；100 保持统一算法。
    ...(input.enabled &&
    typeof input.usagePercentTrigger === "number" &&
    Number.isInteger(input.usagePercentTrigger) &&
    input.usagePercentTrigger >= 1 &&
    input.usagePercentTrigger < 100
      ? { usagePercentTrigger: input.usagePercentTrigger }
      : {}),
  };
}

/** 阈值合法（1–99 的整数）才下发；其余一律按"未设置"（100）。 */
function normalizePercent(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value < 100
    ? value
    : 100;
}

/** session 启动偏好里的自动压缩两项（session-runtime-preferences 的协议字段）。 */
export interface InheritedAutoCompactPreference {
  enabled: boolean;
  thresholdPercent: number;
}

/**
 * 分支会话（fork / inherit）继承父会话**当前生效**的策略：父 record 的 runtime 配置就是用户当时的
 * 选择（含运行中经 setAutoCompactPolicy 下发的更新）。
 * 父 runtime 不支持该查询（旧 core、测试替身）时回落默认"开启 + 统一算法"——fork 绝不能因为
 * 一个可选查询而整体失败。
 */
export function inheritAutoCompactPolicy(parentRuntime: {
  getAutoCompactPolicy?: () => { enabled?: boolean; usagePercentTrigger?: number } | undefined;
}): InheritedAutoCompactPreference {
  const policy =
    typeof parentRuntime?.getAutoCompactPolicy === "function"
      ? parentRuntime.getAutoCompactPolicy()
      : undefined;
  return {
    enabled: policy?.enabled !== false,
    thresholdPercent: normalizePercent(policy?.usagePercentTrigger),
  };
}
