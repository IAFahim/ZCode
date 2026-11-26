import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResumeIntentRepo } from "@zcode/services/node";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

// 自动续跑意图仓库回归（docs/quota-watchdog/tech-design.md §4）。
// 每用例独立临时库：ResumeIntentRepo 构造期固定 dbPath（与 OffPeakTaskRepo 同款测试注入）。

const NOW = 1_700_000_000_000;

describe("ResumeIntentRepo", () => {
  const dirs: string[] = [];
  const repos: ResumeIntentRepo[] = [];

  beforeAll(() => {});
  afterAll(async () => {
    for (const repo of repos) repo.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  /** 最近一次 createRepo 的库路径（需要在同一库上开第二个连接写入历史数据时使用）。 */
  let lastDbPath = "";

  async function createRepo(): Promise<ResumeIntentRepo> {
    const dir = await mkdtemp(join(tmpdir(), "resume-intents-"));
    dirs.push(dir);
    lastDbPath = join(dir, "tasks-index.sqlite");
    const repo = new ResumeIntentRepo(lastDbPath);
    repos.push(repo);
    return repo;
  }

  function upsertParams(taskId: string, nextEligibleAt = NOW + 60_000) {
    return {
      taskId,
      workspacePath: "/tmp/workspace",
      kind: "quota" as const,
      nextEligibleAt,
      lastError: "usage limit reached",
    };
  }

  it("upsertPending：首建 pending；同 task 重复失败只更新既有行并累加 attempt", async () => {
    const repo = await createRepo();
    const first = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    expect(first.status).toBe("pending");
    expect(first.attempt).toBe(0);
    expect(first.workspaceKey).toBe("/tmp/workspace");
    expect(first.workspacePath).toBe("/tmp/workspace");

    const second = await repo.upsertPending(
      { ...upsertParams("task-1", NOW + 120_000), kind: "transient" as const },
      { now: NOW + 1_000 },
    );
    expect(second.resumeIntentId).toBe(first.resumeIntentId);
    expect(second.attempt).toBe(1);
    expect(second.kind).toBe("transient");
    expect(second.nextEligibleAt).toBe(NOW + 120_000);
  });

  it("claimDue：仅认领到期 pending，原子迁移 dispatched；未到期不认领", async () => {
    const repo = await createRepo();
    await repo.upsertPending(upsertParams("task-due", NOW - 1), { now: NOW });
    await repo.upsertPending(upsertParams("task-future", NOW + 60_000), { now: NOW });

    const claimed = await repo.claimDue(NOW);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.taskId).toBe("task-due");
    expect(claimed[0]!.status).toBe("dispatched");

    // dispatched 行不会被二次认领；未到期的行此时仍不可认领。
    expect(await repo.claimDue(NOW + 30_000)).toHaveLength(0);
    // 到期后未认领的行正常进入认领。
    const later = await repo.claimDue(NOW + 120_000);
    expect(later.map((intent) => intent.taskId)).toEqual(["task-future"]);
  });

  it("reschedulePending：派发守卫重排不消耗 attempt，仅 dispatched 行可重排", async () => {
    const repo = await createRepo();
    const intent = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    await repo.claimDue(NOW + 120_000);
    const rescheduled = await repo.reschedulePending(intent.resumeIntentId, NOW + 300_000, {
      now: NOW,
    });
    expect(rescheduled?.status).toBe("pending");
    expect(rescheduled?.attempt).toBe(0);
    expect(rescheduled?.nextEligibleAt).toBe(NOW + 300_000);
    // pending 行不可重排（守卫只作用于已认领的 dispatched 行）。
    expect(await repo.reschedulePending(intent.resumeIntentId, NOW, { now: NOW })).toBeNull();
  });

  it("requeueAfterFailure：attempt+1 回 pending；非 dispatched 行返回 null", async () => {
    const repo = await createRepo();
    const intent = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    await repo.claimDue(NOW + 60_000);
    const requeued = await repo.requeueAfterFailure(
      intent.resumeIntentId,
      { kind: "quota", nextEligibleAt: NOW + 600_000, lastError: "still failing" },
      { now: NOW },
    );
    expect(requeued?.status).toBe("pending");
    expect(requeued?.attempt).toBe(1);
    expect(requeued?.lastError).toBe("still failing");
    expect(
      await repo.requeueAfterFailure(
        intent.resumeIntentId,
        { kind: "quota", nextEligibleAt: NOW },
        { now: NOW },
      ),
    ).toBeNull();
  });

  it("upsertPending(attemptMode)：keep 不推进、默认 increment、reset 清零（均在同一条 pending 行）", async () => {
    const repo = await createRepo();
    const first = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    expect(first.attempt).toBe(0);
    const kept = await repo.upsertPending(upsertParams("task-1"), {
      now: NOW + 1,
      attemptMode: "keep",
    });
    expect(kept.resumeIntentId).toBe(first.resumeIntentId);
    expect(kept.attempt).toBe(0);
    const incremented = await repo.upsertPending(upsertParams("task-1"), { now: NOW + 2 });
    expect(incremented.attempt).toBe(1);
    const reset = await repo.upsertPending(upsertParams("task-1"), {
      now: NOW + 3,
      attemptMode: "reset",
    });
    expect(reset.attempt).toBe(0);
  });

  it("失败上报撞上在途 dispatched 行：收敛回同一行而不是另插一条（v1/v2 UNIQUE 竞态回归）", async () => {
    const repo = await createRepo();
    const intent = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    await repo.claimDue(NOW + 60_000);
    // 派发中的 turn 失败，Host 先收到失败事实（此时行仍是 dispatched）。
    const reported = await repo.upsertPending(
      { ...upsertParams("task-1", NOW + 300_000), lastError: "usage limit" },
      { now: NOW + 61_000 },
    );
    expect(reported.resumeIntentId).toBe(intent.resumeIntentId);
    expect(reported.status).toBe("pending");
    expect(reported.attempt).toBe(1);
    // 随后结局结算到达：行已不是 dispatched → 返回 null（调用方跳过），绝不抛 UNIQUE、不重复计数。
    expect(
      await repo.requeueAfterFailure(
        intent.resumeIntentId,
        { kind: "quota", nextEligibleAt: NOW },
        { now: NOW + 61_100 },
      ),
    ).toBeNull();
    expect((await repo.listPending()).length).toBe(1);
    expect((await repo.listPending())[0]?.attempt).toBe(1);
  });

  it("requeueAfterFailure(attemptMode)：keep 用于等待型失败，reset 用于新耗尽周期", async () => {
    const repo = await createRepo();
    const intent = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    await repo.claimDue(NOW + 60_000);
    const kept = await repo.requeueAfterFailure(
      intent.resumeIntentId,
      { kind: "quota", nextEligibleAt: NOW + 60_000 },
      { now: NOW, attemptMode: "keep" },
    );
    expect(kept?.attempt).toBe(0);
    await repo.claimDue(NOW + 120_000);
    const incremented = await repo.requeueAfterFailure(
      intent.resumeIntentId,
      { kind: "quota", nextEligibleAt: NOW + 60_000 },
      { now: NOW },
    );
    expect(incremented?.attempt).toBe(1);
    await repo.claimDue(NOW + 180_000);
    const reset = await repo.requeueAfterFailure(
      intent.resumeIntentId,
      { kind: "quota", nextEligibleAt: NOW + 60_000 },
      { now: NOW, attemptMode: "reset" },
    );
    expect(reset?.attempt).toBe(0);
  });

  it("reschedulePending(kind)：守卫重排可改写 kind（transient→quota 转换），不消耗 attempt", async () => {
    const repo = await createRepo();
    const intent = await repo.upsertPending(
      { ...upsertParams("task-1"), kind: "transient" as const },
      { now: NOW },
    );
    await repo.claimDue(NOW + 60_000);
    const converted = await repo.reschedulePending(intent.resumeIntentId, NOW + 300_000, {
      now: NOW,
      kind: "quota",
    });
    expect(converted?.kind).toBe("quota");
    expect(converted?.attempt).toBe(0);
    expect(converted?.status).toBe("pending");
  });

  it("recoverStaleDispatched：同 task 已有 pending 行时删除残留 dispatched 行，不再撞 UNIQUE", async () => {
    const repo = await createRepo();
    const fresh = await repo.upsertPending(upsertParams("task-1", NOW + 120_000), { now: NOW });
    // v1/v2 遗留形态：同 task 另有一条卡死的 dispatched 残留行。新仓库 API 已无法造出
    // 这种双行（upsertPending 会收敛），所以直接用第二个连接写入历史数据。
    const legacy = new DatabaseSync(lastDbPath);
    legacy
      .prepare(
        `INSERT INTO resume_intents (
          resume_intent_id, task_id, workspace_path, workspace_key, workspace_identity,
          kind, attempt, next_eligible_at, status, last_error, created_at, updated_at
        ) VALUES ('resume-legacy-stale', 'task-1', '/tmp/workspace', '/tmp/workspace', NULL,
          'quota', 3, @due, 'dispatched', NULL, @at, @at)`,
      )
      .run({ due: NOW + 60_000, at: NOW - 20 * 60_000 });
    legacy.close();
    await expect(repo.recoverStaleDispatched(NOW + 16 * 60_000)).resolves.toBe(0);
    const pending = await repo.listPending();
    expect(pending.map((row) => row.resumeIntentId)).toEqual([fresh.resumeIntentId]);
    expect(await repo.getEffectiveByTask("task-1")).toMatchObject({ status: "pending" });
  });

  it("bringPendingForward：只把同 kind 且更晚的到期时刻提前，不推迟、不跨 kind", async () => {
    const repo = await createRepo();
    const later = await repo.upsertPending(upsertParams("quota-later", NOW + 3_600_000), {
      now: NOW,
    });
    await repo.upsertPending(upsertParams("quota-sooner", NOW + 5_000), { now: NOW });
    await repo.upsertPending(
      { ...upsertParams("transient-1", NOW + 3_600_000), kind: "transient" as const },
      { now: NOW },
    );
    expect(await repo.bringPendingForward("quota", NOW + 10_000, { now: NOW })).toBe(1);
    const byTask = new Map((await repo.listPending()).map((row) => [row.taskId, row]));
    expect(byTask.get("quota-later")?.nextEligibleAt).toBe(NOW + 10_000);
    expect(byTask.get("quota-later")?.attempt).toBe(0);
    expect(byTask.get("quota-sooner")?.nextEligibleAt).toBe(NOW + 5_000);
    expect(byTask.get("transient-1")?.nextEligibleAt).toBe(NOW + 3_600_000);
  });

  it("markExhausted：终态不可逆出，cancelled 行不可再 exhausted", async () => {
    const repo = await createRepo();
    const intent = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    const exhausted = await repo.markExhausted(intent.resumeIntentId, "attempt limit", {
      now: NOW,
    });
    expect(exhausted?.status).toBe("exhausted");
    expect(await repo.claimDue(NOW + 60_000)).toHaveLength(0);
    expect(await repo.markExhausted(intent.resumeIntentId, "again", { now: NOW })).toBeNull();
  });

  it("cancel：pending/dispatched 均可取消；getEffectiveByTask 优先 pending 其次 exhausted", async () => {
    const repo = await createRepo();
    await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    expect(await repo.cancel("task-1", "user_stop_banner", { now: NOW })).toBe(true);
    const effective = await repo.getEffectiveByTask("task-1");
    // cancelled 不在展示面（只有 pending/dispatched/exhausted）。
    expect(effective).toBeNull();
    // 幂等：重复取消返回 false。
    expect(await repo.cancel("task-1", "user_stop_banner", { now: NOW })).toBe(false);
  });

  it("recoverStaleDispatched：超时 dispatched 行回到 pending，保留 attempt", async () => {
    const repo = await createRepo();
    const intent = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    await repo.claimDue(NOW + 60_000);
    // 未超时不回收。
    expect(await repo.recoverStaleDispatched(NOW)).toBe(0);
    expect(await repo.recoverStaleDispatched(NOW + 16 * 60_000)).toBe(1);
    const recovered = await repo.getEffectiveByTask("task-1");
    expect(recovered?.status).toBe("pending");
    expect(recovered?.resumeIntentId).toBe(intent.resumeIntentId);
  });

  it("checkpoint：单行 upsert + 读取", async () => {
    const repo = await createRepo();
    expect(await repo.getCheckpoint("watchdog")).toBeNull();
    await repo.setCheckpoint("watchdog", JSON.stringify({ a: 1 }), { now: NOW });
    await repo.setCheckpoint("watchdog", JSON.stringify({ a: 2 }), { now: NOW + 1 });
    expect(await repo.getCheckpoint("watchdog")).toBe(JSON.stringify({ a: 2 }));
  });

  it("recoverStaleDispatched(olderThanMs: 0)：进程启动时回收全部 dispatched 行（v2 只回收 15 分钟前的，崩溃前刚派发的意图永远卡住）", async () => {
    const repo = await createRepo();
    await repo.upsertPending(upsertParams("task-fresh"), { now: NOW });
    await repo.upsertPending(upsertParams("task-old"), { now: NOW });
    await repo.claimDue(NOW + 60_000);
    // 运行期语义：两条都"未超时"，不回收。
    expect(await repo.recoverStaleDispatched(NOW + 60_000)).toBe(0);
    // 启动语义：进程刚起，不可能有上一实例的在途派发还活着，全部回收且 attempt 保留。
    expect(await repo.recoverStaleDispatched(NOW + 60_000, { olderThanMs: 0 })).toBe(2);
    expect((await repo.getActiveByTask("task-fresh"))?.status).toBe("pending");
    expect((await repo.getActiveByTask("task-old"))?.status).toBe("pending");
  });

  it("getActiveByTask：pending / dispatched 都算活跃；终态与无行返回 null", async () => {
    const repo = await createRepo();
    expect(await repo.getActiveByTask("task-1")).toBeNull();
    const intent = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    expect((await repo.getActiveByTask("task-1"))?.resumeIntentId).toBe(intent.resumeIntentId);
    await repo.claimDue(NOW + 60_000);
    expect((await repo.getActiveByTask("task-1"))?.status).toBe("dispatched");
    await repo.markExhausted(intent.resumeIntentId, "give up", { now: NOW });
    expect(await repo.getActiveByTask("task-1")).toBeNull();
  });

  it("新一轮失败建意图时清理上一轮的终态行（exhausted/cancelled 不累积，也不被误读为当前状态）", async () => {
    const repo = await createRepo();
    const first = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    await repo.markExhausted(first.resumeIntentId, "give up", { now: NOW });
    const cancelled = await repo.upsertPending(upsertParams("task-2"), { now: NOW });
    await repo.cancel("task-2", "user_input", { now: NOW });
    // 再次失败：各建一条新的 pending 行，attempt 从 0 开始。
    const second = await repo.upsertPending(upsertParams("task-1"), { now: NOW + 1 });
    const revived = await repo.upsertPending(upsertParams("task-2"), { now: NOW + 1 });
    expect(second.resumeIntentId).not.toBe(first.resumeIntentId);
    expect(second.attempt).toBe(0);
    expect(revived.resumeIntentId).not.toBe(cancelled.resumeIntentId);
    const db = new DatabaseSync(lastDbPath);
    try {
      const rows = db
        .prepare(`SELECT task_id, status FROM resume_intents ORDER BY task_id`)
        .all() as Array<{ task_id: string; status: string }>;
      // 旧终态行已删除：每个 task 只剩新的 pending 行。
      expect(rows).toEqual([
        { task_id: "task-1", status: "pending" },
        { task_id: "task-2", status: "pending" },
      ]);
    } finally {
      db.close();
    }
  });
});
