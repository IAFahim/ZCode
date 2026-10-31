// resume_intents + 看门狗 checkpoint schema（migration 0007）。
// 领域规则见 docs/quota-watchdog/spec.md；表结构与 off_peak_tasks 同库独立，
// 禁止往 automations/off_peak_tasks 上加字段。
// 部分唯一索引 idx_resume_pending 关闭"每 task 至多一条 pending"的 TOCTOU
//（仿 idx_off_peak_bound_active 模式）。
export const RESUME_INTENTS_SCHEMA = `
      CREATE TABLE IF NOT EXISTS resume_intents (
        resume_intent_id   TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL,
        workspace_path     TEXT NOT NULL,
        workspace_key      TEXT NOT NULL,
        workspace_identity TEXT,
        kind               TEXT NOT NULL,
        attempt            INTEGER NOT NULL DEFAULT 0,
        next_eligible_at   INTEGER NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending',
        last_error         TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_resume_pending
      ON resume_intents(task_id) WHERE status = 'pending';

      CREATE INDEX IF NOT EXISTS idx_resume_pick
      ON resume_intents (status, next_eligible_at);

      CREATE TABLE IF NOT EXISTS quota_watchdog_checkpoint (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `;
