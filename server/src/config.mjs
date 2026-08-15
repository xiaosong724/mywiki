import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_DIR = path.resolve(__dirname, '..');
export const WEB_DIR = path.resolve(SERVER_DIR, '..', 'web');
export const DATA_DIR = path.resolve(SERVER_DIR, 'data');

const examplePath = path.join(SERVER_DIR, 'config.example.json');
const configPath = path.join(SERVER_DIR, 'config.json');
const configPathOverride = process.env.MY_WIKI_CONFIG
  ? path.resolve(process.env.MY_WIKI_CONFIG)
  : null;

// 读取 JSON 配置文件：兼容 UTF-8 BOM（Windows 工具常见），避免 JSON.parse 报错
function readJsonFile(p) {
  return JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''));
}

const defaults = readJsonFile(examplePath);

let config = defaults;
const activePath = configPathOverride || configPath;
if (existsSync(activePath)) {
  const userCfg = readJsonFile(activePath);
  config = {
    ...defaults,
    ...userCfg,
    scheduler: { ...defaults.scheduler, ...userCfg.scheduler },
    backup: { ...defaults.backup, ...userCfg.backup },
    notify: { ...defaults.notify, ...userCfg.notify },
    bot: { ...defaults.bot, ...userCfg.bot },
    ai: { ...defaults.ai, ...userCfg.ai },
  };
} else {
  if (!configPathOverride) writeFileSync(activePath, JSON.stringify(defaults, null, 2), 'utf-8');
}

mkdirSync(DATA_DIR, { recursive: true });

const WRITABLE_SECTIONS = {
  ai: ['enabled', 'model', 'maxTokens', 'maxRequestsPerDay', 'historyTurns', 'costNotifyQQ', 'apiKey'],
  notify: ['qqUserId', 'groupId'],
  scheduler: ['intervalSeconds'],
};

export function publicConfig() {
  return {
    ai: {
      enabled: !!config.ai?.enabled,
      model: config.ai?.model,
      maxTokens: config.ai?.maxTokens,
      maxRequestsPerDay: config.ai?.maxRequestsPerDay,
      historyTurns: config.ai?.historyTurns,
      costNotifyQQ: config.ai?.costNotifyQQ,
      hasApiKey: !!config.ai?.apiKey,
    },
    notify: { qqUserId: config.notify?.qqUserId, groupId: config.notify?.groupId || '' },
    scheduler: { intervalSeconds: config.scheduler?.intervalSeconds },
  };
}

export function saveConfigPatch(patch = {}) {
  const raw = existsSync(activePath) ? JSON.parse(readFileSync(activePath, 'utf-8')) : {};
  for (const [section, keys] of Object.entries(WRITABLE_SECTIONS)) {
    const p = patch[section];
    if (!p || typeof p !== 'object') continue;
    raw[section] = raw[section] || {};
    config[section] = config[section] || {};
    for (const key of keys) {
      if (p[key] === undefined) continue;
      if (key === 'apiKey' && String(p[key]).trim() === '') continue;
      raw[section][key] = p[key];
      config[section][key] = p[key];
    }
  }
  writeFileSync(activePath, JSON.stringify(raw, null, 2), 'utf-8');
  return publicConfig();
}

export default config;
