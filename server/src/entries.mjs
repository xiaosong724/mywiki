import { randomUUID } from 'node:crypto';
import { getDb } from './db.mjs';
import { getType, computeRemindAt } from './types.mjs';
import { nowLocalISO, toLocalISO, addDays } from './time.mjs';
import { getIdentity } from './identities.mjs';

const db = () => getDb();

function rowToEntry(r) {
  if (!r) return null;
  let payload = {};
  try { payload = JSON.parse(r.payload || '{}'); } catch { payload = {}; }
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    content: r.content,
    payload,
    tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
    location: r.location || null,
    owner: r.owner || null,
    isPrivate: !!r.is_private,
    sourceGroup: r.source_group || null,
    remindAt: r.remind_at || null,
    recurrence: r.recurrence,
    notifiedAt: r.notified_at || null,
    done: !!r.done,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function logEvent(actor, action, entryId, summary) {
  db().prepare(
    'INSERT INTO event_log (ts, actor, action, entry_id, summary) VALUES (?,?,?,?,?)'
  ).run(nowLocalISO(), actor, action, entryId || null, summary || '');
}

export function listEntries({ type, q, tags, done, owner, visibility, kind, limit = 100, offset = 0 } = {}) {
  const conds = [];
  const args = [];
  if (type) { conds.push('type = ?'); args.push(type); }
  if (kind) { conds.push("json_extract(payload, '$.kind') = ?"); args.push(String(kind)); }
  if (owner) { conds.push('owner = ?'); args.push(String(owner)); }
  if (visibility === 'public') conds.push('is_private = 0');
  if (visibility === 'own') {
    conds.push('(is_private = 0 OR owner = ?)');
    args.push(owner || '');
  }
  if (done !== undefined && done !== null && done !== '') { conds.push('done = ?'); args.push(done ? 1 : 0); }
  if (tags) {
    const tagList = String(tags).split(',').filter(Boolean);
    for (const t of tagList) { conds.push("instr(',' || tags || ',', ?)"); args.push(`,` + t + `,`); }
  }
  if (q) {
    // 中文短词检索用 LIKE；多关键词自动拆分，每个词都要命中（AND）
    const tokens = String(q).trim().split(/\s+|[,，、]/).filter(Boolean);
    const orClause = '(title LIKE ? OR content LIKE ? OR tags LIKE ? OR coalesce(location,\'\') LIKE ? OR payload LIKE ?)';
    for (const t of tokens) {
      conds.push(orClause);
      args.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`);
    }
  }
  let sql = 'SELECT * FROM entries';
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  args.push(Number(limit), Number(offset));
  return db().prepare(sql).all(...args).map(rowToEntry);
}

export function searchEntries(q, limit = 8, owner) {
  return listEntries({ q, limit, owner, visibility: 'public' });
}

export function getEntry(id) {
  return rowToEntry(db().prepare('SELECT * FROM entries WHERE id = ?').get(id));
}

// 按类型+标题查同名条目（用于创建前的重复判断；模糊匹配标题包含）
export function getByTitle(type, title, { fuzzy = true } = {}) {
  const t = String(title || '').trim();
  if (!t) return [];
  if (fuzzy && t.length >= 2) {
    return db().prepare(
      'SELECT * FROM entries WHERE type = ? AND (title = ? OR title LIKE ?) ORDER BY created_at ASC'
    ).all(String(type), t, `%${t}%`).map(rowToEntry);
  }
  return db().prepare('SELECT * FROM entries WHERE type = ? AND title = ? ORDER BY created_at ASC')
    .all(String(type), t).map(rowToEntry);
}

export function resolveEntryId(shortId) {
  if (!shortId) return null;
  const s = String(shortId).trim();
  if (s.length >= 8) {
    const r = db().prepare('SELECT * FROM entries WHERE id = ?').get(s);
    if (r) return r.id;
  }
  const r = db().prepare('SELECT * FROM entries WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1').get(`${s}%`);
  return r ? r.id : null;
}

function validatePayload(typeKey, payload, allowPartial) {
  const t = getType(typeKey);
  if (!t) throw new Error(`未知类型: ${typeKey}`);
  const allowed = new Set(t.fields.map((f) => f.key));
  const clean = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (!allowed.has(k)) continue;
    clean[k] = v;
  }
  if (!allowPartial) {
    for (const f of t.fields) {
      if ((f.kind === 'date' || f.kind === 'monthday') && f.key !== 'advance_days' && !clean[f.key] && t.reminder) {
        // 提醒类类型允许暂时不填日期（先记着，后续补）
      }
    }
  }
  return clean;
}

export function createEntry({ type, title, content = '', payload = {}, tags = [], location = null, owner = null, isPrivate, remindAt, recurrence, actor = 'web', id, sourceGroup = null }) {
  const t = getType(type);
  if (!t) throw new Error(`未知类型: ${type}`);
  if (!title || !String(title).trim()) throw new Error('标题不能为空');
  const cleanPayload = validatePayload(type, payload, true);
  const priv = isPrivate !== undefined ? !!isPrivate : type === 'account';
  const entryId = id || randomUUID();
  const now = nowLocalISO();
  const computed = remindAt ? { remindAt, recurrence: recurrence || 'none' } : computeRemindAt(type, cleanPayload);
  db().prepare(
    `INSERT INTO entries (id, type, title, content, payload, tags, location, owner, is_private, source_group, remind_at, recurrence, done, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`
  ).run(
    entryId, type, String(title).trim(), String(content || ''),
    JSON.stringify(cleanPayload), (tags || []).join(','),
    location || null, owner || null, priv ? 1 : 0, sourceGroup || null,
    computed.remindAt, computed.recurrence, now, now
  );
  logEvent(actor, 'create', id, `${type} / ${title}`);
  return getEntry(entryId);
}

export function updateEntry(id, patch = {}, actor = 'web') {
  const cur = getEntry(id);
  if (!cur) throw new Error('条目不存在');
  const t = getType(cur.type);
  const nextPayload = { ...cur.payload, ...validatePayload(cur.type, patch.payload || {}, true) };
  if (patch.payload && patch.payload.__clear) {
    for (const k of Object.keys(nextPayload)) {
      if (patch.payload.__clear.includes(k)) delete nextPayload[k];
    }
  }
  const title = patch.title !== undefined ? String(patch.title).trim() : cur.title;
  if (!title) throw new Error('标题不能为空');
  const content = patch.content !== undefined ? String(patch.content) : cur.content;
  const tags = patch.tags !== undefined ? (Array.isArray(patch.tags) ? patch.tags : []) : cur.tags;
  const location = patch.location !== undefined ? patch.location : cur.location;
  const owner = patch.owner !== undefined ? patch.owner : cur.owner;
  const isPrivate = patch.isPrivate !== undefined ? !!patch.isPrivate : cur.isPrivate;
  let remindAt = cur.remindAt;
  let recurrence = cur.recurrence;
  if (patch.recomputeRemind !== false && t.reminder) {
    const computed = computeRemindAt(cur.type, nextPayload);
    remindAt = computed.remindAt;
    recurrence = computed.recurrence;
  }
  const now = nowLocalISO();
  db().prepare(
    `UPDATE entries SET title=?, content=?, payload=?, tags=?, location=?, owner=?, is_private=?, remind_at=?, recurrence=?, updated_at=? WHERE id=?`
  ).run(title, content, JSON.stringify(nextPayload), tags.join(','), location, owner, isPrivate ? 1 : 0, remindAt, recurrence, now, id);
  logEvent(actor, 'update', id, `${cur.type} / ${title}`);
  return getEntry(id);
}

export function deleteEntry(id, actor = 'web') {
  const cur = getEntry(id);
  if (!cur) throw new Error('条目不存在');
  db().prepare('DELETE FROM entries WHERE id = ?').run(id);
  logEvent(actor, 'delete', id, `${cur.type} / ${cur.title}`);
  return cur;
}

// ---- 提醒 ----

export function getDueNow() {
  const now = nowLocalISO();
  return db().prepare(
    `SELECT * FROM entries
     WHERE remind_at IS NOT NULL AND remind_at <= ? AND done = 0
       AND (notified_at IS NULL OR notified_at < remind_at)
     ORDER BY remind_at ASC`
  ).all(now).map(rowToEntry);
}

export function getUpcoming(days = 7, limit = 50) {
  const until = toLocalISO(addDays(new Date(), days));
  return db().prepare(
    `SELECT * FROM entries
     WHERE remind_at IS NOT NULL AND remind_at >= ? AND remind_at <= ? AND done = 0
     ORDER BY remind_at ASC LIMIT ?`
  ).all(nowLocalISO(), until, Number(limit)).map(rowToEntry);
}

export function markNotified(id, ts = nowLocalISO()) {
  db().prepare('UPDATE entries SET notified_at = ? WHERE id = ?').run(ts, id);
}

export function markDone(id) {
  db().prepare('UPDATE entries SET done = 1, updated_at = ? WHERE id = ?').run(nowLocalISO(), id);
}

export function advanceNext(id) {
  const cur = getEntry(id);
  if (!cur) return;
  const computed = computeRemindAt(cur.type, cur.payload);
  db().prepare('UPDATE entries SET remind_at = ?, updated_at = ? WHERE id = ?').run(computed.remindAt, nowLocalISO(), id);
}

export function recentLogs(limit = 20) {
  return db().prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT ?').all(Number(limit));
}

// ---- 展示辅助 ----

export function maskEntry(entry, { revealSecrets = false } = {}) {
  if (!entry) return entry;
  const t = getType(entry.type);
  const masked = { ...entry, payload: { ...entry.payload } };
  if (t?.secretFields && !revealSecrets) {
    for (const f of t.secretFields) {
      if (masked.payload[f]) masked.payload[f] = '******';
    }
  }
  return masked;
}

export function entrySummary(e) {
  const parts = [`[${getType(e.type)?.label || e.type}] ${e.title}`];
  if (e.isPrivate) parts.push('🔒');
  if (e.type === 'minecraft_mod') parts.push(`提供：${e.owner || '系统'}`);
  else if (e.owner) parts.push(`归属：${e.owner}`);
  if (e.location) parts.push(`位置：${e.location}`);
  if (e.payload?.expire_date) parts.push(`过期：${e.payload.expire_date}`);
  if (e.payload?.birth_date) parts.push(`生日：${e.payload.birth_date}`);
  if (e.remindAt) parts.push(`提醒：${e.remindAt.replace('T', ' ')}`);
  if (e.content) {
    const c = e.content.replace(/\s+/g, ' ');
    parts.push(c.length > 40 ? c.slice(0, 40) + '…' : c);
  }
  return parts.join(' · ');
}

// ---- 可见性 / 权限 ----

// 根据消息上下文决定可见范围：群=仅公开；私聊=公开+本人私密
export function ctxVisibility(ctx) {
  const name = getIdentity(String(ctx.user_id))?.name || null;
  if (ctx.message_type === 'group') return { visibility: 'public' };
  return { visibility: 'own', ownerName: name };
}

export function canAccessEntry(e, ctx) {
  if (!e.isPrivate) return true;
  if (ctx.message_type === 'group') return false;
  const name = getIdentity(String(ctx.user_id))?.name || null;
  return !!e.owner && !!name && e.owner === name;
}

export function getEntryVisible(id, ctx) {
  const e = getEntry(id);
  if (!e) return null;
  return canAccessEntry(e, ctx) ? e : null;
}
