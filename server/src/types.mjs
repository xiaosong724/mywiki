// 类型注册中心：新增一种 wiki 类型 = 在这里加一个定义，无需改表结构
// 字段 kind: text | textarea | date | number | bool | secret | monthday
import { getDb } from './db.mjs';

export const TYPES = {
  minecraft_mod: {
    label: 'Minecraft 模组',
    icon: '⛏️',
    reminder: false,
    fields: [
      { key: 'mod_id', label: '模组 ID', kind: 'text' },
      { key: 'kind', label: '条目类型', kind: 'text' },
      { key: 'version', label: '版本', kind: 'text' },
      { key: 'mc_version', label: 'MC/BDS 版本', kind: 'text' },
      { key: 'entry', label: '入口', kind: 'text' },
      { key: 'script_path', label: '脚本路径', kind: 'text' },
      { key: 'identifier', label: '标识符', kind: 'text' },
      { key: 'source_file', label: '来源文件', kind: 'text' },
      { key: 'status', label: '状态', kind: 'text' },
      { key: 'features', label: '功能/设定', kind: 'textarea' },
      { key: 'recipe', label: '配方', kind: 'textarea' },
      { key: 'effect', label: '效果/用途', kind: 'textarea' },
      { key: 'category', label: '类别', kind: 'text' },
      { key: 'craft', label: '可炼制', kind: 'text' },
      { key: 'max_quality', label: '最高品阶', kind: 'number' },
      { key: 'reward', label: '灵石/掉落', kind: 'number' },
      { key: 'base_mob', label: '基础生物', kind: 'text' },
      { key: 'base_hp', label: '基础血量', kind: 'number' },
      { key: 'base_atk', label: '基础攻击', kind: 'number' },
      { key: 'base_speed', label: '基础速度', kind: 'number' },
      { key: 'fight', label: '参战', kind: 'text' },
      { key: 'mount', label: '骑乘', kind: 'text' },
      { key: 'fly', label: '飞行', kind: 'text' },
      { key: 'tiers', label: '阶位倍率', kind: 'textarea' },
      { key: 'index', label: '境界序号', kind: 'number' },
      { key: 'break_cost', label: '突破修为', kind: 'number' },
      { key: 'element', label: '五行', kind: 'text' },
      { key: 'exclusive', label: '专属', kind: 'text' },
      { key: 'qi', label: '灵气消耗', kind: 'number' },
      { key: 'usage', label: '用法', kind: 'text' },
      { key: 'section', label: '章节', kind: 'text' },
    ],
  },
  computer_knowledge: {
    label: '电脑文件知识',
    icon: '💻',
    reminder: false,
    fields: [
      { key: 'category', label: '分类', kind: 'text' },
      { key: 'file_path', label: '相关文件路径', kind: 'text' },
    ],
  },
  account: {
    label: '账号信息',
    icon: '🔑',
    reminder: false,
    secretFields: ['password'],
    fields: [
      { key: 'platform', label: '平台', kind: 'text' },
      { key: 'username', label: '账号', kind: 'text' },
      { key: 'password', label: '密码', kind: 'secret' },
      { key: 'note', label: '备注', kind: 'textarea' },
    ],
  },
  note: {
    label: '备忘提示',
    icon: '📌',
    reminder: true,
    fields: [
      { key: 'date', label: '日期', kind: 'date' },
      { key: 'time', label: '时间(可选,精确到分钟)', kind: 'time' },
      { key: 'advance_days', label: '提前提醒(天)', kind: 'number' },
      { key: 'repeat_yearly', label: '每年重复', kind: 'bool' },
    ],
  },
  food_expiry: {
    label: '食品过期',
    icon: '🥛',
    reminder: true,
    fields: [
      { key: 'expire_date', label: '过期日期', kind: 'date' },
      { key: 'advance_days', label: '提前提醒(天)', kind: 'number' },
    ],
  },
  item_location: {
    label: '物品位置',
    icon: '📍',
    reminder: false,
    fields: [
      { key: 'quantity', label: '数量', kind: 'text' },
    ],
  },
  birthday: {
    label: '家人生日',
    icon: '🎂',
    reminder: true,
    fields: [
      { key: 'name', label: '姓名', kind: 'text' },
      { key: 'relation', label: '关系', kind: 'text' },
      { key: 'birth_date', label: '生日(月-日)', kind: 'monthday' },
      { key: 'lunar', label: '农历生日', kind: 'bool' },
      { key: 'birth_year', label: '出生年份(可空)', kind: 'text' },
      { key: 'advance_days', label: '提前提醒(天)', kind: 'number' },
    ],
  },
  travel: {
    label: '旅行记录',
    icon: '✈️',
    reminder: false,
    fields: [
      { key: 'place', label: '地点', kind: 'text' },
      { key: 'start_date', label: '日期', kind: 'date' },
      { key: 'companions', label: '同行人', kind: 'text' },
    ],
  },
  help: {
    label: '使用帮助',
    icon: '📖',
    reminder: false,
    fields: [
      { key: 'section', label: '章节', kind: 'text' },
    ],
  },
};

// 命令里支持的中文类型别名
export const TYPE_ALIASES = {
  '模组': 'minecraft_mod',
  '我的世界': 'minecraft_mod',
  '知识': 'computer_knowledge',
  '电脑': 'computer_knowledge',
  '账号': 'account',
  '琐事': 'note',
  '笔记': 'note',
  '备忘录': 'note',
  '备忘': 'note',
  '提醒': 'note',
  '日期': 'note',
  '重要': 'note',
  '食物': 'food_expiry',
  '食品': 'food_expiry',
  '过期': 'food_expiry',
  '位置': 'item_location',
  '物品': 'item_location',
  '生日': 'birthday',
  '旅行': 'travel',
  '旅游': 'travel',
  '帮助': 'help',
  '手册': 'help',
  '说明': 'help',
};

export function resolveType(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  if (TYPES[key]) return key;
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key];
  return null;
}

export function getType(key) {
  const base = TYPES[key];
  if (!base) return null;
  const override = getLabelOverride(key);
  return override ? { ...base, label: override } : base;
}

let labelCache = null;
let labelCacheAt = 0;
function getLabelOverrides() {
  if (!labelCache || Date.now() - labelCacheAt > 5000) {
    const rows = getDb().prepare('SELECT type_key, label FROM type_label_overrides').all();
    labelCache = Object.fromEntries(rows.map((r) => [r.type_key, r.label]));
    labelCacheAt = Date.now();
  }
  return labelCache;
}

function getLabelOverride(key) {
  return getLabelOverrides()[key] || null;
}

export function getAllTypes() {
  const out = {};
  for (const [key, base] of Object.entries(TYPES)) {
    out[key] = { ...base, label: getLabelOverride(key) || base.label };
  }
  return out;
}

export function resolveTypeLoose(name) {
  const direct = resolveType(name);
  if (direct) return direct;
  const s = String(name || '').trim().toLowerCase();
  for (const [key, t] of Object.entries(getAllTypes())) {
    if (String(t.label).toLowerCase() === s || String(TYPES[key].label).toLowerCase() === s) return key;
  }
  return null;
}

function intOr(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// 计算提醒时间：返回 { remindAt: ISO|null, recurrence }
export function computeRemindAt(typeKey, payload, now = new Date()) {
  const t = getType(typeKey);
  if (!t || !t.reminder || !payload) return { remindAt: null, recurrence: 'none' };

  let base = null;
  let recurrence = 'none';
  let advanceDays = 1;

  if (typeKey === 'food_expiry') {
    base = parseDateOnly(payload.expire_date, now);
    advanceDays = intOr(payload.advance_days, 1);
  } else if (typeKey === 'note') {
    // 备忘提示：日期支持带时间（明天8:30/周五晚上8点）或相对时间（一分钟后/半小时后/2小时后），time 字段可单独指定
    const rel = parseRelativeTime(payload.date, now);
    base = rel || parseDateTimeInput(payload.date, now); // 注意：不能写 let base，否则遮蔽外层 base 导致永远 null
    recurrence = payload.repeat_yearly ? 'yearly' : 'none';
    advanceDays = intOr(payload.advance_days, 0);
    const t = payload.time ? extractTime(payload.time) : null;
    if (base && !rel && t) base.setHours(t.h, t.m, 0, 0);
    if (recurrence === 'yearly' && base && base < now) {
      base = new Date(base);
      base.setFullYear(base.getFullYear() + 1);
    }
  } else if (typeKey === 'birthday') {
    recurrence = 'yearly';
    const md = String(payload.birth_date || '').trim().match(/(\d{1,2})-(\d{1,2})/);
    if (!md) return { remindAt: null, recurrence };
    const m = Number(md[1]);
    const d = Number(md[2]);
    advanceDays = intOr(payload.advance_days, 3);
    if (payload.lunar) {
      base = nextLunarDate(m, d, now);
      if (!base) return { remindAt: null, recurrence };
    } else {
      base = new Date(now.getFullYear(), m - 1, d, 9, 0, 0);
      if (base < now) base.setFullYear(base.getFullYear() + 1);
    }
  }

  if (!base) return { remindAt: null, recurrence };
  const remind = new Date(base);
  remind.setDate(remind.getDate() - advanceDays);
  return { remindAt: toLocalISOLocal(remind), recurrence };
}

function parseDateOnly(s, now) {
  if (!s) return null;
  // 复用宽松解析：今天/明天/N天后/X月X日/周X/X号/YYYY-MM-DD 都支持
  return parseDateInput(s, now);
}

import { toLocalISO as toLocalISOLocal } from './time.mjs';
import { parseDateInput, parseDateTimeInput, extractTime, parseRelativeTime } from './time.mjs';
import { nextLunarDate } from './lunar.mjs';
