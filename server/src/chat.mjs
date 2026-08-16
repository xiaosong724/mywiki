import { handleCommand, HELP } from './commands.mjs';
import { aiChat, aiConfigured, consumePendingOp, clearHistory } from './ai.mjs';
import { getIdentity } from './identities.mjs';
import {
  listGallery, countGallery, createGallery, updateGallery, deleteGallery,
} from './gallery.mjs';
import {
  appendKnowledgeRecord, editKnowledgeRecord, deleteKnowledgeRecord, knowledgeTypes,
} from './knowledge.mjs';
import { memberCan } from './permissions.mjs';
import { isTypeAllowed } from './groups.mjs';
import { readFileSync, existsSync } from 'node:fs';

// ===== 图库指令（前缀触发）：带图=上传；删 #id；改 #id 新介绍；无动词=查询 =====
async function handleGalleryMessage(text, images, ctx) {
  const t = String(text || '').trim();
  // 上传：消息带图片
  if (images?.length) {
    if (!isTypeAllowed(ctx.groupPolicy, 'gallery')) return '这个群没有开启图库。';
    if (!memberCan(ctx.user_id, ctx.group_id, 'gallery', 'create')) return '你在本群没有图库的上传权限。';
    const id = getIdentity(String(ctx.user_id));
    if (!id) return '上传图片必须绑定身份：先发 /我是 你的名字 登记。';
    const img = images[0];
    let buf = null;
    let mime = 'image/jpeg';
    if (img.url) {
      try {
        const res = await fetch(img.url, { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          buf = Buffer.from(await res.arrayBuffer());
          mime = res.headers.get('content-type') || mime;
        }
      } catch { /* 下载失败，尝试本地 file */ }
    }
    if (!buf && img.file && existsSync(img.file)) {
      buf = readFileSync(img.file);
    }
    if (!buf) return '图片下载失败，请重试或换一张图。';
    try {
      const g = createGallery({ owner: id.name, caption: t, data: buf, mime });
      return `📷 已保存图库 #${g.id.slice(0, 8)}（${id.name}）：${g.caption || '（无介绍）'}（${(g.size / 1024).toFixed(0)}KB）`;
    } catch (err) {
      return `保存失败：${err.message}`;
    }
  }
  if (!isTypeAllowed(ctx.groupPolicy, 'gallery')) return '这个群没有开启图库。';
  // 删：/图库 删 #id
  const delm = t.match(/^(删|删除)\s*#([0-9a-fA-F]{6,12})$/);
  if (delm) {
    if (!memberCan(ctx.user_id, ctx.group_id, 'gallery', 'delete')) return '你在本群没有图库的删除权限。';
    try {
      const r = deleteGallery(delm[2]);
      return `已删除图库 #${r.deleted.slice(0, 8)}`;
    } catch (err) { return err.message; }
  }
  // 改：/图库 改 #id 新介绍
  const editm = t.match(/^(改|修改)\s*#([0-9a-fA-F]{6,12})\s*(.*)$/);
  if (editm) {
    if (!memberCan(ctx.user_id, ctx.group_id, 'gallery', 'update')) return '你在本群没有图库的修改权限。';
    try {
      const g = updateGallery(editm[2], { caption: editm[3].trim() });
      return `已修改图库 #${g.id.slice(0, 8)} 介绍：${g.caption || '（空）'}`;
    } catch (err) { return err.message; }
  }
  // 查询：关键词匹配（绑定名称 或 文字介绍），最新在前，最多 5 张/页
  if (!memberCan(ctx.user_id, ctx.group_id, 'gallery', 'read')) return '你在本群没有图库的查看权限。';
  const parts = t.split(/\s+/);
  let page = 1;
  const last = Number(parts[parts.length - 1]);
  if (Number.isInteger(last) && parts.length > 1 && last >= 1) {
    page = last;
    parts.pop();
  }
  const keyword = parts.join(' ').trim();
  const offset = (page - 1) * 5;
  const list = listGallery({ q: keyword, offset, limit: 5 });
  if (!list.length) return keyword ? `图库没有匹配「${keyword}」的图片。` : '图库还没有图片。';
  const total = countGallery({ q: keyword });
  const hasMore = offset + list.length < total;
  const lines = list.map((g) => `[CQ:image,file=http://127.0.0.1:8000${g.url}]\n#${g.id.slice(0, 8)}（${g.owner}）：${g.caption || '（无介绍）'}`);
  if (hasMore) lines.push(`第 ${page} 页 · 共 ${total} 张 · 发「${keyword ? keyword + ' ' : ''}${page + 1}」看下一页`);
  else lines.push(`第 ${page} 页 · 共 ${total} 张`);
  return lines.join('\n');
}

// ===== 全量知识库指令（前缀触发）：增/删/改；无动词返回 undefined 走 AI 查询 =====
async function handleKnowledgeCommand(text, ctx, kbType) {
  const t = String(text || '').trim();
  const m = t.match(/^(增|加|新增|添加|删|删除|改|修改|编辑)\s+(.+)$/);
  if (!m) return undefined;
  const verb = m[1];
  const rest = m[2].trim();
  if (verb === '删' || verb === '删除') {
    const idm = rest.match(/^#([0-9a-fA-F]{6,12})$/);
    if (!idm) return '格式：/前缀 删 #id（记录的 8 位短 id）';
    if (!memberCan(ctx.user_id, ctx.group_id, kbType, 'delete')) return '你在本群没有该类型的删除权限。';
    try {
      const r = deleteKnowledgeRecord(kbType, idm[1]);
      return `已删除 #${r.id}「${r.title}」`;
    } catch (err) { return err.message; }
  }
  if (verb === '改' || verb === '修改' || verb === '编辑') {
    const idm = rest.match(/\s*#([0-9a-fA-F]{6,12})\s*$/);
    if (!idm) return '格式：/前缀 改 新标题 新内容 #id（id 放最后）';
    const before = rest.slice(0, idm.index).trim();
    const parts = before.split(/\s+/);
    const title = parts[0] || '';
    const content = parts.slice(1).join(' ');
    if (!title) return '格式：/前缀 改 新标题 新内容 #id';
    if (!memberCan(ctx.user_id, ctx.group_id, kbType, 'update')) return '你在本群没有该类型的修改权限。';
    try {
      const r = editKnowledgeRecord(kbType, idm[1], { title, content });
      return `已修改 #${r.id}「${r.title}」`;
    } catch (err) { return err.message; }
  }
  // 增
  const parts = rest.split(/\s+/);
  const title = parts[0] || '';
  const content = parts.slice(1).join(' ');
  if (!title) return '格式：/前缀 增 标题 内容';
  if (!memberCan(ctx.user_id, ctx.group_id, kbType, 'create')) return '你在本群没有该类型的记录权限。';
  try {
    const r = appendKnowledgeRecord(kbType, title, content);
    return `已新增 #${r.id}「${r.title}」（追加到 QQ 动态记录）`;
  } catch (err) { return err.message; }
}

export async function handleIncoming({ text, group_id, user_id, self_id, message_type, groupPolicy = null, groupCfg = null, images = [] }) {
  const t = String(text || '').trim();

  // 图库：仅「前缀触发」的 gallery 消息（上传图片 / 查询 / 删 / 改）——命令/自由消息不拦截；无正文=查全部
  if (groupPolicy?.mode === 'prefix' && groupPolicy?.allowedTypes?.includes('gallery')) {
    const galReply = await handleGalleryMessage(t, images, { group_id, user_id, message_type, groupPolicy });
    if (galReply) return { reply: galReply };
  }

  // 全量知识库：前缀触发 → 动词指令（增/删/改）优先，无动词走 AI 查询
  if (groupPolicy?.mode === 'prefix') {
    const kbType = (groupPolicy.allowedTypes || []).find((ty) => knowledgeTypes().includes(ty));
    if (kbType) {
      const kbReply = await handleKnowledgeCommand(t, { user_id, group_id, groupPolicy }, kbType);
      if (kbReply !== undefined) return { reply: kbReply };
    }
  }

  if (!t) return { reply: '' };

  // 两位确认码：直接执行待确认的变更操作（增/改/删/改名）
  const pendingReply = consumePendingOp(user_id, t);
  if (pendingReply) {
    // 确认执行后清空该会话 AI 记忆，避免下一条消息被误读为"确认回复"
    clearHistory(`${message_type || 'private'}:${group_id || user_id || '?'}`);
    return { reply: pendingReply };
  }

  // 1) 明确命令：零成本，不走 AI
  const cmd = await handleCommand(t, { group_id, user_id, message_type, groupPolicy, groupCfg });
  if (cmd.handled) return { reply: cmd.reply };

  // 首次说话：先绑定身份
  const identity = getIdentity(String(user_id));
  if (!identity && !/(我的名字|我叫|我是)/.test(t)) {
    return {
      reply: '你好，我是知识库助手。第一次说话请先绑定身份：发 /我是 你的名字，或直接说「我的名字是XX」。绑定后我才能按身份记录和查找私人内容。',
    };
  }

  // 2) 自然语言：DeepSeek 工具调用（含重复判断与多版本回答，见 ai.mjs）
  if (aiConfigured()) {
    try {
      const reply = await aiChat({ text: t, group_id, user_id, self_id, message_type, groupPolicy });
      if (reply) return { reply };
    } catch (err) {
      console.error('[ai] 调用失败', err.message);
      return { reply: `AI 出错：${err.message}` };
    }
  }

  return {
    reply: '我是知识库助手。\n命令见 /帮助；在服务器 config.json 里配置 DeepSeek 后，可以直接用自然语言记录/询问。',
  };
}

export { HELP };
