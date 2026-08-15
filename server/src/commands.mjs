import { TYPES, getType, resolveType, resolveTypeLoose } from './types.mjs';
import {
  getEntry, resolveEntryId, createEntry, updateEntry, deleteEntry,
  maskEntry, entrySummary, getUpcoming, getDueNow,
  listEntries, ctxVisibility, getEntryVisible, canAccessEntry,
} from './entries.mjs';
import { parseDateInput, toLocalDateStr } from './time.mjs';
import { registerIdentity, listIdentities, getIdentity } from './identities.mjs';
import { clearHistory, consumePendingOp } from './ai.mjs';
import { isTypeAllowed } from './groups.mjs';
import { saveTypeLabel } from './type_labels.mjs';
import { memberCan, getMemberPermissions, listMemberPermissions, isAdminUser } from './permissions.mjs';

// 待确认删除：user_id -> Map<entry_id, { groupId, messageType }>
// 记录发起时的会话场景，确认时必须同场景，防止跨群/私聊绕过权限
export const pendingDeletes = new Map();

const FIELD_ALIASES = {
  '位置': 'location', '备注': 'content', '内容': 'content', '标签': 'tags',
  '过期': 'expire_date', '日期': 'date', '时间': 'time', '生日': 'birth_date',
  '数量': 'quantity', '平台': 'platform', '账号': 'username', '密码': 'password',
  '版本': 'mod_version', '功能': 'features', '配置': 'config_path', '分类': 'category',
  '姓名': 'name', '关系': 'relation', '地点': 'place', '同行': 'companions',
  '提前': 'advance_days', '每年': 'repeat_yearly',
  '农历': 'lunar', '年份': 'birth_year',
};

export const HELP = [
  '可用命令：',
  '/记 类型 标题 字段=值…（如 /记 食物 牛奶 过期=明天）',
  '/查 关键词   /详情 条目id',
  '/改 id 字段=值…   /删 id   /确认删 id',
  '/提醒 [N天]   /过期   /今天',
  '/密码 id（查看账号密码）',
  '类型：模组/知识/账号/琐事/食物/位置/生日/旅行',
  '/我是 名字（登记/更换身份）  /身份（查看已登记）',
  '/权限（查看你在本群的详细权限）',
  '/分类名 类型 新名称（例如 /分类名 模组 修仙模组）',
  '不确定的也可以直接发自然语言（需配置 DeepSeek）',
].join('\n');

function shortId(id) {
  return id ? id.slice(0, 8) : '';
}

function groupHelpText(cfg) {
  const lines = ['本群可用：'];
  let any = false;
  for (const [type, rule] of Object.entries(cfg.typeRules || {})) {
    const t = getType(type);
    if (rule?.mode === 'free') {
      any = true;
      lines.push(`${t?.icon || ''} ${t?.label || type}：直接问`);
    } else if (rule?.mode === 'prefix') {
      any = true;
      lines.push(`${t?.icon || ''} ${t?.label || type}：发「${rule.prefix || 'wiki'} 问题」触发`);
    }
  }
  if (!any) lines.push('（本群没有开启任何类型）');
  lines.push('常用命令：/帮助 /我是 /身份 /清空');
  lines.push('查看权限：/权限');
  lines.push('管理命令：/分类名 类型 新名称');
  lines.push('内容命令：/记 /查 /详情 /改 /删 /提醒 /过期 /今天 /密码（仅私聊）');
  return lines.join('\n');
}

function resolveBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim();
  return s === '是' || s === '1' || s === 'true' || s === '每年' || s === 'yes';
}

function normalizeFieldValue(kind, value) {
  const s = String(value).trim();
  if (kind === 'bool') return resolveBool(s);
  if (kind === 'number') {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (kind === 'date') {
    const d = parseDateInput(s);
    return d ? toLocalDateStr(d) : s;
  }
  if (kind === 'monthday') {
    const m = s.match(/^(\d{1,2})月(\d{1,2})日$/);
    if (m) return `${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    const m2 = s.match(/^(\d{1,2})-(\d{1,2})$/);
    if (m2) return `${String(Number(m2[1])).padStart(2, '0')}-${String(Number(m2[2])).padStart(2, '0')}`;
    return s;
  }
  return s;
}

function parseKvTokens(tokens, typeKey) {
  const t = getType(typeKey);
  const fieldMap = {};
  for (const f of (t?.fields || [])) fieldMap[f.key] = f;
  const out = { payload: {}, location: undefined, tags: [], content: undefined, isPrivate: undefined };
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const rawKey = tok.slice(0, eq).trim();
    const rawVal = tok.slice(eq + 1).trim();
    if (!rawKey || !rawVal) continue;
    let key = FIELD_ALIASES[rawKey] || rawKey;
    const field = fieldMap[key];
    const val = field ? normalizeFieldValue(field.kind, rawVal) : rawVal;
    if (key === '私密' || rawKey === '私密') out.isPrivate = resolveBool(rawVal);
    else if (key === 'location') out.location = rawVal;
    else if (key === 'tags') out.tags = rawVal.split(/[,，]/).filter(Boolean);
    else if (key === 'content') out.content = rawVal;
    else if (field) out.payload[key] = val;
    else out.payload[key] = val;
  }
  return out;
}

function fmtList(entries, limit = 5) {
  if (!entries.length) return '没找到。';
  const lines = entries.slice(0, limit).map((e) => {
    const m = maskEntry(e);
    return `#${shortId(m.id)} ${entrySummary(m)}`;
  });
  if (entries.length > limit) lines.push(`…还有 ${entries.length - limit} 条`);
  return lines.join('\n');
}

export async function handleCommand(text, ctx = {}) {
  const parts = String(text).trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = parts.slice(1);
  const actor = `bot:${ctx.user_id || '?'}`;

  if (!cmd.startsWith('/')) return { handled: false };

  switch (cmd) {
    case '/帮助':
    case '/help':
    case '/?':
      if (ctx.groupCfg?.enabled) {
        return { handled: true, reply: groupHelpText(ctx.groupCfg) };
      }
      return { handled: true, reply: HELP };

    case '/记': {
      if (rest.length < 2) return { handled: true, reply: '格式：/记 类型 标题 字段=值…（如 /记 食物 牛奶 过期=明天）' };
      const typeKey = resolveType(rest[0]);
      if (!typeKey) return { handled: true, reply: `未知类型「${rest[0]}」，可用：${Object.keys(TYPES).join('/')}` };
      if (!isTypeAllowed(ctx.groupPolicy, typeKey)) {
        return { handled: true, reply: '这个群没有开启该类型的记录权限。' };
      }
      if (!memberCan(ctx.user_id, ctx.group_id, typeKey, 'create')) {
        return { handled: true, reply: '你在本群没有该类型的记录权限。' };
      }
      const title = rest[1];
      const kv = parseKvTokens(rest.slice(2), typeKey);
      const privDefault = typeKey === 'account';
      const wantPrivate = kv.isPrivate !== undefined ? kv.isPrivate : privDefault;
      if (ctx.message_type === 'group' && wantPrivate) {
        return { handled: true, reply: '账号/私密内容请私聊我记录，群里会拒绝。' };
      }
      try {
        const e = createEntry({
          type: typeKey, title, content: kv.content || '', payload: kv.payload,
          tags: kv.tags, location: kv.location, isPrivate: wantPrivate, actor,
          owner: getIdentity(ctx.user_id)?.name || null,
          sourceGroup: ctx.group_id ? String(ctx.group_id) : null,
        });
        const m = maskEntry(e);
        const remind = m.remindAt ? `\n⏰ ${m.remindAt.replace('T', ' ')}` : '';
        return { handled: true, reply: `已记录 #${shortId(e.id)}\n${entrySummary(m)}${remind}` };
      } catch (err) {
        return { handled: true, reply: `记录失败：${err.message}` };
      }
    }

    case '/查':
    case '/search': {
      const q = rest.join(' ');
      if (!q) return { handled: true, reply: '格式：/查 关键词' };
      const vis = ctxVisibility(ctx);
      // 权限关闭 = 完全隐形：过滤后没结果就只显示"没找到"，不透露存在被过滤的内容
      const list = listEntries({ q, limit: 20, visibility: vis.visibility })
        .filter((e) => isTypeAllowed(ctx.groupPolicy, e.type) && memberCan(ctx.user_id, ctx.group_id, e.type, 'read'))
        .slice(0, 8);
      return { handled: true, reply: `「${q}」结果：\n` + fmtList(list) };
    }

    case '/详情':
    case '/detail': {
      if (!rest[0]) return { handled: true, reply: '格式：/详情 id' };
      const id = resolveEntryId(rest[0]);
      const e = id ? getEntryVisible(id, ctx) : null;
      if (!e) return { handled: true, reply: '没找到该条目。' };
      // 权限关闭 = 完全隐形
      if (!isTypeAllowed(ctx.groupPolicy, e.type)) return { handled: true, reply: '没找到该条目。' };
      if (!memberCan(ctx.user_id, ctx.group_id, e.type, 'read')) return { handled: true, reply: '没找到该条目。' };
      const m = maskEntry(e);
      const lines = [`#${shortId(m.id)} [${getType(m.type)?.label || m.type}] ${m.title}`];
      if (m.type === 'minecraft_mod') lines.push(`提供：${m.owner || '系统'}`);
      for (const [k, v] of Object.entries(m.payload)) {
        if (v !== undefined && v !== null && v !== '') lines.push(`${k}：${v}`);
      }
      if (m.content) lines.push(`内容：${m.content}`);
      if (m.location) lines.push(`位置：${m.location}`);
      if (m.tags.length) lines.push(`标签：${m.tags.join(',')}`);
      if (m.remindAt) lines.push(`提醒：${m.remindAt.replace('T', ' ')}（${m.recurrence === 'yearly' ? '每年' : '一次'}）`);
      lines.push(m.done ? '状态：已完成' : '状态：进行中');
      return { handled: true, reply: lines.join('\n') };
    }

    case '/改':
    case '/update': {
      if (rest.length < 2) return { handled: true, reply: '格式：/改 id 字段=值…' };
      const id = resolveEntryId(rest[0]);
      if (!id) return { handled: true, reply: '没找到该条目。' };
      const cur = getEntry(id);
      if (!canAccessEntry(cur, ctx)) return { handled: true, reply: '没有找到该条目。' };
      if (!isTypeAllowed(ctx.groupPolicy, cur.type)) return { handled: true, reply: '这个群没有开启该类型的修改权限。' };
      if (!memberCan(ctx.user_id, ctx.group_id, cur.type, 'update')) return { handled: true, reply: '你在本群没有该类型的修改权限。' };
      const kv = parseKvTokens(rest.slice(1), cur.type);
      try {
        const e = updateEntry(id, {
          payload: kv.payload, content: kv.content, tags: kv.tags, location: kv.location,
          isPrivate: kv.isPrivate, actor,
        }, actor);
        return { handled: true, reply: `已更新 #${shortId(id)}\n${entrySummary(maskEntry(e))}` };
      } catch (err) {
        return { handled: true, reply: `更新失败：${err.message}` };
      }
    }

    case '/删':
    case '/delete': {
      if (!rest[0]) return { handled: true, reply: '格式：/删 id' };
      const id = resolveEntryId(rest[0]);
      if (!id) return { handled: true, reply: '没找到该条目。' };
      const cur = getEntry(id);
      if (!canAccessEntry(cur, ctx)) return { handled: true, reply: '没有找到该条目。' };
      if (!isTypeAllowed(ctx.groupPolicy, cur.type)) return { handled: true, reply: '这个群没有开启该类型的删除权限。' };
      if (!memberCan(ctx.user_id, ctx.group_id, cur.type, 'delete')) return { handled: true, reply: '你在本群没有该类型的删除权限。' };
      if (!pendingDeletes.has(ctx.user_id)) pendingDeletes.set(ctx.user_id, new Map());
      pendingDeletes.get(ctx.user_id).set(id, {
        groupId: String(ctx.group_id || ''),
        messageType: ctx.message_type || 'private',
      });
      return { handled: true, reply: `确认删除 #${shortId(id)}「${getEntry(id).title}」？\n回复 /确认删 ${shortId(id)} 执行` };
    }

    case '/确认删':
    case '/confirm': {
      if (!rest[0]) return { handled: true, reply: '格式：/确认删 id' };
      const id = resolveEntryId(rest[0]);
      const pending = pendingDeletes.get(ctx.user_id);
      const rec = id && pending?.get(id);
      if (rec) {
        // 必须回到发起删除时的同群/同场景确认，防止跨群绕过权限
        if (String(rec.groupId) !== String(ctx.group_id || '') || (rec.messageType || 'private') !== (ctx.message_type || 'private')) {
          return { handled: true, reply: '该删除请求来自其他会话，请回到原群/原场景再确认。' };
        }
        // 确认时复查权限（期间权限可能变化）
        const cur = getEntry(id);
        if (!cur) {
          pending.delete(id);
          return { handled: true, reply: '条目不存在或已被删除。' };
        }
        if (!canAccessEntry(cur, ctx)) return { handled: true, reply: '没有找到该条目。' };
        if (!isTypeAllowed(ctx.groupPolicy, cur.type)) return { handled: true, reply: '这个群没有开启该类型的删除权限。' };
        if (!memberCan(ctx.user_id, ctx.group_id, cur.type, 'delete')) return { handled: true, reply: '你在本群没有该类型的删除权限。' };
        pending.delete(id);
        deleteEntry(id, actor);
        return { handled: true, reply: `已删除 #${shortId(id)}。` };
      }
      // AI 通用确认码兜底
      const out = consumePendingOp(ctx.user_id, rest[0]);
      if (out) {
        return { handled: true, reply: out };
      }
      return { handled: true, reply: '没有待确认的删除，先 /删 id 或让 AI 发起删除再确认。' };
    }

    case '/提醒':
    case '/remind': {
      const days = rest[0] ? Number(rest[0].replace(/[天日]/g, '')) : 7;
      const list = getUpcoming(Number.isFinite(days) ? days : 7, 20).filter((e) => isTypeAllowed(ctx.groupPolicy, e.type) && memberCan(ctx.user_id, ctx.group_id, e.type, 'read')).slice(0, 8);
      if (!list.length) return { handled: true, reply: '接下来没有待提醒事项。' };
      return { handled: true, reply: `未来 ${Number.isFinite(days) ? days : 7} 天提醒：\n` + fmtList(list) };
    }

    case '/过期':
    case '/expired': {
      const due = getDueNow().filter((e) => e.type === 'food_expiry' && isTypeAllowed(ctx.groupPolicy, e.type) && memberCan(ctx.user_id, ctx.group_id, e.type, 'read'));
      if (!due.length) return { handled: true, reply: '没有已过期的食品。' };
      return { handled: true, reply: '已过期/到期食品：\n' + fmtList(due) };
    }

    case '/今天':
    case '/today': {
      const due = getDueNow();
      const todayStr = toLocalDateStr(new Date());
      const today = due.filter((e) => e.remindAt.slice(0, 10) === todayStr && isTypeAllowed(ctx.groupPolicy, e.type) && memberCan(ctx.user_id, ctx.group_id, e.type, 'read'));
      if (!today.length) return { handled: true, reply: '今天暂无到期提醒。' };
      return { handled: true, reply: '今天到期：\n' + fmtList(today) };
    }

    case '/密码':
    case '/password': {
      if (ctx.message_type === 'group') return { handled: true, reply: '密码请在私聊里查看。' };
      if (!rest[0]) return { handled: true, reply: '格式：/密码 id' };
      const id = resolveEntryId(rest[0]);
      const e = id ? getEntryVisible(id, ctx) : null;
      if (!e) return { handled: true, reply: '没找到该条目。' };
      if (e.type !== 'account' || !e.payload?.password) return { handled: true, reply: '该条目没有密码字段。' };
      return { handled: true, reply: `${e.title}：账号 ${e.payload.username || '?'}，密码 ${e.payload.password}` };
    }

    case '/我是':
    case '/register': {
      if (!rest[0]) return { handled: true, reply: '格式：/我是 你的名字' };
      try {
        const r = registerIdentity(ctx.user_id, rest[0]);
        return { handled: true, reply: `已登记：QQ ${r.qq_id} = ${r.name}。之后说「我的」就会按这个身份来找。` };
      } catch (err) {
        return { handled: true, reply: `登记失败：${err.message}` };
      }
    }

    case '/身份':
    case '/who': {
      const list = listIdentities();
      if (!list.length) return { handled: true, reply: '还没有人登记身份。发 /我是 名字 即可登记。' };
      return { handled: true, reply: '已登记身份：\n' + list.map((i) => `${i.name}（QQ ${i.qq_id}）`).join('\n') };
    }

    case '/分类名':
    case '/改名':
    case '/rename-type': {
      if (rest.length < 2) return { handled: true, reply: '格式：/分类名 类型 新名称（如 /分类名 模组 修仙模组）' };
      if (!isAdminUser(ctx.user_id)) {
        return { handled: true, reply: '改分类名是管理操作，仅管理员可用（config bot.adminQqIds；未配置时默认为你自己的 QQ）。' };
      }
      const newLabel = rest[rest.length - 1].trim();
      const typeName = rest.slice(0, -1).join(' ');
      const typeKey = resolveTypeLoose(typeName);
      if (!typeKey) return { handled: true, reply: `未知类型「${typeName}」，可用别名：模组/知识/账号/琐事/日期/食物/位置/生日/旅行` };
      if (!newLabel) return { handled: true, reply: '新名称不能为空。' };
      try {
        const old = getType(typeKey)?.label || typeKey;
        const r = saveTypeLabel(typeKey, newLabel);
        return { handled: true, reply: `已把「${old}」改名为「${r.label}」。` };
      } catch (err) {
        return { handled: true, reply: `改名失败：${err.message}` };
      }
    }

    case '/权限':
    case '/perm':
    case '/myperm': {
      if (ctx.message_type !== 'group') {
        const perms = listMemberPermissions().filter((p) => p.qqId === String(ctx.user_id));
        if (!perms.length) return { handled: true, reply: '你还没有单独的成员权限配置；私聊按身份和私密权限规则访问。' };
        return { handled: true, reply: '你的成员权限：\n' + perms.map((p) => {
          const flags = Object.entries(p.rules || {}).map(([k, r]) => {
            const t = getType(k);
            const s = [r.read ? '查' : '', r.create ? '增' : '', r.update ? '改' : '', r.delete ? '删' : ''].filter(Boolean).join('/');
            return `${t?.icon || ''}${t?.label || k}：${s || '无'}`;
          }).join('；');
          return `群 ${p.groupId}：${flags}`;
        }).join('\n') };
      }
      const entries = ctx.groupCfg?.enabled
        ? Object.entries(ctx.groupCfg.typeRules || {}).filter(([, r]) => r.mode !== 'off')
        : Object.entries(TYPES).map(([k]) => [k, { mode: 'free' }]);
      const lines = [`你在群 ${ctx.group_id} 的权限：`];
      let any = false;
      for (const [key] of entries) {
        const t = getType(key);
        const flags = [
          memberCan(ctx.user_id, ctx.group_id, key, 'read') ? '查' : '',
          memberCan(ctx.user_id, ctx.group_id, key, 'create') ? '增' : '',
          memberCan(ctx.user_id, ctx.group_id, key, 'update') ? '改' : '',
          memberCan(ctx.user_id, ctx.group_id, key, 'delete') ? '删' : '',
        ].filter(Boolean).join('/');
        any = true;
        lines.push(`${t?.icon || ''}${t?.label || key}：${flags || '无'}`);
      }
      if (!any) lines.push('本群没有开启任何类型。');
      return { handled: true, reply: lines.join('\n') };
    }

    case '/清空':
    case '/forget': {
      const key = `${ctx.message_type || 'private'}:${ctx.group_id || ctx.user_id || '?'}`;
      clearHistory(key);
      return { handled: true, reply: '已清空本会话的对话记忆。' };
    }

    default:
      return { handled: true, reply: `未知命令 ${cmd}，发 /帮助 查看可用命令。` };
  }
}
