import { initDb } from '../server/src/db.mjs';
import { listEntries, deleteEntry } from '../server/src/entries.mjs';

initDb();

const modId = process.argv[2] || 'xiuxian_addon';
let removed = 0;
const all = listEntries({ type: 'minecraft_mod', limit: 1000 });
for (const e of all) {
  if (e.payload?.mod_id === modId) {
    deleteEntry(e.id, 'reset-mc-mod');
    removed += 1;
  }
}
console.log(`已清理 ${modId} 的导入条目：${removed} 条`);
