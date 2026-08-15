// 手动登记身份：QQ 号绑定名字
// 用法: node scripts/register-identity.mjs <qq_id> <名字>
import { initDb } from '../server/src/db.mjs';
import { registerIdentity } from '../server/src/identities.mjs';

initDb();
const [qqId, name] = process.argv.slice(2);
if (!qqId || !name) {
  console.error('用法: node scripts/register-identity.mjs <qq_id> <名字>');
  process.exit(1);
}
const r = registerIdentity(qqId, name, 'manual');
console.log(`已绑定：QQ ${r.qq_id} = ${r.name}`);
