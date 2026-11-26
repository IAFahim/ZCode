# 配额守护与自动续跑（Quota Watchdog + Auto-Resume）v1 实现 Spec

> **状态：spec-first（2026-10-30 立项，尚未实现）。** 本文只定义产品规则、阈值、状态所有者与
> 验收场景；模块放置、接线点、CAS 探测扩展与风险登记见 [tech-design.md](./tech-design.md)。
> 实现前本文必须先评审通过；实现后按实际行为回写。

> 术语约定：TypeScript 类型/变量/常量分别使用 `QuotaWatchdog*` / `quotaWatchdog*` /
> `QUOTA_WATCHDOG_*`；自动续跑意图使用 `ResumeIntent*` / `resumeIntent*`。SQLite 表使用
> `resume_intents`（见 tech-design §4）。

## 1. 一句话定义

配额守护与自动续跑 = 桌面 Host 进程内的两个耦合行为：

1. **自动续跑（auto-resume）**：任务轮失败（套餐额度耗尽或瞬时 API 错误）后，由 Host 侧
   自动恢复执行。额度失败等待套餐配额重置；瞬时失败按 1min → 5min → 15min 退避阶梯重试。
2. **配额守护（quota watchdog）**：Host 侧服务轮询套餐剩余百分比；≤10% 进入自适应观察，
   ≤1% 自动认领可用的重置卡（复用现有 `/use` 端点，此前只能由用户点击触发），0% 等待重置
   后发出一次 `quotaRestored` 事件，作为额度类续跑意图的唤醒源之一。

一句话产品语义：**用户不在场时，让"额度耗尽 / 瞬时失败"的任务在资源恢复后自动继续跑，
并在低额度时替用户核销本就属于用户的重置卡；用户随时可干预，所有动作可关闭、可追溯。**

触发边界（先于一切自动行为）：自动续跑**只在既有轮内重试全部耗尽、turn 进入 failed 之后**
触发（adapter attempt 预算与 streaming recovery 次数已先行消耗，见
[bigmodel-business-error-retry.md](../bigmodel-business-error-retry.md)）。轮内重试语义不变，
本特性不新增任何轮内重试。

## 2. 领域模型与术语

```ts
/** 看门狗状态。运行态唯一所有者是 quotaWatchdogService（Host 进程，见 §4）。 */
type QuotaWatchdogState =
  | "idle" // remaining > watch 阈值，被动节奏
  | "watching" // remaining ≤ 10%，自适应节奏
  | "claiming" // remaining ≤ 1% 且存在可认领重置卡，正在核销
  | "waiting_reset" // remaining ≈ 0 且无卡可领；wakeAt = nextResetTime + 60s
  | "restored"; // 观察到 remaining > 0，本耗尽周期内发一次 quotaRestored

/** 自动续跑意图。持久化所有者是 resume_intents 表（每 task 至多一条 pending，见 §4）。 */
interface ResumeIntent {
  resumeIntentId: string;
  taskId: string; // 宿主 conversation/task id
  workspaceKey: string; // workspaceIdentity?.trim() || workspacePath
  workspaceIdentity?: string;
  kind: "quota" | "transient"; // 额度等待重置 vs 退避阶梯
  attempt: number; // 已自动续跑次数（成功一轮后清零）
  nextEligibleAt: number; // quota: nextResetTime+60s / quotaRestored；transient: 阶梯下一档
  createdAt: number;
  updatedAt: number;
}
```

关键概念：

- **耗尽周期（exhaustion cycle）**：从看门狗首次观察到 remaining ≤ 阈值，到观察到重置后
  remaining > 0 为止的一段。`quotaRestored` 每个耗尽周期**恰好发一次**，用于唤醒额度类
  续跑意图；重复轮询同一恢复不得重发。
- **重置卡（reset card）**：服务端 `/opportunity` 发放的 `FIVE_HOUR` / `WEEK` 重置机会。
  资格判断永远在服务端；看门狗只消费 `status` 里已存在的有效机会，不本地造卡。
- **归属（attribution）**：自动续跑产生的 turn 必须可归因（host 发起的恢复执行带执行身份
  标记），协议边界见 [conversation-product-protocol.md](../conversation-product-protocol.md)
  的 Host-Initiated Resume 一节。

## 3. 产品规则

### 3.1 配额守护状态机与轮询节奏

```text
                remaining > 10%
        ┌──────────────────────────────────┐
        v                                  │
     ┌──────┐  remaining ≤ 10%          ┌─────────┐
     │ IDLE │ ─────────────────────────▶ │ WATCHING│
     └──────┘                            └─────────┘
        ▲                                  │ │
        │ remaining ≤ 1% 且 status 有可认领卡
        │                                  v │
        │                            ┌──────────┐
        │        /use 完成（对账成功）│ CLAIMING │
        │      ┌──────────────────────└──────────┘
        │      │                            │ 无卡可领 / 认领被拒
        │      │ remaining ≈ 0              v
        │      │                      ┌───────────────┐
        │      │                      │ WAITING_RESET │ wakeAt = nextResetTime+60s
        │      │                      └───────────────┘
        │      │                            │ wake 后轮询证实 remaining > 0
        │      │                            v
        │      └───────────────────── ┌──────────┐
        └──────────────────────────── │ RESTORED │ 发一次 quotaRestored → 回 IDLE
                                       └──────────┘
```

节奏（每次观测都走 live 网络快照，无 Host 侧缓存，见 tech-design §7）：

| 状态 | 轮询间隔 | 请求 |
| --- | --- | --- |
| IDLE（>10%） | 被动：复用既有 usage 刷新时机，不新增周期定时器 | entitlement snapshot |
| WATCHING（≤10%） | `clamp(remaining × 30s, 20s, 2min)`（remaining 按百分比数值） | snapshot；进入时补查一次 reset status |
| CLAIMING（≤1% 且有卡） | 30–45s | snapshot + status；满足冷却规则才 `/use` |
| WAITING_RESET（0% 无卡） | 休眠到 `nextResetTime + 60s` 再醒 | 醒后每 60s 一次 snapshot，直至 remaining > 0 |
| RESTORED | 立即回到 IDLE 节奏 | 发 `quotaRestored`（一次） |

规则：

- 快照抛错（订阅未知、账号切换断言失败）时**保留 last-good 快照**继续按旧节奏调度，不清空
  状态、不回 IDLE；连续失败按既有 usage 失败退避，不放大请求。
- 阈值只读百分比 `remaining.percentage`；无百分比的套餐（部分 Start Plan 快照）不进入
  WATCHING 之后的任何主动状态，只保持被动展示。
- `quotaWatchThresholdPercent` 设置（§3.5）只改 WATCHING 进入线（≤1% 的 CLAIMING 线固定
  1%），且不允许配置为高于 50 的值（校验在设置 schema，见 tech-design §10）。

### 3.2 重置卡自动认领（auto-claim）

- 进入 CLAIMING 的前提：remaining ≤ 1% **且** `/status` 返回未过期的有效机会
  （`availableFiveHourResets` / `availableWeekResets` 非空）。
- 看门狗**可以触发 `POST /opportunity` 资格判断**，但仅限主动状态（WATCHING / CLAIMING /
  WAITING_RESET）且冷却允许时。原因：renderer Coordinator 在窗口 hidden 时停止轮询
  （`codingPlanQuotaResetCoordinator.ts` 的 visibility 规则），用户离开期间若无人触发资格
  判断，服务端不会发放新卡，"离开期间自动认领"就会落空。看门狗在主动状态补位触发，触发
  规则与 Coordinator 完全一致；该参与方式等价于既有设计已容忍的"多一个窗口独立轮询参与者"
  （多窗口不做 leader election，由服务端幂等与限流兜底）。看门狗仍不做任何本地资格判断——
  是否发放由服务端在 `/opportunity` 里裁决。IDLE（remaining > 阈值）绝不触发。
- 核销走既有 `POST /use`（idempotency_key + reset_type），语义与用户点击完全一致：
  - 优先核销 **FIVE_HOUR**；若无五小时卡仅有周卡，则核销 WEEK。两类都有时只用五小时卡
    （最小代价原则），周卡仍留给用户手动决策。
  - 认领成功 = `/use` 返回 `used:true` 后，按既有对账协议（`/status` 在
    `[0, 250, 750, 1500]ms` 重试，观察 `latest*ResetHistory.usedAt` 变化）确认。
  - **认领期间（含对账循环）绝不调用 `/opportunity`**——复用既有互斥规则，避免撞发卡锁
    触发 429。
- 冷却规则与 renderer Coordinator 完全一致（同一 scope 维度）：`granted → +10min`、
  `denied(3301) → max(next_try_at, +5min)`、瞬时错误 → `+5min` 复用同一幂等 key、
  429/稳定错误 → `+10min` 换新 key（详见 tech-design §8）。
- 并发安全：服务端按机会核销结算，看门狗与用户手动点击并发不会双消费同一张卡
  （`packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts:751-758` 记录了同一竞态边界）。
  看门狗在发起 `/use` 前必须与 renderer 共享同一 scope 级核销轨迹（tech-design §8），
  对账后无可核销机会即放弃，不携带新幂等键重试。
- 可见性：每次自动认领必须（1）弹系统级 toast 告知用户"已自动重置额度"，（2）进入既有
  重置 history 展示链路（与手动核销同一份 `used_at` 事实，不造第二条历史）。
- 开关 `autoClaimResetCardsEnabled=false` 时：CLAIMING 状态不进入，remaining ≤ 1% 直接
  落在 WAITING_RESET（若有 pending 额度类续跑意图，仍等自然重置唤醒）。

### 3.3 失败任务自动续跑（auto-resume）

触发（2026-10-30 实现回写：失败事实由 **renderer 上报**，Host 侧所有与调度）：

- renderer 在会话进入 failed 时（`useAutoResumeReport`，SessionPane 挂载点）把观察到的
  失败事实经 `IUsageStatsService.reportAutoResumeFailure` 上报：taskId、workspace、kind、
  errorMessage。意图的接纳、去重（每 task 一条 pending）、调度全部由 Host 侧
  `quotaWatchdogService` 所有；设置关闭时 Host 直接忽略上报（零行为变化）。
- v1 归因口径**从紧**（实现回写，窄于初稿的"网络/服务端瞬时错误"泛类）：
  - **额度失败（kind=quota）**：provider 业务码 `1005` / `1304` / `1308` / `1310` / `1313`、
    `attribution.reason === "quota_exhausted"`（CLI 可信根因，
    `chatErrorAttribution.ts` 同口径）、或 legacy 包装文案（exceed limit / quota exceeded）。
  - **瞬时失败（kind=transient）**：限流族业务码 `429` / `3002` / `2007` / `1302` / `1303` /
    `1305`，或 `error.source === "network"`。
  - 其余失败（鉴权、配置、工具等）不上报、不自动重试，交还用户。

调度：

| kind | 唤醒条件 | 放弃条件 |
| --- | --- | --- |
| quota | `nextEligibleAt = nextResetTime + 60s` 到期；派发门前**再用 live 快照证实** remaining > 0（未恢复则守卫重排，不消耗 attempt；实现回写新增 `reschedulePending`） | 用户干预（§3.4）；连续次数上限（§3.3.1） |
| transient | 退避阶梯 1min → 5min → 15min（每次失败后进入下一档） | 三档全部用尽仍失败 → 停止 + 手动横幅 |

- 每个 task 至多一条 pending 意图；重复失败只更新既有意图（attempt+1、nextEligibleAt 推进），
  不叠加。
- 派发前守卫：目标 task 若已有用户活动（task index 显示 running，即用户新消息/手动重试
  已被 admission 接纳）→ 意图取消；意图行已删除（task 删除后派发目标不存在）→ 结算走失败
  路径收敛（§3.4 的 v1 边界）。
- 恢复执行：v4 `retryTurn`（canonical intent 重放）经 host CAS 探测（含 baseLogEpoch 收敛，
  ACK 新增 additive 字段 `logEpochAtDecision`）；**实现回写**：v1 上报暂不携带失败行
  row target（SessionPane 行定位延后），因此实际派发路径为 attributed `sendText`
  （`resumeIntentId` 归属，schema 与 automation/offPeak 互斥）；row target 捕获补齐后
  retryTurn 自动成为首选，代码已就绪。两条路径都复用既有 CommandInbox admission 与
  owner/lease 路由，不新增第二条写入路径。
- 成功定义：自动续跑触发的 turn 正常完成（`turn.completed` 语义）→ attempt 清零、意图删除。

#### 3.3.1 连续上限

- `autoResumeMaxConsecutive`（默认 5）：同一 task 连续 N 次自动续跑**都没有产生一次成功
  turn** 后停止，落"已暂停自动重试，请手动处理"横幅。任何一次成功 turn 都会清零计数。
- 额度类与瞬时类共用同一计数器（同一任务上交替发生时累计），避免交替绕过上限。

### 3.4 用户干预（取消语义，2026-10-30 实现 v1 边界）

v1 已实现的取消路径：

1. 派发前守卫：目标 task 在 task index 显示 running（用户的新消息/手动重试已被接纳在跑）
   → 意图取消（`user_activity_active`），admission 先到者胜。
2. 设置 `autoResumeEnabled=false` → 全部 pending 意图批转取消（`settings_disabled`）。
3. task/会话被删除 → 派发目标不存在，失败结算把意图收敛到 exhausted（终态）。

v1 暂缓（后续补齐）：renderer editUserQuery / 显式"停止自动重试"按钮 / 用户 Stop 自动 turn
直接调用 `cancelAutoResume`。这些场景下意图仍会被 §3.3 的派发守卫与上限兜底
（编辑重发后 task running → 守卫取消；连续失败 → attempt 上限 exhausted），不会造成
无界自动重试。

自动续跑与手动重试并发时，CommandInbox 的既有 admission 顺序仲裁，先接纳者胜。

### 3.5 设置

新增 4 项 App 设置（全部 opt-out、默认开启/默认值，schema 见 tech-design §10）：

| 设置 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `autoResumeEnabled` | boolean | `true` | 总开关：关闭后不创建续跑意图，既有 pending 意图转为取消 |
| `autoClaimResetCardsEnabled` | boolean | `true` | 看门狗自动核销重置卡；关闭后重置卡仍完全由用户点击 |
| `quotaWatchThresholdPercent` | number | `10` | WATCHING 进入线（百分比，1–50） |
| `autoResumeMaxConsecutive` | number | `5` | 连续自动续跑上限（1–20） |

- 全部关闭 = **零行为变化**：不新增网络请求、不建表、不注册调度分支（验收 H）。
- 设置变更经既有 `SettingsChanged` 广播生效；看门狗在下一个观测点读取新值，不要求即时重启。

### 3.6 平台边界与已知限制

- **看门狗驻留 Desktop Host 进程，App 不运行即不工作**：等待重置、退避阶梯、观察节奏都
  随进程存活；App 关闭期间额度恢复不会触发任何动作，重启后按 §3.7 恢复。这是 v1 的明确
  限制，不承诺后台驻留。
- 远程 workspace：v1 只对本地 workspace 的任务创建续跑意图；远程任务的 turn.failed 不建
  意图（与闲时任务 v1 的本地边界一致）。
- 手机 `/remote` 与 Web：复用桌面 Host 的既有 attachment 语义，不新建独立看门狗；手机端
  只消费桌面侧已发生事实的展示。

### 3.7 重启恢复

- App 重启后：看门狗以 last-good 持久化快照（tech-design §4 的 watchdog checkpoint）重新
  起草状态——快照过期则先取一次 live snapshot 再定态；`waiting_reset` 的 `wakeAt` 未过则
  重新挂定时器，已过则立即进入核实轮询。
- `resume_intents` 里 `nextEligibleAt` 已到期的 pending 意图由 scheduler 在启动恢复中认领
  （对齐 `offPeakRepo.recoverInterrupted` 模式），未到期的等待原定时。

## 4. 状态所有者（单一所有者）

| 状态 | 唯一所有者 | 其他角色 |
| --- | --- | --- |
| 看门狗运行态（状态机 + 轮询节奏 + last-good 快照） | `quotaWatchdogService`（packages/services，Host 进程） | renderer 只读展示；main 只转发消息 |
| `quotaRestored` 事件 | `quotaWatchdogService` 发出 | scheduler/host 消费；renderer 仅展示 |
| 续跑意图（pending 意图集合） | `resume_intents` 表 + 其 Repo（packages/services） | 每 task 至多一条 pending；renderer 无第二份已接纳状态 |
| 意图派发决策（认领到期意图、唤醒源仲裁） | scheduler utility process（复用既有 tick） | main 转发 `HostMessageTypes.ResumeRun` |
| 恢复执行（retryTurn / attributed sendText） | window Local Host（复用 zcodeV4HostCommand 探测模式） | CLI CommandInbox 唯一 admission |
| 重置卡事实与资格 | 服务端 `/status` + `/opportunity`（不改变） | 看门狗与 renderer 都是消费者 |
| 设置 | `settingService`（磁盘 `~/.zcode/v2/setting.json`） | 经 `SettingsChanged` 广播 |

## 5. UI 表现（2026-10-30 实现 v1 回写）

- **已实现**：失败上报 toast（"额度重置后将自动继续" / "稍后将自动重试"，i18n
  `chat.autoResume.*`）；设置区"使用统计"页新增配额守护卡片（4 项设置，
  `settings.autoResume.*`，含 App 不运行即不守护的语义提示）；自动核销复用既有
  重置完成链路（与手动核销共用 `used_at` 历史 + entitlement 刷新），不新增第二条展示。
- **v1 暂缓**：失败横幅的"将在额度重置后自动继续（预计 HH:MM）/ 停止自动重试"次级行——
  SessionPane 横幅改造延后；期间意图状态可经 `getAutoResumeIntent` 查询（契约已就绪）。
- Renderer 不保存任何"已接纳"的续跑状态；全部展示来自 Host 投影/查询。

## 6. 验收场景

| ID | 场景 | 预期 |
| --- | --- | --- |
| A | remaining 从 >10% 跨到 ≤10% | 进入 WATCHING，节奏切换为 `clamp(remaining×30s, 20s, 2min)`；>10% 期间不出现任何新增周期请求（日志证据） |
| B | ≤1% 且 status 有 FIVE_HOUR 卡 | 自动认领恰好一次（`used:true` + 对账见新 `usedAt`）；与用户并发点击不双消费；toast + history 出现；对账循环内无 `/opportunity` 请求 |
| B2 | ≤1% 且 status 无卡（含窗口 hidden 期间 Coordinator 未触发判断） | 看门狗按冷却规则触发 `/opportunity`；`granted=false` 或冷却未到则落 WAITING_RESET 等自然重置兜底；判断频率与 Coordinator 常量一致 |
| C | 0% 无卡可领 | 进入 WAITING_RESET，`nextResetTime+60s` 唤醒；核实 remaining>0 后 `quotaRestored` 恰好一次；pending 额度意图被派发；成功后横幅清除 |
| D | WAITING_RESET 期间关闭 App | 重启后从 last-good 快照重新挂起看门狗；到期意图被恢复认领；不重复发 `quotaRestored`（同耗尽周期） |
| E | 瞬时失败 | 1min → 5min → 15min 三次派发（日志可见每档间隔）；三档后停止并出手动横幅 |
| F | 连续 N=autoResumeMaxConsecutive 次额度自动续跑均失败 | 第 N 次后停止派发，横幅切换为终止文案；一次成功 turn 后计数清零 |
| G | pending 意图存在时用户新消息 / 编辑 / 删除 task | 意图立即取消（表内无 pending 行或状态取消）；当前周期内不自动重建 |
| H | 四项设置全关 | 与现状零差异：无新增请求、无意图行、无调度分支（对照日志与表） |
| I | 限流安全 | 全程无"对账期间 `/opportunity`"；granted/denied/429/瞬时 各冷却时长与 Coordinator 常量一致；`createServiceLogger` 日志可复盘每次状态迁移与请求 |

每个场景的测试入口（E2E / 浏览器验收 / 可重复运行时场景）在实现阶段的 spec 回写中落实；
本表先固定可判定行为。

## 7. 明确不做（v1 non-goals）

- **CLI headless 场景**：纯 CLI（无桌面 Host）不做看门狗、不做自动续跑；CLI 侧只保证
  retryTurn / sendText 协议可用。
- **手机端与 Web server**：不在手机 `/remote` 或 `packages/server` 侧新建看门狗或意图
  存储；远程 workspace 不创建意图（§3.6）。
- 不做轮内（in-turn）重试策略变更；不改 bigmodel 业务码分类表。
- 不做看门狗本地资格判断或本地造卡；`/opportunity` 的调用主体仍是 renderer Coordinator
  （看门狗只消费已有卡）。
- 不做进程外驻留（App 关闭即停，§3.6）；不做跨设备协调（多桌面实例并发由服务端幂等与
  限流兜底，同现有 reset 契约）。
- 不做对 Start Plan 之外无百分比套餐的主动看护（无 percentage 不进主动状态）。
- 不自动续跑用户已显式放弃的任务（无"恢复历史放弃"入口）。

## 8. 与现有文档的关系

- [coding-plan-quota-reset-ui.md](../coding-plan-quota-reset-ui.md)：重置 UI 与 Coordinator
  规则不变；本文 §3.2 在其上叠加 Host 侧自动核销（该文末尾有对应增补链接）。
- [bigmodel-business-error-retry.md](../bigmodel-business-error-retry.md)：轮内重试分类
  不变；本文定义轮失败之后的预算外自动续跑语义（该文末尾有对应增补链接）。
- [conversation-product-protocol.md](../conversation-product-protocol.md)：Host 发起恢复的
  归属与 admission 边界见该文 Host-Initiated Resume 一节。

## 9. v2 修订（2026-11-25：派发门、核销前置与 Host 侧归因）

v1 上线运行暴露四个缺陷，本节为权威修订；正文 §3.1–§3.5 中与本节冲突处以本节为准。

### 9.1 额度口径反转（v1 缺陷 1）

- entitlement 快照的 `remaining.percentage` 承袭 quota 接口的**已用占比**（0–100），
  与 UI `codingPlanQuotaPresentation.getQuotaRemainingPercentage` 同口径。v1 直接把它当
  剩余值与阈值比较：耗尽判定（≤0%）永不成立 → 状态机停在 idle → reset 卡从未被自动核销。
- 修正：统一经 `remainingPercentFromEntitlement()`（100 − used，clamp 0–100）后进入
  状态机、轮询节奏与派发门；`QuotaWatchdogStatus.remainingPercent` 语义为剩余占比。

### 9.2 Host 侧权威归因（v1 缺陷 2：失败事实仅来自可见 pane）

- renderer `useAutoResumeReport` 仍只上报事实（v1 不变），但新增透传 provider 业务码与
  CLI 归因（`providerErrorCode` / `attributionReason`）；派发 turn 的 `task_error` 事件
  code / attribution 亦进入结算。Host `classifyTurnFailure()` 以
  `code > attribution.reason > source=network > 消息文本` 优先级归类：
  - `plan_expired`（1309 及 plan/subscription expired 文本）：无自动动作，不建意图、不烧卡。
  - `quota`（1005/1304/1308/1310/1313/1316-1321、insufficient_quota 等终端额度码）。
  - `context`（1261 及 context 溢出类文本）：先 `/compact` 再续跑一次（§9.4）。
  - `transient`（429/3002/2007/1302/1303/1305/1312 及网络类）：按 1/5/15min 退避阶梯自动续跑。

### 9.3 派发门与核销前置（用户主诉求：reset 出来即自动消费并续跑）

quota 意图派发前必须过 live 快照证实：

1. 剩余 > 0 → 派发（同 v1）。
2. 剩余 ≤ 0：`autoClaimResetCardsEnabled` 且当前连接存在可核销卡 → **立即核销**（/use，
   幂等与对账协议同 §3.2），确认成功后**当轮直接派发**——不等下个 tick、不需用户手动
   /opportunity→/use。核销未确认 → 2min 后重试（不烧 attempt）。
3. 无卡/未启用 → 守卫重排到 `nextResetTime + 60s`（tick 状态机继续 /opportunity 资格判断）。
4. 快照不可用 → 5min 守卫重排；**绝不盲派发**（v1 快照失败仍放行，把整段上下文发给已耗尽的
   API，一次失败即烧掉重置后额度的大头）。
5. transient 意图派发前若 live 快照显示剩余 ≤ 0，改写 kind=quota 走本门（限流退避不再空转）。

### 9.4 context 溢出：先压缩再续跑（v2 新增 kind）

- 新增意图 kind `context`（1261/上下文溢出类失败）。首次失败：发 v4 `compact` 维护命令
  （idle 立即执行 / busy 进 FIFO，非 CAS），20s 后守卫重排；compact 落地后续跑一次。
- 已武装（同 task 已发过 /compact）再次 context 失败 → exhausted（压缩救不了，停止自动重试）。
- 自发 compact 的活动窗口（10min）内 `isTaskActive` 视为己方活动，守卫重排而非取消意图。

### 9.5 派发结局可靠收口与生命周期（v1 缺陷 3/4）

- 结局等待改为 workspace 维度流订阅（`onDynamicTaskEvent`）+ task index 常开终态订阅
  （`onDynamicTaskTerminalOutcome`）双通道。v1 订阅收不到事件，等待全走 60min 超时，
  连续重派间隔恒为 1 小时。
- 超时收口前核实任务是否仍在跑：在跑 → 意图转 `cancelled("task_still_running")`（工作继续，
  不重复派发）；不在跑才按失败结算。
- 用户手动 prompt（无后台归因的 sendPrompt）经 adapter `onManualPromptSubmitted` 钩子触发
  `cancelAutoResume`（§3.4 规则落地；v1 未接线）。看门狗自发 compact / 续跑派发不触发。
- renderer 失败上报不再推进 attempt（`incrementAttempt: false`）；attempt 由派发结算路径
  统一 +1（v1 双路径各 +1，且并发下 UNIQUE 崩溃后计数归零，上限永不生效）。
- 同 task 失败上报/结算经 `withTaskLock` 串行化；init 恢复两步各自收错。

### 9.6 验收补充

- 用量 100% + 有卡：任务失败 → 看门狗核销卡 → 同一 tick 内续跑成功（无需人工）。
- 1305 限流失败：任务 1min 后自动续跑，期间无任何 reset 卡被核销。
- 1309 失败：无自动动作；意图不创建。
- 1261 失败：/compact 发出 → 续跑一次 → 若再失败即 exhausted。
- 用户在意图 pending 期间手动发送消息：意图被取消，不再自动派发。

## 10. v3 修订（2026-11-26：宿主统一接纳失败、"不可知"不等于"耗尽"、结局可靠收口）

v2 上线后的线上证据（本机 `tasks-index.sqlite` 的 `resume_intents`）：3 条 quota 意图自 11-25 19:03 起
每 5 分钟被守卫重排一次，卡死 7–24 小时；checkpoint 的 `lastGoodRemainingPercent` 始终为 `null`
（看门狗从未读到可读额度）；同一 task 留下 6 条永远停在 `dispatched` 的行。本节为权威修订，
§3 / §9 中与本节冲突处以本节为准。

### 10.1 失败事实：宿主统一接纳（取代"可见 pane 上报"）

- **权威通道是宿主 task index 同步器**：会话 `phase` 由非终态迁入 `error`（live 迁移，冷恢复的水合
  不算）时，把 `projection.lastError` 的 code / message / attribution 交给
  `handleSessionFailure({ via: "detector" })`。后台任务与非当前 pane 的会话同样被接纳；辅助会话
  （子代理等）不接纳。
- renderer `useAutoResumeReport` 降级为**冗余通道**（`via: "report"`），必须携带失败发生时刻
  `errorAt`；超过 60s（`RESUME_REPORT_FRESH_WINDOW_MS`）的报告视为 SessionPane 重新挂载后的
  陈旧重放并丢弃（v2 因此复活已取消 / 已耗尽的意图）。
- 看门狗自己派发的续跑 turn 的结局（`via: "outcome"`）**按输入过滤**：终态带的 `inputId` 不是本轮
  （`resume-<intentId>-<now>`）即忽略。当前 task index 只对经 `sendPrompt` 的输入记录 `inputId`，
  看门狗直发 v4 命令的终态不带 `inputId`，按"派发后第一个终态即本轮"处理；用户手动发送消息会
  先取消意图并释放在途记录，其终态不会被当成本轮结局。
- **线上顺序是终态先到、归因后到**：task index 先发 turn 终态（结局通道只知道"这一轮失败了"），
  随后回源快照的 detector 才带回权威 `lastError`。不带归因的失败结局因此**不立即结算**，
  而是保留在途记录最多 10 秒，把结算让给 detector；宽限内 detector 没来才按"无法归因"结算
  （绝不因此卡在 `dispatched`）。否则额度类快速失败会错记 attempt、走错退避阶梯，续跑长时间
  正常运转后才耗尽也会累计到上限提前停止。
- 三条通道汇入 `QuotaResumeTracker.handleSessionFailure` 同一入口：同 task 串行（`withTaskLock`），
  **去重与结算在同一把锁内判定**（同签名失败 5s 内只结算一次，`RESUME_FAILURE_DEDUPE_WINDOW_MS`）。

### 10.2 额度观测带 scope，"不可知"不等于"已耗尽"

- 观测（`observeQuota`）与 renderer 同口径：先解析当前 Coding Plan 连接（`resolveResetScope`），
  再读 entitlement 快照与重置卡状态；三步各自降级，不因一步失败整体放弃。v2 的快照不带 scope，
  读不到 `percentage`，派发门因此永远判"不可知 → 守卫重排"。
- 派发门对 quota 意图的裁定（依次）：

| 观测 | 裁定 |
| --- | --- |
| 额度可读且未耗尽，或额度不可知 | 放行派发（不可知时是探测派发，节奏与次数由 §10.4 的阶梯约束） |
| 已耗尽，且距上次核销成功不足 10 分钟（`RESUME_CLAIM_COOLDOWN_MS`） | 放行探测：快照可能滞后，不重复烧卡也不死等 |
| 已耗尽，具备核销资格且有可用卡 | **立即核销**，成功后 +10s 派发；卡在但本次核销未确认 / 观测不完整 → 2 分钟后重试 |
| 已耗尽，其余情况（无卡、未启用自动核销、不具备资格） | 不派发；在 `min(nextResetTime + 60s, now + 10min)` 复核（`resolveExhaustedRecheckAt`） |

- **核销资格**（`mayClaimCard`）：从未核销过，或上次核销之后又出现过真实的额度类失败。只凭
  "快照仍显示耗尽"不再烧第二张卡（v2 会把卡一张张耗光）。
- transient 意图到期时若观测显示额度已耗尽，改写为 quota 意图走本门（限流退避不再空转）。

### 10.3 失败即核销

额度类失败在**三个时点**都会即时尝试核销：建意图时、刷新既有 pending 意图时、看门狗派发的 turn
以额度类失败后（`claimAfterFailure`）。快照可读且明显有余量时不烧卡（失败可能来自别的额度桶或
瞬时抖动）；provider 明确报用量上限（1308 / 1310）时无视快照直接核销。卡型按 provider 业务码裁决：

| 业务码 | 卡型 |
| --- | --- |
| 1310（周 / 月上限） | 只认 WEEK 卡（FIVE_HOUR 卡对它无效，不误烧） |
| 1308（5 小时窗口）及其余额度类 | 任一可用卡，FIVE_HOUR 优先 |
| 1309 / 1311 / 1313 | 没有卡能解决，不核销 |

### 10.4 看门狗派发的 turn 失败后的结算（`planDispatchedFailureSettle`，纯函数）

| 归类 | 裁决 |
| --- | --- |
| plan_expired / non_recoverable | `exhausted`：既有意图终态化，自动重试无意义 |
| quota，20 秒内失败（`RESUME_FAST_FAIL_WINDOW_MS`） | 额度并未恢复：**不计 attempt**，按 1 → 5 → 15 → 30 分钟探测阶梯回队；连续快速失败达到 `autoResumeMaxConsecutive` 即 `exhausted` |
| quota，运行一段时间后才耗尽 | 新的耗尽周期：连续快速失败计数清零，attempt 归零，+10s 回队 |
| transient | 1 → 5 → 15 分钟退避并计 attempt；运行 ≥ 2 分钟才失败视为有进展，attempt 归零；触顶 `exhausted` |
| context | 自发压缩至多 `RESUME_MAX_CONTEXT_COMPACTS = 2` 次，仍溢出即 `exhausted`；否则回队并重新武装压缩 |
| 无法归因 | 保持原类别、计 attempt，触顶 `exhausted` |

attempt 只由本结算路径推进；detector / renderer 上报不推进 attempt。

### 10.5 派发与结局

- **活动判定读 sessions-index 最新态**（running / prewarming / compact 维护工作），不再读 sqlite
  任务行的 status——那一列只存上一次 outcome，从不为 running（v2 的"任务仍在跑则不派发"从未生效，
  长任务 1 小时后被重复续跑）。任务仍在活动：+60s 重排，不取消、不派发；持续 2 小时即取消
  （`task_still_running`，工作继续）。
- 派发前确保该任务所在 workspace 的 sessions-index 已被宿主摄入（重启后只有用户打开的 workspace
  才订阅；`sendPrompt` 路径本来就做这件事，看门狗绕过它时必须自己补上），否则续跑 turn 的
  结局与失败都无人观察。
- 派发前 `ensureSessionReady`（重启后的后台任务是冷会话），再发 v4 `sendText`
  （`commandId = inputId`）；**先订阅结局再派发**（额度未恢复时 turn 会在派发调用返回前就失败）；
  ACK 不是 `accepted` 即按派发失败处理。
- 启动看护：ACK 已接受但 45 秒后索引仍明确为空闲 → 按派发失败处理，不空等结局超时。
- 结局等待 60 分钟；到期仍在跑则续等（至多 8 次），**在途期间绝不重复派发**。
- 派发本身失败（会话无法恢复 / 命令被拒 / turn 未启动）：30 秒后重试，不计 attempt；连续 10 次
  即 `exhausted`。任何一步失败都不会让行停在 `dispatched`。
- 结局完成 → 意图删除；用户手动发送消息 → 意图取消（§3.4）。
- 续跑文案明确"已完成则不要重做"：意图可能早于用户手动续跑，迟到的续跑只回一行说明。

### 10.6 context 溢出：先压缩再续跑

- 派发门（而非失败结算）负责发起压缩：未武装时发 v4 `compact`（已有压缩在跑则复用），之后每
  15 秒看一次，压缩维护工作结束才放行续跑——绝不在压缩未落地时续跑（必然再次溢出）。
- 压缩请求连续被拒（草稿会话 / 命令面不可用）达 2 次后放行续跑，由结局裁决；仍溢出则按 §10.4
  收口为 `exhausted`，绝不无限请求。

### 10.7 重启恢复与调度

- 启动时回收**全部**残留的 `dispatched` 行（v2 只回收 15 分钟前的，崩溃前 15 分钟内派发的意图
  永远卡死）；同 task 已有 pending 行的残留 `dispatched` 行直接删除（v1/v2 在此撞
  `idx_resume_pending`，导致恢复整体失效）。
- 新建意图时清掉同 task 旧的 `exhausted` / `cancelled` 行：自动续跑停止后用户再次失败可以重新开始。
- tick 定时器总是把最早到期的 pending 意图纳入计算（v2 在有在途结局等待时跳过，其它任务的意图
  被饿死）；单次定时上限 5 分钟（系统休眠唤醒后的迟到有界）。
- 本轮刚发卡 / 核销成功后重新观测再进派发门（开头的快照已过期）。

### 10.8 验收补充

- 后台任务（非当前 pane）以 1308 失败：宿主 detector 接纳 → 建意图 → 有卡则核销 → 续跑，全程无需
  该 pane 可见。
- 额度不可读（离线 / 快照失败）：放行探测，不进入"每 5 分钟守卫重排"的循环。
- 核销后续跑 turn 20 秒内再次 1308：不计 attempt，1 分钟后重试；连续 5 次快速失败后停止。
- 同一失败由 detector 与结局通道同时上报：只结算一次，attempt 恰好推进一次。
- 续跑 turn 运行 30 分钟后仍正常：不重复派发；结局超时只在索引明确空闲时才按失败结算。
- SessionPane 重新挂载重报 2 分钟前的旧错误：不建意图。
