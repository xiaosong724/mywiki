// 往指定 QQ 群发一条测试消息（调试用）
// 用法: node scripts/test-send.mjs <group_id> [消息文本]
import config from '../server/src/config.mjs';
import { OneBotClient } from '../server/src/bot/onebot.mjs';

const groupId = process.argv[2];
const text = process.argv.slice(3).join(' ') || '【测试】知识库服务已连接';
if (!groupId) {
  console.error('用法: node scripts/test-send.mjs <group_id> [消息文本]');
  process.exit(1);
}

const bot = new OneBotClient(config.bot);
let done = false;
bot.onStatus = (ok) => {
  if (ok && !done) {
    done = true;
    bot.sendMessage({ message_type: 'group', id: groupId, text })
      .then((okSend) => {
        console.log(okSend ? `已发送到群 ${groupId}` : '发送失败（详情见日志）');
        bot.stop();
        process.exit(okSend ? 0 : 1);
      })
      .catch((err) => {
        console.error('发送异常:', err.message);
        bot.stop();
        process.exit(1);
      });
  }
};
bot.start();
setTimeout(() => {
  console.error('超时：未连上 NapCat');
  process.exit(1);
}, 15000).unref();
