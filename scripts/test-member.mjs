import config from '../server/src/config.mjs';
import { OneBotClient } from '../server/src/bot/onebot.mjs';

const [groupId, userId] = process.argv.slice(2);
if (!groupId || !userId) {
  console.error('用法: node scripts/test-member.mjs <群号> <QQ号>');
  process.exit(1);
}

const bot = new OneBotClient(config.bot);
bot.onStatus = async (ok) => {
  if (!ok) return;
  try {
    const info = await bot.getGroupMemberInfo(groupId, userId);
    console.log(JSON.stringify(info, null, 2));
  } catch (err) {
    console.error('查询失败:', err.message);
  }
  bot.stop();
  process.exit(0);
};
bot.start();
setTimeout(() => {
  console.error('超时：未连上 NapCat');
  process.exit(1);
}, 15000).unref();
