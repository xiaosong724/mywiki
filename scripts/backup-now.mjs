import { initDb } from '../server/src/db.mjs';
import { createBackup, listBackups, deleteBackup } from '../server/src/backup.mjs';

initDb();
const name = process.argv[2];
if (name) {
  await deleteBackup(name);
  console.log(`已删除备份：${name}`);
  process.exit(0);
}
const backup = await createBackup();
console.log(`已创建备份：${backup.name}`);
const list = await listBackups();
console.log(`当前备份数量：${list.length}`);
