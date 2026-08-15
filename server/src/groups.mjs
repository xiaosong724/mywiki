import { getDb } from './db.mjs';
import { nowLocalISO } from './time.mjs';
import { TYPES } from './types.mjs';

const db = () => getDb();

function parseRules(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function rowToConfig(r) {
  if (!r) return null;
  return {
    groupId: r.group_id,
    name: r.name,
    enabled: !!r.enabled,
    typeRules: parseRules(r.type_rules),
    memberPrivateChat: !!r.member_private_chat,
    defaultMemberRules: parseRules(r.default_member_rules),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listGroupConfigs() {
  return db().prepare('SELECT * FROM group_configs ORDER BY updated_at DESC').all().map(rowToConfig);
}

export function getGroupConfig(groupId) {
  const gid = String(groupId || '');
  if (!gid) return null;
  return rowToConfig(db().prepare('SELECT * FROM group_configs WHERE group_id = ?').get(gid));
}

export function saveGroupConfig({ groupId, name = '', enabled = true, typeRules = {}, memberPrivateChat = true, defaultMemberRules = {} }) {
  const gid = String(groupId || '').trim();
  if (!gid) throw new Error('群号不能为空');
  const now = nowLocalISO();
  const clean = {};
  for (const key of Object.keys(TYPES)) {
    const r = typeRules[key] || {};
    const mode = ['off', 'free', 'prefix'].includes(r.mode) ? r.mode : 'off';
    const prefix = mode === 'prefix' ? String(r.prefix || '').trim().replace(/^\/+/, '') : '';
    clean[key] = { mode, prefix };
  }
  const cleanDefaults = {};
  for (const key of Object.keys(TYPES)) {
    if (clean[key]?.mode === 'off') {
      cleanDefaults[key] = { create: false, read: false, update: false, delete: false };
    } else {
      const r = defaultMemberRules[key];
      cleanDefaults[key] = r
        ? { create: !!r.create, read: r.read !== false, update: !!r.update, delete: !!r.delete }
        : { create: true, read: true, update: true, delete: true };
    }
  }
  const existing = getGroupConfig(gid);
  if (existing) {
    db().prepare(
      'UPDATE group_configs SET name=?, enabled=?, type_rules=?, member_private_chat=?, default_member_rules=?, updated_at=? WHERE group_id=?'
    ).run(String(name || ''), enabled ? 1 : 0, JSON.stringify(clean), memberPrivateChat ? 1 : 0, JSON.stringify(cleanDefaults), now, gid);
  } else {
    db().prepare(
      'INSERT INTO group_configs (group_id, name, enabled, type_rules, member_private_chat, default_member_rules, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(gid, String(name || ''), enabled ? 1 : 0, JSON.stringify(clean), memberPrivateChat ? 1 : 0, JSON.stringify(cleanDefaults), now, now);
  }
  return getGroupConfig(gid);
}

export function deleteGroupConfig(groupId) {
  const gid = String(groupId || '');
  const r = db().prepare('DELETE FROM group_configs WHERE group_id = ?').run(gid);
  return { deleted: gid, changed: r.changes };
}

function normalizePrefix(p) {
  return String(p || '').trim().replace(/^\/+/, '');
}

// 判断非命令消息能否在群里触发，返回 null 表示不允许，或 { allowedTypes, mode, query }
export function matchGroupTrigger(cfg, text) {
  if (!cfg || !cfg.enabled) return null;
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('/')) return null;

  const prefixTypes = [];
  for (const [type, rule] of Object.entries(cfg.typeRules || {})) {
    if (rule?.mode === 'prefix') {
      const p = normalizePrefix(rule.prefix);
      if (p && (raw === p || raw.startsWith(p + ' ') || raw.startsWith(p + '　'))) {
        prefixTypes.push(type);
      }
    }
  }
  if (prefixTypes.length) {
    // 去掉最长的匹配前缀，保留问题正文
    let stripped = raw;
    for (const type of prefixTypes) {
      const p = normalizePrefix(cfg.typeRules[type]?.prefix);
      if (raw.startsWith(p + ' ')) {
        stripped = raw.slice(p.length).trim();
        break;
      }
      if (raw.startsWith(p + '　')) {
        stripped = raw.slice(p.length).trim();
        break;
      }
    }
    return { allowedTypes: prefixTypes, mode: 'prefix', query: stripped };
  }

  const freeTypes = Object.entries(cfg.typeRules || {})
    .filter(([, rule]) => rule?.mode === 'free')
    .map(([type]) => type);
  if (freeTypes.length) {
    return { allowedTypes: freeTypes, mode: 'free', query: raw };
  }
  return null;
}

export function groupHelpText(cfg) {
  if (!cfg) return '';
  const lines = ['本群只开启了以下类型：'];
  let hasPrefix = false;
  for (const [type, rule] of Object.entries(cfg.typeRules || {})) {
    if (rule?.mode === 'free') lines.push(`· ${TYPES[type]?.label || type}：直接问即可`);
    if (rule?.mode === 'prefix') {
      hasPrefix = true;
      lines.push(`· ${TYPES[type]?.label || type}：发「${rule.prefix || 'wiki'} 问题」触发`);
    }
  }
  if (hasPrefix) lines.push('需要前缀的类型，必须带前缀才会回答。');
  return lines.join('\n');
}

export function isTypeAllowed(policy, typeKey) {
  if (!policy || !policy.allowedTypes) return true;
  return policy.allowedTypes.includes(typeKey);
}

// 确认消息（两位确认码 / 确认创建/删除/修改/改名 XX）在受限群里也必须放行，
// 否则 prefix 模式下用户回复确认码会被触发规则静默忽略，确认永远无法执行
export function looksLikeConfirmation(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/^(确认|确认创建|确认删除|确认修改|确认改名|确认记录|confirm)/i.test(s)) return true;
  if (/^\d{2}$/.test(s)) return true;
  return false;
}
