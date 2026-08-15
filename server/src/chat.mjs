import { handleCommand, HELP } from './commands.mjs';
import { aiChat, aiConfigured, consumePendingOp, clearHistory } from './ai.mjs';
import { getIdentity } from './identities.mjs';

export async function handleIncoming({ text, group_id, user_id, self_id, message_type, groupPolicy = null, groupCfg = null }) {
  const t = String(text || '').trim();
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
