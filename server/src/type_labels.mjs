import { getDb } from './db.mjs';
import { nowLocalISO } from './time.mjs';
import { TYPES } from './types.mjs';

const db = () => getDb();

export function listTypeLabelOverrides() {
  return db().prepare('SELECT type_key, label, updated_at FROM type_label_overrides ORDER BY type_key').all();
}

export function saveTypeLabel(typeKey, label) {
  const key = String(typeKey || '');
  const text = String(label || '').trim();
  if (!TYPES[key]) throw new Error(`未知类型: ${key}`);
  if (!text) throw new Error('名称不能为空');
  const now = nowLocalISO();
  db().prepare(
    'INSERT INTO type_label_overrides (type_key, label, updated_at) VALUES (?,?,?) ON CONFLICT(type_key) DO UPDATE SET label=excluded.label, updated_at=excluded.updated_at'
  ).run(key, text, now);
  return { typeKey: key, label: text };
}

export function deleteTypeLabel(typeKey) {
  const key = String(typeKey || '');
  const r = db().prepare('DELETE FROM type_label_overrides WHERE type_key = ?').run(key);
  return { deleted: key, changed: r.changes };
}
