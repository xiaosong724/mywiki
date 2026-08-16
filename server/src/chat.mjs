import { handleCommand, HELP } from './commands.mjs';
import { aiChat, aiConfigured, consumePendingOp, clearHistory } from './ai.mjs';
import { getIdentity } from './identities.mjs';
import { listGallery, countGallery, createGallery } from './gallery.mjs';
import { memberCan } from './permissions.mjs';
import { isTypeAllowed } from './groups.mjs';
import { readFileSync, existsSync } from 'node:fs';

// 图库：前缀触发的 gallery 消息（带图=上传，纯文本=查询，最多 5 张/页）
async function handleGalleryMessage(text, images, ctx) {
  const own = (i) => getIdentity(String(i));
  // 上传：消息带图片
  if (images?.length) {
    if (!isTypeAllowed(ctx.groupPolicy, 'gallery')) return '这个群没有开启图库。';
    if (!memberCan(ctx.user_id, ctx.group_id, 'gallery', 'create')) return '你在本群没有图库的上传权限。';
    const id = own(ctx.user_id);
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
      const g = createGallery({ owner: id.name, caption: text, data: buf, mime });
      return `📷 已保存图库 #${g.id.slice(0, 8)}（${id.name}）：${g.caption || '（无介绍）'}（${(g.size / 1024).toFixed(0)}KB）`;
    } catch (err) {
      return `保存失败：${err.message}`;
    }
  }
  // 查询：关键词匹配（绑定名称 或 文字介绍），最新在前，最多 5 张/页
  if (!isTypeAllowed(ctx.groupPolicy, 'gallery')) return '这个群没有开启图库。';
  if (!memberCan(ctx.user_id, ctx.group_id, 'gallery', 'read')) return '你在本群没有图库的查看权限。';
  const parts = String(text || '').split(/\s+/);
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

export async function handleIncoming({ text, group_id, user_id, self_id, message_type, groupPolicy = null, groupCfg = null, images = [] }) {
  const t = String(text || '').trim();

  // 图库：仅「前缀触发」的 gallery 消息（上传图片 / 查询）——命令/自由消息不拦截；无正文=查全部
  if (groupPolicy?.mode === 'prefix' && groupPolicy?.allowedTypes?.includes('gallery')) {
    const galReply = await handleGalleryMessage(t, images, { group_id, user_id, message_type, groupPolicy });
    if (galReply) return { reply: galReply };
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
