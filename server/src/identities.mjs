import { getDb } from './db.mjs';
import { nowLocalISO } from './time.mjs';

export function registerIdentity(qqId, name, actor = 'bot') {
  const qq = String(qqId || '').trim();
  const n = String(name || '').trim();
  if (!qq || !n) throw new Error('QQ 号和名字都不能为空');
  if (n.length > 20) throw new Error('名字太长了');
  const now = nowLocalISO();
  const exist = getDb().prepare('SELECT * FROM identities WHERE qq_id = ?').get(qq);
  if (exist) {
    getDb().prepare('UPDATE identities SET name = ?, updated_at = ? WHERE qq_id = ?').run(n, now, qq);
  } else {
    getDb().prepare('INSERT INTO identities (qq_id, name, created_at, updated_at) VALUES (?,?,?,?)').run(qq, n, now, now);
  }
  return { qq_id: qq, name: n };
}

export function getIdentity(qqId) {
  const r = getDb().prepare('SELECT * FROM identities WHERE qq_id = ?').get(String(qqId || ''));
  return r ? { qq_id: r.qq_id, name: r.name } : null;
}

// 按名字反查 QQ（用于提醒群发时 @ 创建者）
export function getQqByName(name) {
  const r = getDb().prepare('SELECT qq_id FROM identities WHERE name = ? LIMIT 1').get(String(name || '').trim());
  return r ? String(r.qq_id) : null;
}

export function listIdentities() {
  return getDb()
    .prepare('SELECT qq_id, name FROM identities ORDER BY created_at ASC')
    .all()
    .map((r) => ({ qq_id: r.qq_id, name: r.name }));
}
