import {
  RESUME_QUOTA_WAKE_MARGIN_MS,
  RESUME_TRANSIENT_BACKOFF_MS,
  type ResumeIntent,
  type ResumeIntentKind,
  type ResumeIntentStatus,
} from "@zcode/shared";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { resolveWorkspaceKey } from "@zcode/shared";

/* 自动续跑意图仓库：resume_intents 的 sqlite schema 守卫写入与到期认领。
   与 off_peak_tasks 同库（tasks-index.sqlite）但表/状态机完全独立，禁止互加字段。
   领域规则：每 task 至多一条 pending（部分唯一索引）；重复失败只更新既有行；
   dispatched 行若持有者崩溃由启动恢复回收（resume-intents 无独立 claim 锁，
   dispatched→pending 的回收在 recoverStaleDispatched，见 quotaWatchdogService 启动路径）。 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** dispatched 超时回收：超过该时长仍未收口（成功/再失败/放弃）视为持有者已崩溃。 */
export const RESUME_DISPATCH_STALE_MS = 15 * 60_000;

interface ResumeIntentRow {
  resume_intent_id: string;
  task_id: string;
  workspace_path: string;
  workspace_key: string;
  workspace_identity: string | null;
  kind: string;
  attempt: number;
  next_eligible_at: number;
  status: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToIntent(row: ResumeIntentRow): ResumeIntent {
  return {
    resumeIntentId: row.resume_intent_id,
    taskId: row.task_id,
    workspacePath: row.workspace_path,
    workspaceKey: row.workspace_key,
    ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
    kind: row.kind as ResumeIntentKind,
    attempt: row.attempt,
    nextEligibleAt: row.next_eligible_at,
    status: row.status as ResumeIntentStatus,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ResumeIntentUpsertParams {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  kind: ResumeIntentKind;
  /** quota: nextResetTime + RESUME_QUOTA_WAKE_MARGIN_MS；transient: 阶梯到期时刻。 */
  nextEligibleAt: number;
  lastError?: string;
}

/** INSERT 撞上 idx_resume_pending（并发双创建的失败方）；调用方应改为更新既有行。 */
export function isResumePendingConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: resume_intents\.task_id/.test(error.message)
  );
}

export class ResumeIntentRepo {
  migrationBackupSkipped = false;
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  // 同 OffPeakTaskRepo：构造期固定 dbPath，测试依赖注入临时库路径，避免 vitest 并发污染。
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db))
      this.migrationBackupSkipped = (await runTasksDatabaseMigrations(this.db, path)).backupSkipped;
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("ResumeIntentRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  private getRow(resumeIntentId: string): ResumeIntentRow | null {
    const row = this.getDatabase()
      .prepare(`SELECT * FROM resume_intents WHERE resume_intent_id = ?`)
      .get(resumeIntentId) as ResumeIntentRow | undefined;
    return row ?? null;
  }

  private getPendingByTask(taskId: string): ResumeIntentRow | null {
    const row = this.getDatabase()
      .prepare(`SELECT * FROM resume_intents WHERE task_id = ? AND status = 'pending' LIMIT 1`)
      .get(taskId) as ResumeIntentRow | undefined;
    return row ?? null;
  }

  // ---- 写入 ----

  /**
   * 建 pending 意图；同 task 已有 pending 时**更新**既有行（attempt 在既有值上 +1，
   * kind/nextEligibleAt 以最新失败为准），不叠加第二行。返回生效后的意图。
   */
  async upsertPending(
    params: ResumeIntentUpsertParams,
    options?: { now?: number },
  ): Promise<ResumeIntent> {
    await this.ensureReady();
    const db = this.getDatabase();
    const now = options?.now ?? Date.now();
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getPendingByTask(params.taskId);
      if (existing) {
        db.prepare(
          `UPDATE resume_intents
          SET kind = @kind,
              attempt = attempt + 1,
              next_eligible_at = @next_eligible_at,
              workspace_path = @workspace_path,
              workspace_key = @workspace_key,
              workspace_identity = @workspace_identity,
              last_error = @last_error,
              updated_at = @now
          WHERE resume_intent_id = @id AND status = 'pending'`,
        ).run({
          id: existing.resume_intent_id,
          kind: params.kind,
          next_eligible_at: params.nextEligibleAt,
          workspace_path: params.workspacePath,
          workspace_key: workspaceKey,
          workspace_identity: params.workspaceIdentity ?? null,
          last_error: params.lastError ?? existing.last_error,
          now,
        });
        const row = this.getRow(existing.resume_intent_id)!;
        db.exec("COMMIT");
        return rowToIntent(row);
      }
      const resumeIntentId = `resume-${randomUUID()}`;
      db.prepare(
        `INSERT INTO resume_intents (
          resume_intent_id, task_id, workspace_path, workspace_key, workspace_identity,
          kind, attempt, next_eligible_at, status, last_error, created_at, updated_at
        ) VALUES (
          @id, @task_id, @workspace_path, @workspace_key, @workspace_identity,
          @kind, 0, @next_eligible_at, 'pending', @last_error, @now, @now
        )`,
      ).run({
        id: resumeIntentId,
        task_id: params.taskId,
        workspace_path: params.workspacePath,
        workspace_key: workspaceKey,
        workspace_identity: params.workspaceIdentity ?? null,
        kind: params.kind,
        next_eligible_at: params.nextEligibleAt,
        last_error: params.lastError ?? null,
        now,
      });
      const row = this.getRow(resumeIntentId)!;
      db.exec("COMMIT");
      return rowToIntent(row);
    } catch (error) {
      db.exec("ROLLBACK");
      // 并发创建撞唯一索引时按语义重试一次（另一进程刚建了 pending 行）。
      if (isResumePendingConflict(error)) {
        return this.upsertPending(params, options);
      }
      throw error;
    }
  }

  /**
   * 到期认领：pending 且 next_eligible_at ≤ now，原子迁移 pending→dispatched。
   * 认领即派发开始；结局由 settle/再失败路径收口，崩溃行由 recoverStaleDispatched 回收。
   */
  async claimDue(now: number): Promise<ResumeIntent[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const dueRows = db
        .prepare(
          `SELECT * FROM resume_intents
          WHERE status = 'pending' AND next_eligible_at <= @now
          ORDER BY next_eligible_at ASC`,
        )
        .all({ now }) as unknown as ResumeIntentRow[];
      const claimed: ResumeIntent[] = [];
      const claim = db.prepare(
        `UPDATE resume_intents
        SET status = 'dispatched', updated_at = @now
        WHERE resume_intent_id = @id AND status = 'pending'`,
      );
      for (const row of dueRows) {
        const res = claim.run({ id: row.resume_intent_id, now });
        if (res.changes === 1) {
          claimed.push(rowToIntent({ ...row, status: "dispatched", updated_at: now }));
        }
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 派发执行成功（turn 正常完成语义由调用方确认后调用）：删除意图行（attempt 清零的领域表达）。 */
  async deleteOnSuccess(resumeIntentId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(`DELETE FROM resume_intents WHERE resume_intent_id = ?`)
      .run(resumeIntentId);
  }

  /**
   * 派发后再次失败：dispatched 行回到 pending 并推进 attempt / nextEligibleAt；
   * attempt+1 ≥ maxConsecutive（由调用方先判定）时改走 markExhausted。返回 null 表示行已被
   * 并发路径（取消/删除）收口，调用方放弃。
   */
  async requeueAfterFailure(
    resumeIntentId: string,
    next: { kind: ResumeIntentKind; nextEligibleAt: number; lastError?: string },
    options?: { now?: number },
  ): Promise<ResumeIntent | null> {
    await this.ensureReady();
    const now = options?.now ?? Date.now();
    const res = this.getDatabase()
      .prepare(
        `UPDATE resume_intents
        SET status = 'pending',
            kind = @kind,
            attempt = attempt + 1,
            next_eligible_at = @next_eligible_at,
            last_error = @last_error,
            updated_at = @now
        WHERE resume_intent_id = @id AND status = 'dispatched'`,
      )
      .run({
        id: resumeIntentId,
        kind: next.kind,
        next_eligible_at: next.nextEligibleAt,
        last_error: next.lastError ?? null,
        now,
      });
    if (res.changes !== 1) return null;
    return rowToIntent(this.getRow(resumeIntentId)!);
  }

  /** 连续上限触达：终态 exhausted（不可逆出），UI 据此展示"已暂停自动重试"。 */
  async markExhausted(resumeIntentId: string, lastError: string, options?: { now?: number }): Promise<ResumeIntent | null> {
    await this.ensureReady();
    const now = options?.now ?? Date.now();
    const res = this.getDatabase()
      .prepare(
        `UPDATE resume_intents
        SET status = 'exhausted', last_error = @last_error, updated_at = @now
        WHERE resume_intent_id = @id AND status IN ('pending','dispatched')`,
      )
      .run({ id: resumeIntentId, last_error: lastError, now });
    if (res.changes !== 1) return null;
    return rowToIntent(this.getRow(resumeIntentId)!);
  }

  /**
   * 派发前守卫的重排（不消耗 attempt）：dispatched 行回到 pending 并推迟 nextEligibleAt。
   * 与 requeueAfterFailure 的区别：这是"还没真正派发"的守卫退避（如额度未恢复），不算一次尝试。
   */
  async reschedulePending(
    resumeIntentId: string,
    nextEligibleAt: number,
    options?: { now?: number },
  ): Promise<ResumeIntent | null> {
    await this.ensureReady();
    const now = options?.now ?? Date.now();
    const res = this.getDatabase()
      .prepare(
        `UPDATE resume_intents
        SET status = 'pending', next_eligible_at = @next_eligible_at, updated_at = @now
        WHERE resume_intent_id = @id AND status = 'dispatched'`,
      )
      .run({ id: resumeIntentId, next_eligible_at: nextEligibleAt, now });
    if (res.changes !== 1) return null;
    return rowToIntent(this.getRow(resumeIntentId)!);
  }

  /**
   * 用户干预取消（新消息/编辑/删除/显式停止/设置关闭）：pending 或 dispatched 均可取消；
   * dispatched 行的执行结果回来时调用方以 null/行缺失为准丢弃。幂等。
   */
  async cancel(taskId: string, reason: string, options?: { now?: number }): Promise<boolean> {
    await this.ensureReady();
    const now = options?.now ?? Date.now();
    const res = this.getDatabase()
      .prepare(
        `UPDATE resume_intents
        SET status = 'cancelled', last_error = @reason, updated_at = @now
        WHERE task_id = @task_id AND status IN ('pending','dispatched')`,
      )
      .run({ task_id: taskId, reason, now });
    return res.changes > 0;
  }

  /** 读取 task 当前生效意图（pending 优先，其次 dispatched/exhausted 供横幅展示）。 */
  async getEffectiveByTask(taskId: string): Promise<ResumeIntent | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM resume_intents
        WHERE task_id = @task_id AND status IN ('pending','dispatched','exhausted')
        ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'dispatched' THEN 1 ELSE 2 END,
          updated_at DESC
        LIMIT 1`,
      )
      .get({ task_id: taskId }) as ResumeIntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  /** 全部 pending 意图（看门狗 tick 输入：有无待派发、最近到期时刻）。 */
  async listPending(): Promise<ResumeIntent[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(`SELECT * FROM resume_intents WHERE status = 'pending' ORDER BY next_eligible_at ASC`)
      .all() as unknown as ResumeIntentRow[];
    return rows.map(rowToIntent);
  }

  /**
   * 启动恢复（Host 启动时调用一次）：崩溃实例残留的 dispatched 行回到 pending
   * （attempt/nextEligibleAt 保留，nextEligibleAt 已过则本轮 tick 自然认领）。
   */
  async recoverStaleDispatched(now: number): Promise<number> {
    await this.ensureReady();
    const res = this.getDatabase()
      .prepare(
        `UPDATE resume_intents
        SET status = 'pending', updated_at = @now
        WHERE status = 'dispatched'
          AND updated_at <= @stale`,
      )
      .run({ now, stale: now - RESUME_DISPATCH_STALE_MS });
    return Number(res.changes ?? 0);
  }

  // ---- 看门狗 checkpoint（同库 kv，单行）----

  async setCheckpoint(key: string, value: string, options?: { now?: number }): Promise<void> {
    await this.ensureReady();
    const now = options?.now ?? Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO quota_watchdog_checkpoint (key, value, updated_at)
        VALUES (@key, @value, @now)
        ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @now`,
      )
      .run({ key, value, now });
  }

  async getCheckpoint(key: string): Promise<string | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT value FROM quota_watchdog_checkpoint WHERE key = @key`)
      .get({ key }) as { value: string } | undefined;
    return row?.value ?? null;
  }
}

/** 瞬时失败阶梯下一档到期时刻；超出阶梯（三档用尽）返回 null，调用方走 exhausted。 */
export function nextTransientEligibleAt(attempt: number, now: number): number | null {
  const delay = RESUME_TRANSIENT_BACKOFF_MS[attempt];
  return delay === undefined ? null : now + delay;
}

/** 额度类意图的派发资格时刻。 */
export function quotaEligibleAt(nextResetTime: number, now: number): number {
  return Math.max(nextResetTime, now) + RESUME_QUOTA_WAKE_MARGIN_MS;
}
