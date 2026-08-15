import { initDb } from './db.mjs';
import { createEntry, listEntries } from './entries.mjs';
import { addDays, toLocalDateStr } from './time.mjs';

const args = process.argv.slice(2);
initDb();

if (!args.includes('--force') && listEntries({ limit: 1 }).length) {
  console.log('知识库已有数据，跳过 seed（用 --force 强制覆盖写入）');
  process.exit(0);
}

const today = new Date();
const d = (n) => toLocalDateStr(addDays(today, n));
const md = (n) => {
  const x = addDays(today, n);
  return `${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

const demos = [
  { type: 'food_expiry', title: '牛奶（冰箱）', payload: { expire_date: d(-1), advance_days: 1 }, content: '盒装鲜牛奶，已过期要扔掉' },
  { type: 'food_expiry', title: '豆腐', payload: { expire_date: d(2), advance_days: 1 }, content: '放冰箱冷藏层' },
  { type: 'item_location', title: '大门钥匙', payload: { quantity: '1串' }, location: '玄关抽屉' },
  { type: 'item_location', title: '身份证', payload: { quantity: '1张' }, location: '床头柜第二层' },
  { type: 'birthday', title: '奶奶生日', payload: { name: '奶奶', relation: '奶奶', birth_date: md(3), advance_days: 3 }, content: '每年提醒' },
  { type: 'note', title: '交房租', payload: { date: d(5), advance_days: 3 }, content: '每月房租' },
  { type: 'minecraft_mod', title: '机械动力 (Create)', payload: { mod_version: '0.5.1f', features: '传动/自动化/火车', config_path: 'config/create.toml' }, content: '核心玩法：动力机械' },
  { type: 'computer_knowledge', title: 'C盘清理思路', payload: { category: '系统维护', file_path: 'C:\\temp' }, content: '先清临时文件，再看大文件' },
  { type: 'account', title: '某游戏平台账号', payload: { platform: '某平台', username: 'demo_user', password: 'demo_pwd_123', note: '不重要账号' } },
  { type: 'travel', title: '2026春节云南游', payload: { place: '大理、丽江', start_date: '2026-02-10', companions: '家人' }, content: '苍山洱海，古城晒太阳' },
  { type: 'note', title: '水龙头滴水要修', content: '厨房水龙头慢滴，找师傅或换垫圈' },
];

for (const x of demos) createEntry({ ...x, actor: 'seed' });
console.log(`已写入 ${demos.length} 条演示数据`);
