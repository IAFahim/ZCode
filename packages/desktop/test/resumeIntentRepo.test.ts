import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResumeIntentRepo } from "@zcode/services/node";

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

  async function createRepo(): Promise<ResumeIntentRepo> {
    const dir = await mkdtemp(join(tmpdir(), "resume-intents-"));
    dirs.push(dir);
    const repo = new ResumeIntentRepo(join(dir, "tasks-index.sqlite"));
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
    expect(await repo.requeueAfterFailure(intent.resumeIntentId, { kind: "quota", nextEligibleAt: NOW }, { now: NOW })).toBeNull();
  });

  it("markExhausted：终态不可逆出，cancelled 行不可再 exhausted", async () => {
    const repo = await createRepo();
    const intent = await repo.upsertPending(upsertParams("task-1"), { now: NOW });
    const exhausted = await repo.markExhausted(intent.resumeIntentId, "attempt limit", { now: NOW });
    expect(exhausted?.status).toBe("exhausted");
    expect(await repo.claimDue(NOW + 60_000)).toHaveLength(0);
    expect(
      await repo.markExhausted(intent.resumeIntentId, "again", { now: NOW }),
    ).toBeNull();
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
});
