import { getDb } from './db.mjs';
import { nowLocalISO } from './time.mjs';
import { TYPES } from './types.mjs';
import { getGroupConfig } from './groups.mjs';
import config from './config.mjs';

const db = () => getDb();

function parseRules(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function rowToPerm(r) {
  if (!r) return null;
  return {
    qqId: r.qq_id,
    groupId: r.group_id,
    rules: parseRules(r.rules),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listMemberPermissions() {
  return db().prepare('SELECT * FROM member_permissions ORDER BY group_id, updated_at DESC').all().map(rowToPerm);
}

export function getMemberPermissions(qqId, groupId) {
  return rowToPerm(db().prepare('SELECT * FROM member_permissions WHERE qq_id = ? AND group_id = ?').get(String(qqId), String(groupId)));
}

export function saveMemberPermissions({ qqId, groupId, rules = {} }) {
  const qq = String(qqId || '').trim();
  const gid = String(groupId || '').trim();
  if (!qq) throw new Error('QQ 号不能为空');
  if (!gid) throw new Error('群号不能为空');
  const clean = {};
  const existing = getMemberPermissions(qq, gid);
  for (const key of Object.keys(TYPES)) {
    const r = rules[key];
    if (r) {
      clean[key] = {
        create: !!r.create,
        read: r.read !== false,
        update: !!r.update,
        delete: !!r.delete,
      };
    } else if (existing?.rules?.[key]) {
      // 未提交的类型（如该类型已在群里关闭、表单不再显示）：保留原规则，避免被默认值覆盖
      clean[key] = { ...existing.rules[key] };
    } else {
      clean[key] = { create: false, read: true, update: false, delete: false };
    }
  }
  const now = nowLocalISO();
  db().prepare(
    'INSERT INTO member_permissions (qq_id, group_id, rules, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(qq_id, group_id) DO UPDATE SET rules=excluded.rules, updated_at=excluded.updated_at'
  ).run(qq, gid, JSON.stringify(clean), now, now);
  return getMemberPermissions(qq, gid);
}

export function deleteMemberPermissions(qqId, groupId) {
  const r = db().prepare('DELETE FROM member_permissions WHERE qq_id = ? AND group_id = ?').run(String(qqId), String(groupId));
  return { deleted: { qqId: String(qqId), groupId: String(groupId) }, changed: r.changes };
}

// 默认：未配置该成员/群时返回 true（保持原有全量权限）；配置后严格按规则
export function memberCan(qqId, groupId, typeKey, action) {
  const qq = String(qqId || '');
  const gid = String(groupId || '');
  if (!qq || !gid) return true;
  const p = getMemberPermissions(qq, gid);
  if (p) return !!p.rules?.[typeKey]?.[action];
  const cfg = getGroupConfig(gid);
  if (cfg?.defaultMemberRules?.[typeKey]) {
    return !!cfg.defaultMemberRules[typeKey][action];
  }
  return true;
}

// 管理操作（改分类名等全局影响的操作）鉴权：
// 优先用 config.bot.adminQqIds 白名单；为空时回退到 notify.qqUserId（配置者本人）
export function isAdminUser(qqId) {
  const qq = String(qqId || '').trim();
  if (!qq) return false;
  const list = config.bot?.adminQqIds;
  if (Array.isArray(list) && list.length) return list.map(String).includes(qq);
  return String(config.notify?.qqUserId || '').trim() === qq;
}
