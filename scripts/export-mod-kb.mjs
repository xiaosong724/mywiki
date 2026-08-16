#!/usr/bin/env node
// 从 SQLite 导出修仙模组物品明细 → 生成「数据图鉴」补充章节（预览文件）
// 用法：cd server && node ../scripts/export-mod-kb.mjs
// 输出：server/data/kb_mod_items_preview.md（预览，确认后再并入主 md）
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..', 'server');
const db = new DatabaseSync(path.join(SERVER_DIR, 'data', 'knowledge.db'), { readOnly: true });

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
const rows = (kind) => db.prepare(
  "SELECT title, content, payload FROM entries WHERE type='minecraft_mod' AND json_extract(payload,'$.kind')=? ORDER BY title"
).all(kind).map((r) => ({ title: r.title, content: r.content || '', payload: JSON.parse(r.payload || '{}') }));

const out = [];
out.push('## 22. 物品图鉴（数据明细，来自模组 constants.js / elements.js / 更新公告）');
out.push('');

// 22.1 丹药
const pills = rows('pill');
out.push('### 22.1 丹药');
out.push('| 丹药 | 配方 | 效果 | 物品标识 |');
out.push('|---|---|---|---|');
for (const r of pills) out.push(`| ${esc(r.title)} | ${esc(r.payload.recipe)} | ${esc(r.payload.effect)} | ${esc(r.payload.identifier)} |`);
out.push('');

// 22.2 药材
const herbs = rows('herb');
out.push('### 22.2 药材');
out.push('| 药材 | 类别 | 最高品质 | 可炼 | 说明 |');
out.push('|---|---|---|---|---|');
for (const r of herbs) out.push(`| ${esc(r.title)} | ${esc(r.payload.category)} | ${esc(r.payload.max_quality)} | ${esc(r.payload.craft)} | ${esc(r.content)} |`);
out.push('');

// 22.3 矿石
const ores = rows('ore');
out.push('### 22.3 矿石灵石收益');
out.push('| 矿石 | 额外灵石 | 物品标识 |');
out.push('|---|---|---|');
for (const r of ores) out.push(`| ${esc(r.title)} | ${esc(r.payload.reward)} | ${esc(r.payload.identifier)} |`);
out.push('');

// 22.4 妖丹出售价（mob）
const mobs = rows('mob');
out.push('### 22.4 妖丹来源与出售价');
out.push('| 生物 | 妖丹售价（灵石） |');
out.push('|---|---|');
for (const r of mobs) out.push(`| ${esc(r.title)} | ${esc(r.payload.reward)} |`);
out.push('');

// 22.5 妖兽（摘要基础值，12 阶倍率见 §9）
const yao = rows('yaoshou');
out.push('### 22.5 妖兽（基础属性；12 阶倍率表见 §9 妖兽章节）');
out.push('| 妖兽 | 基础生命 | 基础攻击 | 掉落 | 物品标识 |');
out.push('|---|---|---|---|---|');
for (const r of yao) out.push(`| ${esc(r.title)} | ${esc(r.payload.base_hp)} | ${esc(r.payload.base_atk)} | 妖丹 + 修为 | ${esc(r.payload.identifier)} |`);
out.push('');

// 22.6 灵宠
const pets = rows('pet');
out.push('### 22.6 灵宠');
out.push('| 灵宠 | 基础生命 | 基础攻击 | 基础速度 | 参战 | 骑乘 | 飞行 | 物品标识 |');
out.push('|---|---|---|---|---|---|---|---|');
for (const r of pets) out.push(`| ${esc(r.title)} | ${esc(r.payload.base_hp)} | ${esc(r.payload.base_atk)} | ${esc(r.payload.base_speed)} | ${esc(r.payload.fight)} | ${esc(r.payload.mount)} | ${esc(r.payload.fly)} | ${esc(r.payload.identifier)} |`);
out.push('');

// 22.7 五行能力
const abilities = rows('ability');
out.push('### 22.7 五行能力（开启后生效，见 §8.4）');
out.push('| 能力 | 属性 | 专属 | 效果 |');
out.push('|---|---|---|---|');
for (const r of abilities) out.push(`| ${esc(r.title)} | ${esc(r.payload.element)} | ${esc(r.payload.exclusive)} | ${esc(r.payload.effect)} |`);
out.push('');

// 22.8 指令
const cmds = rows('command');
out.push('### 22.8 指令表');
out.push('| 指令 | 用途 |');
out.push('|---|---|');
for (const r of cmds) out.push(`| ${esc(r.payload.usage)} | ${esc(r.payload.effect)} |`);
out.push('');

// 22.9 更新公告（放最末尾：追加段，缓存友好）
const logs = rows('changelog');
out.push('### 22.9 更新公告（历史版本）');
out.push('');
for (const r of logs) {
  out.push(r.content.trim());
  out.push('');
}

const text = out.join('\n');
const target = path.join(SERVER_DIR, 'data', 'kb_mod_items_preview.md');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, text, 'utf-8');
console.log(`已生成预览：${target}`);
console.log(`大小：${(text.length / 1024).toFixed(1)} KB，行数：${text.split('\n').length}`);
console.log(`章节：${pills.length} 丹药 / ${herbs.length} 药材 / ${ores.length} 矿石 / ${mobs.length} 妖丹 / ${yao.length} 妖兽 / ${pets.length} 灵宠 / ${abilities.length} 五行能力 / ${cmds.length} 指令 / ${logs.length} 更新公告`);
db.close();
