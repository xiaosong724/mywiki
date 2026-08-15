import http from 'node:http';
import config from './config.mjs';
import { initDb } from './db.mjs';
import { routes } from './routes.mjs';
import { startScheduler } from './reminders.mjs';
import { runBackup } from './backup.mjs';
import { OneBotClient, extractText } from './bot/onebot.mjs';
import { handleIncoming } from './chat.mjs';
import { aiConfigured, setCostReporter } from './ai.mjs';
import { getGroupConfig, listGroupConfigs, matchGroupTrigger, looksLikeConfirmation } from './groups.mjs';

initDb();

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const server = http.createServer(routes);

// 群成员角色缓存（60s）：避免每条私聊消息都打 OneBot 接口
const roleCache = new Map();
const ROLE_CACHE_TTL = 60 * 1000;
async function cachedMemberRole(bot, gid, uid) {
  const key = `${gid}:${uid}`;
  const hit = roleCache.get(key);
  if (hit && Date.now() - hit.ts < ROLE_CACHE_TTL) return hit.info;
  const info = await bot.getMemberRole(gid, uid); // {found,role} | {found:false} | null(查询失败=未知)
  if (info) roleCache.set(key, { info, ts: Date.now() });
  return info;
}

let bot = null;
if (config.bot?.enabled) {
  bot = new OneBotClient(config.bot);
  bot.onMessage = async (ev) => {
    // 权限过滤：白名单为空 = 不限制
    const gid = String(ev.group_id || '');
    const uid = String(ev.user_id || '');
    const groupCfg = ev.message_type === 'group' && gid ? getGroupConfig(gid) : null;
    // 只有「已配置且启用」的群才走群配置；停用（enabled=false）的群按未配置处理，仍受白名单约束
    const groupConfigured = !!groupCfg && !!groupCfg.enabled;
    if (ev.message_type === 'group' && !groupConfigured && config.bot.allowedGroups?.length && !config.bot.allowedGroups.includes(gid)) return;
    if (ev.message_type === 'private' && config.bot.allowedUsers?.length && !config.bot.allowedUsers.includes(uid)) return;

    const text = extractText(ev.message);
    if (!text) return;
    console.log(`[bot] ${ev.message_type === 'group' ? `群${gid}` : '私聊'} ${uid}: ${text.slice(0, 60)}`);

    // 私聊拦截：只检查「禁成员私聊」的已启用群；群主始终豁免；查询失败按拒绝处理（fail-closed）
    if (ev.message_type === 'private') {
      const restricted = listGroupConfigs().filter((cfg) => cfg.enabled && cfg.memberPrivateChat === false);
      for (const cfg of restricted) {
        const info = await cachedMemberRole(bot, cfg.groupId, uid);
        if (info === null) {
          console.warn(`[bot] 私聊 ${uid} 查询群${cfg.groupId}成员身份失败，按拒绝处理`);
          await bot.sendMessage({ message_type: 'private', id: uid, text: '暂时无法验证你的群成员身份，请稍后再试，或在群里使用。' });
          return;
        }
        if (info.found && info.role !== 'owner') {
          await bot.sendMessage({ message_type: 'private', id: uid, text: '本群成员未开启私聊权限，请在群里使用；群主不受限制。' });
          return;
        }
      }
    }

    let groupPolicy = null;
    let effectiveText = text;
    if (ev.message_type === 'group' && gid) {
      const cfg = groupCfg;
      if (cfg?.enabled) {
        if (!text.trim().startsWith('/')) {
          const trigger = matchGroupTrigger(cfg, text);
          if (trigger) {
            groupPolicy = { allowedTypes: trigger.allowedTypes, mode: trigger.mode };
            effectiveText = trigger.query;
          } else if (looksLikeConfirmation(text)) {
            // 确认消息（两位码 / 确认XX）：受限群里也必须放行，否则确认码永远无法执行
            groupPolicy = { allowedTypes: Object.entries(cfg.typeRules || {}).filter(([, r]) => r.mode !== 'off').map(([type]) => type) };
          } else {
            console.log(`[bot] 群${gid} 消息未匹配触发规则，忽略`);
            return;
          }
        } else {
          groupPolicy = { allowedTypes: Object.entries(cfg.typeRules || {}).filter(([, r]) => r.mode !== 'off').map(([type]) => type) };
        }
      }
    }

    const { reply } = await handleIncoming({
      text: effectiveText,
      group_id: ev.group_id,
      user_id: ev.user_id,
      self_id: ev.self_id,
      message_type: ev.message_type,
      groupPolicy,
      groupCfg,
    });
    if (reply) {
      const ok = await bot.sendMessage({
        message_type: ev.message_type,
        id: ev.message_type === 'group' ? ev.group_id : ev.user_id,
        text: reply,
      });
      if (!ok) console.error('[bot] 回复发送失败');
    }
  };
  bot.start();
}

setCostReporter(async ({ report, costYuan, balance }) => {
  console.log(`[ai] 费用报告: ${report.replace(/\n/g, ' | ')}`);
  const target = config.ai?.costNotifyQQ;
  if (!target || !bot?.connected) return;
  const ok = await bot.sendMessage({ message_type: 'private', id: target, text: report });
  if (!ok) console.warn('[ai] 费用报告私聊发送失败');
});

const timer = startScheduler(bot);

let backupTimer = null;
if (config.backup?.intervalHours) {
  const backup = () => {
    runBackup(config.backup.retention || 10)
      .then((b) => console.log(`[备份] 已创建 ${b.name}`))
      .catch((err) => console.error('[备份] 失败', err.message));
  };
  // 启动后延迟 60 秒先做一次，之后按间隔执行
  setTimeout(backup, 60 * 1000);
  backupTimer = setInterval(backup, (config.backup.intervalHours || 24) * 3600 * 1000);
}

server.listen(config.port, config.host, () => {
  console.log(`[wiki] 核心服务 http://${config.host}:${config.port}`);
  console.log(`[wiki] 网页   http://localhost:${config.port}`);
  console.log(`[wiki] 机器人 ${config.bot?.enabled ? '已启用，等待 NapCat WS…' : '未启用'}`);
  console.log(`[wiki] DeepSeek ${aiConfigured() ? '已配置' : '未配置（命令模式可用，自然语言暂不可用）'}`);
});

function shutdown() {
  console.log('\n[wiki] 正在退出…');
  clearInterval(timer);
  if (backupTimer) clearInterval(backupTimer);
  bot?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
