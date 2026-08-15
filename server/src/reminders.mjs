import config from './config.mjs';
import {
  getDueNow, markNotified, markDone, advanceNext, maskEntry, entrySummary,
} from './entries.mjs';
import { nowLocalISO } from './time.mjs';
import { getQqByName } from './identities.mjs';

function formatReminder(e) {
  return `⏰ 提醒：${entrySummary(maskEntry(e))}`;
}

export function startScheduler(bot) {
  const run = async () => {
    try {
      const due = getDueNow();
      if (due.length) console.log(`[调度] 到期 ${due.length} 条`);
      const fallbackQq = config.notify?.qqUserId;
      const fallbackGroup = config.notify?.groupId;
      for (const e of due) {
        const text = formatReminder(e);
        let sent = false;
        if (bot?.connected) {
          // 优先发回创建时的群（source_group）并 @ 创建者；私聊创建的用固定群 notify.groupId
          const gid = e.sourceGroup || fallbackGroup;
          if (gid) {
            const atQq = getQqByName(e.owner) || fallbackQq;
            const msg = atQq ? `[CQ:at,qq=${atQq}] ${text}` : text;
            try {
              sent = await bot.sendMessage({ message_type: 'group', id: gid, text: msg });
              if (sent) console.log(`[调度] 群发提醒 ${gid} @${atQq || '-'}: ${text.replace(/\n/g, ' ')}`);
            } catch (err) {
              console.error('[调度] 群发失败', err.message);
            }
          }
          // 没有可用的群（既无来源群也未配固定群）→ 私发兜底
          if (!sent && fallbackQq) {
            try {
              sent = await bot.sendMessage({ message_type: 'private', id: fallbackQq, text });
            } catch (err) {
              console.error('[调度] 私发失败', err.message);
            }
          }
        }
        if (!sent) {
          console.log(`[调度] 机器人未连接，保留待重发：${text.replace(/\n/g, ' ')}`);
          continue; // 不标记，下轮重试
        }
        markNotified(e.id, nowLocalISO());
        if (e.recurrence === 'yearly') advanceNext(e.id);
        else markDone(e.id);
      }
    } catch (err) {
      console.error('[调度] 错误', err);
    }
  };
  const timer = setInterval(run, (config.scheduler?.intervalSeconds || 30) * 1000);
  run();
  return timer;
}
