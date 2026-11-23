# 配额守护与自动续跑（Quota Watchdog + Auto-Resume）技术设计

> **状态：v1 已实现（2026-10-30），实现偏差已回写 §0/§3/§5/§9/§12。**
> 产品规则、阈值与验收场景见 [spec.md](./spec.md)；本文定模块放置、接线点、CAS 探测扩展、
> 事件顺序与风险登记。实现与本文冲突时先回写本文再改代码。

## 0.A 实现偏差回写（2026-10-30）

1. **派发所有者简化**：意图派发不在 scheduler/main 链路（原 §9 设计），改在 **Host services
   进程内** `quotaWatchdogService` 自持的 rescheduling timer 完成（复用
   `offPeakTaskService` 的 timer-loop 模式）。理由：执行目标就是本进程的 session
   （`zcodeTaskService.sendPrompt` / `zcodeAgentService.sendConversationCommandV4`），
   scheduler→main→host 的跨进程转发是纯开销；不新增 `HostMessageTypes.ResumeRun` 与
   scheduler tick 分支。§9 的 scheduler 接线设计保留为历史参考，不再实现。
2. **失败事实来源**：renderer 上报（`useAutoResumeReport` →
   `IUsageStatsService.reportAutoResumeFailure`），Host 校验去重后落库；不做 Host 侧
   turn.failed 订阅（adapter 全量事件面改造风险高，renderer 归因口径最全）。
3. **派发路径现状**：v1 上报不携带失败行 row target → 实际走 attributed `sendText`
   （`resumeIntentId` 归属）；`retryTurn` + 扩展 CAS 探测（ACK 新增 additive
   `logEpochAtDecision`，CLI stale 裁决回传代际）已实现，row target 捕获补齐后自动成为首选。
4. **额度派发门**：派发前 live 快照证实 remaining > 0，未恢复走 `reschedulePending`
   （不消耗 attempt）。
5. **v1 UI**：上报 toast + 设置卡片；失败横幅次级行延后（spec §5）。

## 0. 导读与关键决策

| 决策 | 一句话 |
| --- | --- |
| **看门狗驻 Host** | `quotaWatchdogService` 注册在 services node（Host 进程），随 App 存活；App 不运行即不工作（明确限制，spec §3.6） |
| **快照只走既有通道** | 剩余百分比与 `nextResetTime` 只来自 `usageStatsService.getEntitlementSnapshot`（live 网络快照，无 Host 缓存）；抛错保留 last-good，不清态 |
| **自动核销复用 `/use`** | 看门狗消费 `/status` 已有卡，并可在主动状态（≤阈值）按 Coordinator 同款冷却触发 `/opportunity` 资格判断——补位 renderer 窗口 hidden 时的轮询真空（§7）；幂等 key、冷却、对账同一套规则 |
| **意图持久化** | `resume_intents` 表（tasks-index.sqlite，`offPeakTaskRepo.ts` 旁新增 Repo）；每 task 至多一条 pending；重启恢复对齐 `recoverInterrupted` 模式 |
| **派发复用调度管线** | scheduler tick 认领到期意图 → main `HostMessageTypes.ResumeRun`（与 `CronRun`/`OffPeakRun` 并列）→ Host 执行；不新建第二条派发通道 |
| **恢复执行双路径** | 首选 v4 `retryTurn`（canonical intent 重放）经扩展 CAS 探测；探测连续失败回退 attributed `sendText`（automation/offPeak 归属模式） |
| **admission 不旁路** | 两条路径都经 CLI `CommandInbox` 既有 admission 与 owner/lease 路由；无第二条已接纳队列 |
| **设置全 opt-out** | 4 项设置默认开启/默认值；全关 = 零行为变化（不建表、不注册调度分支） |

## 1. 背景与目标

现状痛点：任务轮因套餐额度耗尽（1005/1308/1310 等）或瞬时 API 错误失败后，即使用户离开，
也只能等用户回来手动重试；同时重置卡只能由用户点击核销，额度见底时卡在账户里闲置。

目标：在桌面 Host 内提供 (1) 失败任务的自动续跑（额度等待重置、瞬时按 1/5/15min 阶梯），
(2) 低额度看门狗（≤10% 自适应观察、≤1% 自动核销已有重置卡、0% 等重置后发 `quotaRestored`）。

非目标见 spec §7（CLI headless、手机、Web server、进程外驻留等）。

## 2. 总体架构

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Desktop                                                                      │
│                                                                              │
│  Renderer (packages/ui)                                                      │
│    ├─ 失败/自动续跑横幅（只读展示，无第二份已接纳状态）                       │
│    ├─ 自动认领 toast / 重置 history（复用既有 reset UI 事实源）               │
│    └─ 设置项（useSettingService 读，SettingsChanged 广播刷新）                │
│                                                                              │
│  Host / services utility process                                             │
│    ├─ quotaWatchdogService  ← 新增：状态机 + 节奏 + last-good 快照            │
│    │    ├─ usageStatsService.getEntitlementSnapshot（live，15s 超时）         │
│    │    ├─ reset /status · /use（复用 bigmodelUsageQuotaProvider 端点）       │
│    │    ├─ 发出 quotaRestored 事件（每耗尽周期一次）                          │
│    │    └─ turn.failed 归因消费 → 写 resume intent                           │
│    ├─ resumeIntentRepo      ← 新增：resume_intents 表（tasks-index.sqlite）   │
│    └─ zcodeV4HostCommand    ← 扩展：CAS 探测支持 baseLogEpoch；ResumeRun 执行 │
│                                                                              │
│  scheduler utility process（常驻，20s tick，复用）                            │
│    └─ resume tick：认领 nextEligibleAt 到期的 pending 意图                    │
│         wake 源：quotaRestored 转发 / 到期定时（resetTime+60s / 阶梯）        │
│                                                                              │
│  main (packages/desktop)                                                     │
│    └─ desktopCronScheduler：转发 HostMessageTypes.ResumeRun / ResumeRunResult │
│       （与 CronRun / OffPeakRun 同款路由）                                    │
│                                                                              │
│  CLI runtime (apps/zcode-cli)                                                │
│    └─ CommandInbox：retryTurn / sendText 的唯一 admission（不改动）           │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          v   ZCode Server：coding-plan reset status/use（不改契约）
```

## 3. 模块放置与分层边界

按架构治理的层序 `contract < domain < app < adapters < ui`（低层不得依赖高层；domain 纯净
无 IO；app 经 port 决定副作用；adapters 执行 sqlite/网络/定时器）：

| 模块 | 位置 | 层 | 说明 |
| --- | --- | --- | --- |
| `quota-watchdog-types.ts` | `packages/shared/src/` | contract | `QuotaWatchdogState`、`ResumeIntent`、事件/消息 payload 类型（spec §2） |
| 协议扩展 | `packages/shared/src/channels.ts` + `zcode-protocol/`、`zcode-protocol-v4/command.ts`（如需） | contract | `HostMessageTypes.ResumeRun` / `ResumeRunResult`（channels.ts，置于 `CronRun` :663 / `OffPeakRun` :665 旁）；schedulerProtocol 消息对 |
| 设置 schema | `packages/shared/src/validationAppSettings.ts` | contract | 4 项设置（仿 `memoryEnabled` :557 模式，见 §10） |
| `quotaWatchdogService.ts` | `packages/services/src/usage-stats/`（或并列新目录） | app/adapters | 状态机与节奏归 domain 纯函数（`nextWatchdogState(state, snapshot, settings)` 无 IO）；网络、定时器、事件发布在 service（adapters 面） |
| `resumeIntentRepo.ts` | `packages/services/src/session/`（`offPeakTaskRepo.ts` 旁） | adapters | sqlite 表访问，仿 `AutomationRepo`/`OffPeakTaskRepo` 模式 |
| 归因判定 | 复用 `packages/ui/src/lib/chatErrorAttribution.ts` 的语义，Host 侧判定落在 service | app | Host 消费 turn.failed 事实 + provider 业务码 → kind=quota/transient；不把 UI 文件引入 services（判定逻辑以业务码表为准，见 §5） |
| scheduler tick | `packages/desktop/src/scheduler/index.ts` + `schedulerProtocol.ts` | app | 仿 offPeak tick 分支；消息对 `resume-dispatch-request` / `resume-dispatch-result`（仿 `offpeak-dispatch-request` :25 / `offpeak-dispatch-result` :70） |
| main 路由 | `packages/desktop/src/main/desktopCronScheduler.ts` | app | 转发 ResumeRun/Result（仿 CronRun/OffPeakRun 路由 :120-199） |
| Host 执行 | `packages/desktop/src/host/index.ts` + `packages/services/src/zcode-agent/zcodeV4HostCommand.ts` | app | `sendHostCasCommandV4` 扩展（§8.2）；回退 sendText（§8.3） |
| DI 注册 | `packages/services/src/node.ts` | — | `QuotaWatchdogService` 进 DI register IIFE（仿 `OffPeakTaskService` :2145 附近；消费已注册的 `IUsageStatsService` :2750） |
| UI | `packages/ui` | ui | 横幅/toast/设置项；只经 hooks 访问服务，日志走 `packages/ui/src/logger.ts` |

依赖方向约束：

- `quotaWatchdogService` 依赖 `IUsageStatsService`（公开入口）与 reset 端点封装（provider
  内部方法），不直接依赖 renderer 任何状态；不反向被 UI import。
- scheduler 只读写 sqlite（意图表）+ 发派发消息，不持凭证、不发业务 HTTP（对齐 offPeak
  scheduler 边界）。
- CLI 侧**零新增模块**：只复用 `retryTurn` handler（`apps/zcode-cli/packages/bootstrap/src/
  zcode-protocol-v4/commands/handlers/fork-edit-retry.ts:314-352`）与 sendText admission。

## 4. 数据模型与存储

`resume_intents`（tasks-index.sqlite，与 `off_peak_tasks` 同库）：

```sql
CREATE TABLE IF NOT EXISTS resume_intents (
  resume_intent_id  TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  workspace_key     TEXT NOT NULL,          -- workspaceIdentity?.trim() || workspacePath
  workspace_identity TEXT,
  kind              TEXT NOT NULL,          -- 'quota' | 'transient'
  attempt           INTEGER NOT NULL DEFAULT 0,
  next_eligible_at  INTEGER NOT NULL,       -- quota: resetTime+60s 或 quotaRestored；transient: 阶梯下一档
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | dispatched | cancelled | exhausted
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
-- 每 task 至多一条 pending：部分唯一索引关闭 TOCTOU（仿 idx_off_peak_bound_active 模式）
CREATE UNIQUE INDEX IF NOT EXISTS idx_resume_pending
  ON resume_intents(task_id) WHERE status = 'pending';
```

Repo 关键方法：`upsertPending`（重复失败只更新 attempt/nextEligibleAt）/ `claimDue(now)`
（`BEGIN IMMEDIATE` 认领，stale claim 回收，仿 `OffPeakTaskRepo.claimDue`）/ `markDispatched` /
`cancel`（用户干预、设置关闭）/ `markExhausted` / `deleteOnSuccess` / `recoverDue(now)`
（启动恢复：`nextEligibleAt` 已到的 pending 交回 scheduler）。

看门狗 checkpoint（同库一张小表或 settings 之外的 kv 表）：持久化
`{ state, lastGoodSnapshot, exhaustionCycleId }`，重启时据此重挂（spec §3.7）；
`quotaRestored` 已发标记随 checkpoint 持久化，防重启后同周期重发。

## 5. 事件顺序（dispatch chain）

```text
turn 失败（in-turn 重试预算已耗尽）
   │
   v
[Host] turn.failed 事实 + 归因
   │   quota：provider 业务码 1005 / 1308 / 1310 / 1304 / 1313 …
   │   （docs/bigmodel-business-error-retry.md:26-66；
   │     apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts
   │     "1005" :73 / "1304" :212 / "1308" :221 / "1310" :239 / "1313" :266）
   │   quota（UI 归因口径）：failureReason "quota_exhausted"
   │   （packages/ui/src/lib/chatErrorAttribution.ts:117, 241-245）
   │   transient：网络/服务端瞬时，预算耗尽后仍失败
   v
[Host] resumeIntentRepo.upsertPending        ←—— 用户新消息/编辑/删除并发到达则 cancel（CAS 于行级）
   │   quota → nextEligibleAt = snapshot.nextResetTime + 60s
   │   transient → nextEligibleAt = now + 1min（下次 5min、再下次 15min）
   v
[scheduler] wake 源三选一（先到先触发）：
   │   ① quotaWatchdogService 的 quotaRestored 事件（转发 scheduler-wake）
   │   ② nextEligibleAt 到期（tick 内自然到期）
   │   ③ transient 阶梯到期
   │
[scheduler] claimDue → resume-dispatch-request
   v
[main] HostMessageTypes.ResumeRun { resumeIntentId, taskId, workspaceKey, kind, attempt }
   v
[Host] 执行恢复：
   │   首选：v4 retryTurn（经 §8.2 扩展 CAS 探测）
   │   回退：attributed sendText（§8.3）
   v
[CLI] CommandInbox admission（唯一接纳点；owner/lease 路由不变）
   │
   ├── turn.completed → Host 清横幅、attempt 清零、intent 删除
   ├── 再次 turn.failed(quota) → attempt+1，仍 < autoResumeMaxConsecutive 则回 upsertPending
   ├── 再次 turn.failed(transient) → 阶梯推进；三档用尽 → markExhausted + 手动横幅
   └── attempt ≥ autoResumeMaxConsecutive（无成功轮）→ markExhausted + 手动横幅
```

看门狗与派发的并发边界：`quotaRestored` 只是唤醒信号；scheduler 派发前**必须再取一次
live snapshot 证实 remaining > 0**（事件与快照之间可能有新消耗），失败则意图不动、等下一
唤醒。瞬时类不需要快照门。

## 6. 看门狗状态机与快照读取

状态机与节奏见 spec §3.1（产品语义）。实现要点：

- 快照唯一入口 `usageStatsService.getEntitlementSnapshot`
  （`packages/services/src/usage-stats/usageStatsService.ts:167-171` →
  `bigmodelUsageQuotaProvider.getSnapshotForRequest`
  `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts:198-315`）。
  Start Plan 走 `buildZaiStartPlanRemaining`（同文件 :1340-1360，取最早 `nextResetTime`）。
- **每次调用都是 live 网络**（`REQUEST_TIMEOUT_MS = 15_000`，:78）：不存在 Host 侧额度
  缓存，看门狗不得自建缓存，只保留 last-good 用于抛错时的调度兜底。
- 抛错保留 last-good 的两类已确认路径：
  - 订阅未知 → provider 直接 throw（`"Coding Plan entitlement refresh failed"`，:262-264）；
  - 账号切换 → `accountRequestAuthService.assertCurrent` throw（:277-282）。
  看门狗捕获后维持原状态与节奏，记录 `warn` 日志；连续失败沿用 usage 既有失败退避。
- `quotaRestored` 判定：WAITING_RESET 唤醒后每 60s 取 snapshot，`remaining > 0`（count 或
  percentage 任一为正）即 RESTORED；checkpoint 写入周期 id，防重发。

## 7. 重置卡认领：限流与对账规则（与 renderer Coordinator 完全一致）

复用的端点（`packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts`）：

| 端点 | 位置 | 要点 |
| --- | --- | --- |
| `GET /api/v1/coding-plan/reset/status` | :523-552 | 只读已发放机会 |
| `POST /use` | :554-578 | `idempotency_key` + `reset_type: FIVE_HOUR\|WEEK`，成功 `used:true` |
| `POST /opportunity` | :580-632 | 看门狗仅在主动状态（WATCHING / CLAIMING / WAITING_RESET）且冷却允许时调用，补位 renderer hidden 轮询真空；3301 → `granted:false + nextTryAt`；裸 429 → `coding_plan_reset_opportunity_throttled` |
| `POST /history/read` | :634-647 | 保持既有 UI 已读链路 |

看门狗必须复刻的规则（来源 `packages/ui/src/lib/codingPlanQuotaResetCoordinator.ts` +
`packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts`）：

- status freshness 1.5s（`STATUS_FRESHNESS_MS = 1_500`，hook :40）；`/use` 确认对账 =
  `/status` 在 `[0, 250, 750, 1500]ms` 重试（`USE_STATUS_RETRY_DELAYS_MS`，:41），观察
  `latest*ResetHistory.usedAt` 出现新值。
- 冷却：granted → +10min；denied(3301) → `max(next_try_at, +5min)`；瞬时错误 → +5min
  **复用同一幂等 key**；429/稳定错误 → +10min **换新 key**
  （coordinator 常量 :5-9：`OPPORTUNITY_MIN_RETRY_MS`/`OPPORTUNITY_DEFAULT_COOLDOWN_MS`/
  `OPPORTUNITY_TRANSIENT_ERROR_RETRY_MS`/`OPPORTUNITY_STABLE_ERROR_COOLDOWN_MS`）。
  看门狗主动状态内触发的 `/opportunity` 与后续 `/use` 考虑共用同一组冷却；与 Coordinator
  的 scope 调度互相独立（多窗口语义：各自冷却，竞争由服务端结算，撞发卡锁 429 各自退避
  10min）。IDLE（remaining > 阈值）绝不触发 `/opportunity`。
- **对账/核销期间绝不调 `/opportunity`**（hook :631 注释记录的互斥原因：会撞发卡锁触发 429）。
- 双核销防护：服务端按机会核销结算，并发不会双消费（hook :751-758 的竞态边界结论）。
  **v1 不迁移 renderer 状态**：看门狗维护自己的核销轨迹与 `/use` in-flight 簿记，并在每次
  发起 `/use` 前做与 hook 相同的强制对账（force 刷新 `/status`，对账后无可核销机会即放弃，
  不携带新幂等键重试）。看门狗与手动点击的残余竞态由服务端按机会结算兜底——与既有
  「跨窗口 / 手机 `/remote` 不共享轨迹」的并发同类，非新增风险类别。把 renderer 手动核销
  轨迹与 `/use` in-flight 状态下沉为 Host 侧单一 owner 的重构**推迟**（§12.1），仅当 v1
  运行证据显示竞态问题时再评估；若实施需同步更新
  [coding-plan-quota-reset-ui.md](../coding-plan-quota-reset-ui.md)。

## 8. 恢复执行：CAS 探测扩展与 sendText 回退

### 8.1 为什么需要 CAS

v4 `retryTurn` 是 row-targeting command：`command-inbox.ts:339-377` 强制
`baseRevision`（:340, :366）与 `baseLogEpoch`（:354）双 CAS，不匹配返回 `stale`。Host 侧
服务没有本地 v4 投影，拿不到当前 revision——这正是既有探测模式要解决的问题。

### 8.2 CAS 探测扩展（首选路径）

复用 `sendHostCasCommandV4`
（`packages/services/src/zcode-agent/zcodeV4HostCommand.ts:138-174`）：

- 现状：首发 `baseRevision=0` 作探测 → stale ACK 带 `revisionAtDecision` → 用它重试，
  `maxAttempts=4`，每次新 commandId（stale 不进幂等表）。
- **缺口**：`ROW_TARGETING_COMMANDS` 要求 `baseLogEpoch`（command-inbox.ts:354），现探测
  只带 `baseRevision`。扩展：stale ACK 的 `proto.staleLogEpoch` 裁决需回传 `logEpochAtDecision`
  （协议 additive 字段），探测循环同时收敛两个基线——任一 stale 即用 ACK 回传值更新对应
  基线后重试；仍受 ≤4 次上限。
- 协议改动落在 `packages/shared/src/zcode-protocol-v4/`（ACK schema additive 字段），
  遵守"协议改动同步 `zcode-protocol` 严格类型 + 运行时校验"的仓库规则；旧 CLI 不回传
  epoch 时探测退化现状（仅 revision CAS），方向安全。
- `retryTurn` 的 target 解析由 CLI 完成（`fork-edit-retry.ts:314-352`：canonical 输入
  messageId → rewind 截断 + 重发 canonical intent），Host 不自行推断目标 row。

### 8.3 attributed sendText 回退（proven fallback）

CAS 探测连续 stale（>4 次，病态并发）或 CLI 版本不支持 retryTurn 时，回退 Host 既有
`sendText` 归属模式：

- `packages/desktop/src/host/index.ts:798-825` 的 `sendPrompt` 已携带
  `offPeakTaskId` + `offPeakRunType: "resume"`；schema 侧
  `packages/shared/src/zcode-protocol-v4/command.ts:126-151` 定义 `automationId` /
  `offPeakTaskId` / `offPeakRunType`（互斥校验）。
- 自动续跑**新增一个归属字段**（如 `resumeIntentId`，与 automationId/offPeakTaskId 同级
  互斥），语义同 offPeak resume：CLI 记录该 turn 的自动来源，UI 横幅归因展示；不改
  CommandInbox admission 顺序。
- 回退路径的行为差异（sendText 从头发送 vs retryTurn rewind 重放 canonical intent）在
  spec 验收中显式接受：回退只在探测失败时发生，且日志记录 `warn` + 回退原因。

## 9. 调度链路（scheduler / main / host 接线）

- scheduler tick：`packages/desktop/src/scheduler/index.ts`（`POLL_INTERVAL_MS = 20_000` :33）
  增加 resume 分支：`claimDue(now)` 认领到期 pending 意图 → 发
  `resume-dispatch-request`；main 失败回执按 offPeak 同款 transient 退避（30s 起、15min
  封顶，`offPeakDispatchSettlement.ts:4-5` 常量独立一份，不复用同一组 map）。
- 启动恢复：对齐 `offPeakRepo.recoverInterrupted`（`scheduler/index.ts:433-445`）——
  `resumeIntentRepo.recoverDue` 把"上个实例 dispatched 未收口"的意图放回 pending（stale
  claim 回收），到期的自然进入本轮 tick。
- main 路由：`desktopCronScheduler.ts` 仿 `CronRun`（:120-199 区段，channels.ts :663）/
  `OffPeakRun`（:665）转发 `ResumeRun` / `ResumeRunResult`；Host 执行块仿 offPeak
  dispatch 块。
- 唤醒：`quotaRestored` 由 watchdog 发给 Host 侧 → 转发 `scheduler-wake`
  （schedulerProtocol.ts :85 已有该消息，可直接复用带载荷变体或新增
  `resume-wake`）→ tick 提前触发。

## 10. 设置接线

- schema：`packages/shared/src/validationAppSettings.ts` 仿 `memoryEnabled`（:557）模式：

```ts
autoResumeEnabled: z.boolean().default(true),
autoClaimResetCardsEnabled: z.boolean().default(true),
quotaWatchThresholdPercent: z.number().int().min(1).max(50).default(10),
autoResumeMaxConsecutive: z.number().int().min(1).max(20).default(5),
```

- 磁盘 owner：`packages/services/src/setting/settingService.ts:220-236`
  （`~/.zcode/v2/setting.json`，实例创建时取路径、读写同源）。
- renderer 读取：`packages/ui/src/hooks/useSettingService.ts:117-183`
  （snapshot + `platform.onSettingsChanged` + `broadcastService` 的 `SettingsChanged`
  广播刷新）；Host 侧 watchdog 直接经 `ISettingService` 读，同一次观测周期内读取一次，
  不逐请求读盘。
- 设置关闭的即时语义：`autoResumeEnabled=false` → 既有 pending 意图批转 cancelled（服务
  层一次事务），看门狗停止新建意图；`autoClaimResetCardsEnabled=false` → CLAIMING 分支
  直接跳过（spec §3.2）。

## 11. 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 自动核销在无用户点击时消耗重置卡（用户可能想留卡） | 资产被自动使用，用户不满 | 默认可关（`autoClaimResetCardsEnabled`）；每次核销强制 toast + 进入既有 history（可追溯）；只核销 FIVE_HOUR、留 WEEK 给用户决策；额度未到 ≤1% 绝不核销 |
| 服务端限流（/opportunity 发卡锁、裸 429） | 高频空轮询、429 风暴 | 看门狗仅在主动状态触发 `/opportunity`（>10% 零请求）；对账期间零 `/opportunity`；冷却规则与 Coordinator 逐条对齐（§7）；节奏上限 2min（WATCHING）/45s（CLAIMING） |
| 双通道核销（看门狗 + 手动点击）竞态 | 重复 `/use` 或误判 | 服务端按机会结算兜底（已确认）；Host 侧单一核销轨迹 owner + 强制对账后才发 `/use`（§7）；幂等 key 规则复用 |
| CAS 探测脆弱（baseLogEpoch 扩展、CLI 版本差异） | retryTurn 派发失败 | additive ACK 字段向后安全；≤4 次探测上限；失败回退 attributed sendText（proven 路径）；回退原因 `warn` 日志 |
| 看门狗随 App 退出而消失 | 等待期无守护、恢复延迟 | 明确文档化限制（spec §3.6）；意图 + checkpoint 持久化，重启后 `recoverDue` + checkpoint 重挂；验收 D 锁定该行为 |
| 误触发自动续跑（归因错误，如把配置错误当额度） | 无意义重试消耗额度 | 归因白名单（terminal quota 业务码表 + quota_exhausted）；非白名单不建意图；连续上限 5 兜底 |
| 与闲时任务派发争用同一会话 | 会话双执行 | 复用 CommandInbox admission 与 owner/lease；ResumeRun 派发前探测目标 task busy（对齐 offPeak bound-session busy 探测模式），busy 则 transient 退避 |
| 快照频繁 live 请求 | 请求放大 | 节奏钳制（spec §3.1 表）；>10% 零新增周期请求；观测点合并（一次 snapshot 同时服务状态机与派发门） |

## 12. 开放问题

1. **核销轨迹下沉（已推迟）**：v1 看门狗自带轨迹 + `/use` 前强制对账（§7），renderer hook
   不改；仅当运行证据显示看门狗与手动点击的竞态造成实际问题时，再启动"manual reset
   attempt 轨迹 + `/use` in-flight 下沉为 Host 单一 owner"的迁移（涉及
   `coding-plan-quota-reset-ui.md` 状态模型改写）。
2. **`quotaRestored` 的消费面**：除唤醒额度类意图外，是否同时通知 renderer（横幅倒计时
   刷新）？倾向"是，走既有 usage 刷新链路"，实现时确认。
3. **多窗口/多 Host 实例**：window-scoped Local Host 下看门狗应挂在哪个 Host（倾向：与
   scheduler 同生命周期的单实例服务，不随窗口重建）；实现前用
   `pnpm architecture:context` 核对 services node 的装配面。
4. **baseLogEpoch 的 stale ACK 回传字段命名**：`logEpochAtDecision` 待协议评审定名
   （§8.2）。
