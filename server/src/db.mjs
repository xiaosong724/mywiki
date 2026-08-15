import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

let db = null;

export function initDb() {
  if (db) return db;
  db = new DatabaseSync(path.join(DATA_DIR, 'knowledge.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS entries (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      payload    TEXT NOT NULL DEFAULT '{}',
      tags       TEXT NOT NULL DEFAULT '',
      location   TEXT,
      owner      TEXT,
      is_private INTEGER NOT NULL DEFAULT 0,
      remind_at  TEXT,
      recurrence TEXT NOT NULL DEFAULT 'none',
      notified_at TEXT,
      done       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 老库迁移：补 owner 列
    CREATE TABLE IF NOT EXISTS identities (
      qq_id      TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_configs (
      group_id    TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      type_rules  TEXT NOT NULL DEFAULT '{}',
      member_private_chat INTEGER NOT NULL DEFAULT 1,
      default_member_rules TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS type_label_overrides (
      type_key   TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS member_permissions (
      qq_id      TEXT NOT NULL,
      group_id   TEXT NOT NULL,
      rules      TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (qq_id, group_id)
    );

    CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
    CREATE INDEX IF NOT EXISTS idx_entries_remind ON entries(remind_at);
    CREATE INDEX IF NOT EXISTS idx_entries_done ON entries(done);

    CREATE TABLE IF NOT EXISTS attachments (
      id          TEXT PRIMARY KEY,
      entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       TEXT NOT NULL,
      actor    TEXT NOT NULL,
      action   TEXT NOT NULL,
      entry_id TEXT,
      summary  TEXT
    );

    -- FTS5 索引：中文短词先用 LIKE 检索（见 entries.mjs），FTS 保留给后续向量/长文优化
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      title, content, tags, location,
      content='',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS entries_fts_ai AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(rowid, title, content, tags, location)
      VALUES (new.rowid, new.title, new.content, new.tags, coalesce(new.location,''));
    END;

    CREATE TRIGGER IF NOT EXISTS entries_fts_ad AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, content, tags, location)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags, coalesce(old.location,''));
    END;

    CREATE TRIGGER IF NOT EXISTS entries_fts_au AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, content, tags, location)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags, coalesce(old.location,''));
      INSERT INTO entries_fts(rowid, title, content, tags, location)
      VALUES (new.rowid, new.title, new.content, new.tags, coalesce(new.location,''));
    END;
  `);
  // 老库迁移：entries 补 owner 列（已存在则忽略）
  try {
    db.exec('ALTER TABLE entries ADD COLUMN owner TEXT');
  } catch { /* 已存在 */ }
  try {
    db.exec('ALTER TABLE entries ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0');
  } catch { /* 已存在 */ }
  try {
    db.exec('ALTER TABLE group_configs ADD COLUMN member_private_chat INTEGER NOT NULL DEFAULT 1');
  } catch { /* 已存在 */ }
  try {
    db.exec("ALTER TABLE group_configs ADD COLUMN default_member_rules TEXT NOT NULL DEFAULT '{}'");
  } catch { /* 已存在 */ }
  // 类型合并迁移：重要日期已并入 备忘提示(note)，旧条目转成 note（payload 里的 date/advance_days/repeat_yearly 保留）
  try {
    db.exec("UPDATE entries SET type = 'note' WHERE type = 'important_date'");
  } catch { /* 表不存在等情况忽略 */ }
  // 提醒群发支持：条目记录创建时的群（source_group），到点提醒发回该群并 @ 创建者
  try {
    db.exec('ALTER TABLE entries ADD COLUMN source_group TEXT');
  } catch { /* 已存在 */ }
  return db;
}

export function getDb() {
  return initDb();
}
