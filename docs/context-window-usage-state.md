# Context Window Usage State（当前事实）

Context usage 的 conversation 事实源是 V4 `ConversationSnapshot.usage`，不是 renderer 的 legacy `taskRuntime`。

```text
CLI usage events -> ProductProjection.usage -> snapshot/delta
  -> SessionDataLayer -> composer toolbar / status UI
```

`V4ComposerToolbar` 读取 `snapshot.usage.contextWindow` 展示使用量。UI 不本地累加 token，也不从旧 task stream 拼 usage；恢复后以 snapshot 覆盖。

## compact 后冷恢复

Todo123：冷恢复按 `runtime.getSessionModelSelection() ?? record.restoredModelSelection`
的明确身份只读查询 Registry，不要求思考档位完整、不创建执行 Model，也不写回选择。
同一次历史加载取得一次容量，并把匹配的 usage seed 随加载结果交付投影；不另设缓存。
未知容量在内部 seed 的 maxTokens 中为 null，协议仍使用整个 contextWindow=null。
已用 token 保留；容量恢复后可以重新展示，不能回退 200,000。真实使用量事件和恢复期间
的新事件优先于旧种子；同模型 ModelSelected 可以更新上限但不重算用量。

```text
恢复身份 -> Registry 元数据（一次） -> 历史事件 + usage seed
                                           |
                                      补回 live 事件
                                           |
                      continuous / replayable 各自原有投递路径
```

冷恢复时 runtime projection 可能还没有 usage，首帧必须从 active-branch 持久消息恢复
最近一次水位，不能越过 compact summary 回退到压缩前的 assistant：

```text
active branch tail
  ├─ assistant       -> provider total / input + output
  └─ compact summary -> truePostCompactTokenCount ?? postCompactTokenCount
                                              |
                                              v
                                      cold snapshot usage
```

runtime `contextUsed > 0` 时仍优先使用 runtime；只有冷恢复 fallback 才倒序选择上述水位。
只有持久化 user compact summary 上带有效 token 的 boundary 才作为新水位；旧 assistant
boundary 或不完整历史继续沿用既有 assistant tokens fallback。boundary 水位不携带压缩前
请求的 cache，与热态 `CompactCompleted` 一致。

## Provider registry 热更新

设置页修改当前模型的 `contextWindow` 后，provider registry 应将新容量同时应用到已有
session 的 runtime 和 V4 conversation 投影。投影更新只替换
`snapshot.usage.contextWindow.maxTokens`，保留已有 `usedTokens`；不得等待下一次
`ModelComplete` 再校准。

当 registry 清除当前模型的显式 `contextWindow` 时，runtime 使用 `undefined` 表达未知容量，
`ModelSelected.contextWindow` 使用 `null` 表达“显式清除”。V4 conversation 投影收到
`null` 后必须将 `snapshot.usage.contextWindow` 清为 `null`；字段缺失只用于兼容旧事件，
不得解释为清除。容量未知期间，后续 `ModelComplete` 继续累计 token，但不得用
`maxTokens: 0` 重建窗口对象；投影内部保留最新 context 用量，以便容量恢复时重新发布。

```text
provider registry(contextWindow changed)
  -> active session runtime.updateConfig
  -> ModelSelected(same model + new contextWindow | null)
  -> ProductProjection.usage.contextWindow.maxTokens | null
  -> desktop-continuous / web-remote-replayable 各按原投递边界发布
```

这是同一模型的能力元数据热更新，不产生模型切换 marker，也不重算已使用 token。

## 自动压缩设置（2026-11-25 增补，2026-11-26 修订）

chat 输入区 context 面板新增「自动压缩」开关与触发点选择（`autoCompactEnabled` /
`autoCompactThresholdPercent`，AppSettings，10–100 的整数，默认开启 / 100）：

- **会话物化时**走 session runtime preferences 通道（与 memoryEnabled / toolSearchMode 同链路）：
  Host `resolveSessionRuntimePreferences` → CLI `resolveSessionStartupPreferences` →
  `createRecord` 写入 `runtimeConfig.compact`（映射在 bootstrap v4 原生层
  `zcode-protocol-v4/auto-compact-policy.ts` 的 `toRuntimeCompactConfig`，与下发的命令共用一份；
  v4 原生层不得反向依赖旧协议目录，所以叶子模块落在这一侧）。
- **运行中即时生效**（v4 命令 `setAutoCompactPolicy`，非 CAS、非行定位，运行中不带
  `baseRevision` 也立即执行）。CLI 处理器调用 `runtime.updateConfig({ compact })` **原地更新**
  （context builder 等处持有同一引用）；压缩策略在每个模型步重新读取 `runtime.config.compact`，
  所以最迟下一个模型步按新策略判断。Host 端 `session/autoCompactPolicySync.ts` 负责下发：
  - 设置变更 → 下发给所有仍 live 的会话（sessions-index 里 running / prewarming，或生命周期
    ready / starting）；空闲但 CLI 侧仍有 record 的会话也下发，下一次发送即按新策略。
  - 会话开始新一轮 → 若该会话最后一次成功下发的策略与当前设置不一致则补发（覆盖"改设置时
    会话不在候选里"的情况，最迟本轮第二个模型步生效）。
  - **只向确认 live 的会话发命令**：对冷会话发命令会在 CLI 侧建出空 publisher 并把空摘要扇进
    sessions-index；冷会话下次物化时本来就会带上最新设置。下发失败不记录签名，下次触发重试。
- `enabled=false` 关闭 auto compact、microcompact 以及上下文溢出后的反应式压缩
  （`reactiveCompactAfterContextExceeded`）；显式 `/compact`（用户手动或看门狗的 v4 `compact`
  命令）不受影响。
- 阈值口径与 context bar 同分母：threshold < 100 写入 `compact.usagePercentTrigger`，
  阈值 = floor(**完整上下文窗口** × pct/100)，并以统一算法阈值（effective − buffer）为上限——
  任何设置都不会比默认压缩得更晚。100（默认「自动」）不写入该字段，行为与历史版本逐位一致。
- 面板档位为 100 / 90 / 75 / 50 / 30 / 20 / 10。窗口大小未知时只提供对任何窗口都安全的
  100 / 90 / 75 / 50；窗口已知时，触发点低于 64K token 的档位不提供（压缩后的基线——系统提示、
  工具定义与摘要——通常已有几万 token，再低会在每个模型步反复触发压缩）。当前已选值即使不在
  候选内也保留显示。
- 分支（fork / inherit）会话继承父会话**当前生效**的策略（`runtime.getAutoCompactPolicy()`），
  包括父会话运行中经命令收到的更新；父 runtime 不支持该查询时回落默认"开启 + 统一算法"，
  fork 不会因此失败。
- 旧的 `thresholdPercentOverride` 保持刻意停用（compact-policy.test.ts 锁定），勿复用。
