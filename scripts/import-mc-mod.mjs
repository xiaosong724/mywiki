import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { initDb } from '../server/src/db.mjs';
import {
  createEntry, getEntry, updateEntry,
} from '../server/src/entries.mjs';

const SRC = process.argv[2] || 'C:/mc/xiuxian_addon';
const ACTOR = 'import-mc-mod';
const MOD_ID = 'xiuxian_addon';

function stableId(kind, key) {
  const h = createHash('sha1').update(`${MOD_ID}:${kind}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// 把 ES module 源码当普通脚本执行，取回顶层 export 的常量（constants.js / elements.js）
function loadConst(file, wanted) {
  let src = fs.readFileSync(file, 'utf8');
  src = src
    .replace(/import\s+(?:[\s\S]*?\sfrom\s*)?['"][^'"]+['"];?/g, '')
    .replace(/\bexport\s+/g, '');
  const noop = () => {};
  const subscribe = { subscribe: noop };
  const system = {
    beforeEvents: { startup: subscribe },
    runInterval: () => ({ clear: noop }),
    runTimeout: () => ({ clear: noop }),
    clearRun: noop,
  };
  const world = {
    afterEvents: {
      projectileHitEntity: subscribe,
      projectileHitBlock: subscribe,
      entityHurt: subscribe,
      playerBreakBlock: subscribe,
      entityDie: subscribe,
    },
    beforeEvents: {
      playerInteractWithBlock: subscribe,
      playerInteractWithEntity: subscribe,
      entitySpawn: subscribe,
      itemUseOn: subscribe,
      itemUse: subscribe,
    },
    getEntity: () => null,
    getAllPlayers: () => [],
    getPlayers: () => [],
  };
  const sandbox = {
    console, Math, JSON, Set, Map, Object, Array, Number, String, Boolean,
    system, world,
  };
  const ctx = vm.createContext(sandbox);
  const wrapped = `${src}\n;globalThis.__exports = { ${wanted.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(',')} };`;
  vm.runInContext(wrapped, ctx, { filename: file });
  return sandbox.__exports || {};
}

function upsert(kind, key, title, payload, content = '') {
  const id = stableId(kind, key);
  const existing = getEntry(id);
  const body = {
    type: 'minecraft_mod',
    title,
    content,
    payload: { ...payload, kind, mod_id: MOD_ID },
    tags: ['minecraft', '修仙'],
  };
  if (existing) return updateEntry(id, body, ACTOR);
  return createEntry({ ...body, actor: ACTOR, id });
}

function herbName(id) {
  return herbNames[id] || id;
}

let herbNames = {};

function importConstants(dir) {
  const c = loadConst(path.join(dir, 'bp', 'scripts', 'constants.js'), [
    'HERB_NAMES', 'RARE_HERBS', 'BASIC_HERBS', 'DAN_RECIPES', 'ORE_REWARDS',
    'MOB_REWARDS', 'YAOSHOU_BIO', 'YAOSHOU_LEVELS', 'LINGCHONG_BIO',
    'REALMS', 'BREAK_COST', 'REALM_STATS',
  ]);
  herbNames = c.HERB_NAMES || {};

  // 项目总览
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'bp', 'manifest.json'), 'utf8'));
  const header = manifest.header || {};
  const version = (header.version || []).join('.');
  upsert('project', MOD_ID, '修仙 Addon', {
    version,
    mc_version: (header.min_engine_version || []).join('.'),
    entry: (manifest.modules || []).find((m) => m.type === 'script')?.entry || '',
    source_file: 'bp/manifest.json',
  }, 'Bedrock Script API 修仙玩法 Addon：修炼/境界/炼丹/药材/妖丹/妖兽/灵宠/领地/交易行/五行能力等。');

  // 药材
  for (const [key, name] of Object.entries(c.HERB_NAMES || {})) {
    const rare = (c.RARE_HERBS || []).includes(key);
    const crafts = Object.entries(c.DAN_RECIPES || {})
      .filter(([, r]) => r.materials && r.materials[key])
      .map(([, r]) => r.name)
      .join('、');
    upsert('herb', key, name, {
      identifier: `xx:herb_${key}_q{品质}`,
      category: rare ? '稀有药料' : '基础药材',
      max_quality: rare ? 9 : 5,
      craft: crafts || '暂无可炼丹药',
      source_file: 'bp/scripts/constants.js',
    }, rare ? '稀有药材：采集有失败率，可用于提升丹药品阶。' : '基础药材：提升炼丹成功率。');
  }

  // 丹药配方
  for (const [key, r] of Object.entries(c.DAN_RECIPES || {})) {
    const mat = Object.entries(r.materials || {})
      .map(([m, n]) => `${herbName(m)}×${n}`)
      .join(' + ');
    upsert('pill', key, r.name, {
      identifier: `xx:danyao_${key}_q{品质}`,
      recipe: mat,
      effect: r.desc || '',
      source_file: 'bp/scripts/constants.js',
    });
  }

  // 矿石灵石
  for (const [id, reward] of Object.entries(c.ORE_REWARDS || {})) {
    const key = id.replace(/^minecraft:/, '');
    const name = key.replace(/_/g, ' ').replace(/\b\w/g, (s) => s.toUpperCase());
    upsert('ore', key, name, {
      identifier: id,
      reward,
      source_file: 'bp/scripts/constants.js',
    }, `破坏后额外获得 ${reward} 灵石（原版掉落保留）。`);
  }

  // 原版生物妖丹
  for (const [id, arr] of Object.entries(c.MOB_REWARDS || {})) {
    const key = id.replace(/^minecraft:/, '');
    const name = Array.isArray(arr) ? arr[0] : String(arr);
    const price = Array.isArray(arr) ? arr[1] : 0;
    upsert('mob', key, name, {
      identifier: id,
      reward: price,
      source_file: 'bp/scripts/constants.js',
    }, `击杀掉落 ${name}，出售价 ${price} 灵石。`);
  }

  // 妖兽
  for (const [key, b] of Object.entries(c.YAOSHOU_BIO || {})) {
    const tiers = (c.YAOSHOU_LEVELS || []).map((lv, i) => {
      const stage = ['初期', '中期', '后期'];
      return `第${i + 1}阶 ${stage.map((s, j) => `${s} 血×${lv.hp[j]} 攻×${lv.atk[j]} 体型×${lv.scale[j]}`).join(' / ')}`;
    }).join('\n');
    upsert('yaoshou', key, b.name + '妖兽', {
      identifier: `xx:yaoshou_${key}`,
      base_mob: b.name,
      base_hp: b.baseHp,
      base_atk: b.baseAtk,
      tiers,
      source_file: 'bp/scripts/constants.js',
    }, '野外攻击型生物生成时概率变为妖兽，击杀掉落妖丹与修为。');
  }

  // 灵宠
  for (const [key, p] of Object.entries(c.LINGCHONG_BIO || {})) {
    upsert('pet', key, p.name, {
      identifier: `xx:lingchong_${key}`,
      base_hp: p.baseHp,
      base_atk: p.baseAtk,
      base_speed: p.baseSpeed,
      fight: p.fight ? '可参战' : '不参战',
      mount: p.mount ? `${p.mount} 阶可骑` : '不可骑',
      fly: p.fly ? '可飞行' : '',
      source_file: 'bp/scripts/constants.js',
    });
  }

  // 境界
  (c.REALMS || []).forEach((name, i) => {
    const stat = (c.REALM_STATS || [])[i] || [];
    upsert('realm', String(i + 1), name, {
      index: i + 1,
      break_cost: (c.BREAK_COST || [])[i],
      base_hp: stat[0],
      base_atk: stat[1],
      source_file: 'bp/scripts/constants.js',
    });
  });
}

function importAbilities(dir) {
  const c = loadConst(path.join(dir, 'bp', 'scripts', 'elements.js'), ['ABILITIES']);
  for (const [key, a] of Object.entries(c.ABILITIES || {})) {
    upsert('ability', key, `${a.el}·${a.name}`, {
      identifier: `ability:${key}`,
      element: a.el,
      exclusive: a.exclusive ? '单灵根专属' : '',
      qi: a.qi || 0,
      effect: a.desc || '',
      source_file: 'bp/scripts/elements.js',
    });
  }
}

function importCommands(dir) {
  const known = [
    ['xx', '打开修仙主菜单'],
    ['xx:status', '查看修仙状态'],
    ['xx:absorb', '吸收灵石修炼'],
    ['xx:restore', '恢复灵气'],
    ['xx:up', '尝试突破'],
    ['xx:csz', '传送阵'],
    ['xx:jy', '交易行'],
    ['xx:land', '领地系统'],
    ['xx:lc', '灵宠管理'],
    ['xx:stone', '灵石管理（管理员）'],
    ['xx:fx', '突破特效测试'],
    ['xx:pfx', '粒子预览（管理员）'],
  ];
  for (const [name, desc] of known) {
    upsert('command', name, `/${name}`, {
      identifier: name,
      usage: `/${name}`,
      effect: desc,
      source_file: 'bp/scripts/*.js',
    });
  }
}

function importChangelog(dir) {
  const file = path.join(dir, '更新公告.md');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const blocks = text.split(/(?=^#{2,3}\s+.*\bv\d)/m).filter((b) => b.trim());
  for (const block of blocks) {
    const m = block.match(/^#{2,3}\s+.*?v([\d.]+)/m);
    if (!m) continue;
    upsert('changelog', m[1], `v${m[1]}`, {
      version: m[1],
      source_file: '更新公告.md',
    }, block.trim().slice(0, 4000));
  }
}

function importGuide(dir) {
  const file = path.join(dir, '知识库_玩家版.md');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const blocks = text.split(/(?=^##\s)/m).filter((b) => b.trim());
  for (const block of blocks) {
    const m = block.match(/^#\s+(.+?)\s*$/m);
    const heading = m ? m[1].trim() : '总览';
    const section = block.split('\n')[0].replace(/^#+\s*/, '').trim();
    const key = section.replace(/^[\d.\s]+/, '').trim() || 'overview';
    upsert('guide', key, `玩家指南：${key}`, {
      section,
      source_file: '知识库_玩家版.md',
    }, block.trim());
  }
}

initDb();
console.log('导入源目录：', SRC);
importConstants(SRC);
importAbilities(SRC);
importCommands(SRC);
importChangelog(SRC);
importGuide(SRC);
console.log('修仙 Addon 知识库导入完成');
