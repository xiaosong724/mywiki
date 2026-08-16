import config, { DATA_DIR, SERVER_DIR } from './config.mjs';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  searchEntries, getEntry, resolveEntryId, createEntry, updateEntry, deleteEntry,
  maskEntry, entrySummary, getUpcoming, listEntries, ctxVisibility, getEntryVisible, canAccessEntry,
  getByTitle,
} from './entries.mjs';
import { resolveType, resolveTypeLoose, getType, TYPES, TYPE_ALIASES } from './types.mjs';
import { registerIdentity, getIdentity } from './identities.mjs';
import { isTypeAllowed } from './groups.mjs';
import { saveTypeLabel } from './type_labels.mjs';
import { memberCan, isAdminUser } from './permissions.mjs';

const histories = new Map();

// ===== 文件型知识库（大知识域，双 md 方案）=====
// 配置：config.knowledge[type] = { mainFile(主 md，用户整体更新), dynamicFile(动态 md，QQ 前缀指令记录) }
// 查询时两个文件拼接注入 system 固定前缀：主 md 在前（稳定→缓存全命中），动态 md 在后（追加只裂末尾少量缓存）。
function knowledgeConfigFor(groupPolicy) {
  const types = groupPolicy?.allowedTypes || [];
  const hit = types
    .map((t) => ({ type: t, cfg: config.knowledge?.[t] }))
    .find((h) => h.cfg && h.cfg.mainFile);
  return hit || null;
}

export function knowledgeDynamicPath(type) {
  const rel = config.knowledge?.[type]?.dynamicFile;
  if (!rel) return null;
  return path.isAbsolute(rel) ? rel : path.resolve(SERVER_DIR, rel);
}

function ensureDynamicFile(type) {
  const dynPath = knowledgeDynamicPath(type);
  if (!dynPath) return null;
  mkdirSync(path.dirname(dynPath), { recursive: true });
  if (!existsSync(dynPath)) {
    const label = getType(type)?.label || type;
    writeFileSync(dynPath, `# ${label} · QQ 动态记录\n\n> 通过前缀指令（如 wiki3）记录的内容，追加到本文件末尾，请保持 markdown 风格一致。\n`, 'utf-8');
  }
  return dynPath;
}

function loadKnowledgeText(type) {
  const cfg = config.knowledge?.[type];
  if (!cfg?.mainFile) return '';
  const parts = [];
  try {
    const main = readFileSync(cfg.mainFile, 'utf-8');
    if (main.trim()) parts.push(`【${getType(type)?.label || type}·主文档】\n${main}`);
  } catch (err) {
    console.error(`[ai] 主知识库读取失败 ${cfg.mainFile}`, err.message);
  }
  const dynPath = knowledgeDynamicPath(type);
  if (dynPath && existsSync(dynPath)) {
    try {
      const dyn = readFileSync(dynPath, 'utf-8').trim();
      if (dyn) parts.push(`【${getType(type)?.label || type}·QQ 动态记录（追加段，与主文档冲突时以动态记录为准）】\n${dyn}`);
    } catch (err) {
      console.error(`[ai] 动态知识库读取失败 ${dynPath}`, err.message);
    }
  }
  return parts.join('\n\n');
}

// AI 变更确认注册表：user_id -> Map(code -> {kind, params, ctx, groupPolicy, expires})，10 分钟有效
const pendingOps = new Map();
const PENDING_TTL = 10 * 60 * 1000;

function registerPendingOp(userId, op) {
  const uid = String(userId);
  let m = pendingOps.get(uid);
  if (!m) {
    m = new Map();
    pendingOps.set(uid, m);
  }
  let code;
  do {
    code = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  } while (m.has(code));
  m.set(code, { ...op, expires: Date.now() + PENDING_TTL });
  if (m.size > 5) m.delete(m.keys().next().value);
  return code;
}

function takePendingOp(userId, code) {
  const m = pendingOps.get(String(userId));
  if (!m) return null;
  const hit = m.get(code);
  if (!hit) return null;
  m.delete(code);
  return hit.expires > Date.now() ? hit : null;
}

export function clearHistory(key) {
  histories.delete(key);
}

function matchPendingCode(text) {
  const m = String(text || '').match(/(?:^|\D)(\d{2})(?:\D|$)/);
  return m ? m[1] : null;
}

function executePendingOp(op) {
  const caller = getIdentity(String(op.ctx?.user_id));
  const ctx = op.ctx || {};
  const policy = op.groupPolicy || null;
  // 确认时复查权限（注册到确认之间权限可能变化；管理操作必须有管理员身份）
  switch (op.kind) {
    case 'create': {
      const p = op.params;
      if (!isTypeAllowed(policy, p.type)) return '这个群没有开启该类型的记录权限，操作已取消。';
      if (!memberCan(ctx.user_id, ctx.group_id, p.type, 'create')) return '你在本群没有该类型的记录权限，操作已取消。';
      if (ctx.message_type === 'group' && p.is_private) return '账号/私密内容请私聊我记录，群里会拒绝。';
      const e = createEntry({
        type: p.type, title: p.title, content: p.content || '',
        // 注意：create 分支注册时字段存在 params.payload（见 runTool），执行时必须读 p.payload，不能用 p.fields（那是 update 分支的键）
        payload: p.payload || {}, tags: Array.isArray(p.tags) ? p.tags : [],
        owner: p.owner || caller?.name || null,
        isPrivate: p.is_private,
        location: p.location || null,
        sourceGroup: p.sourceGroup || null,
        actor: `ai:${ctx.user_id || '?'}`,
      });
      return `已创建 #${e.id.slice(0, 8)} ${entrySummary(maskEntry(e))}`;
    }
    case 'update': {
      const p = op.params;
      const cur = getEntry(p.id);
      if (!cur) return '条目不存在或已删除。';
      if (!canAccessEntry(cur, ctx)) return '条目不存在或已删除，操作已取消。';
      if (!isTypeAllowed(policy, cur.type)) return '条目不存在或已删除，操作已取消。';
      if (!memberCan(ctx.user_id, ctx.group_id, cur.type, 'update')) return '条目不存在或已删除，操作已取消。';
      const e = updateEntry(p.id, {
        payload: p.fields || {}, content: p.content, location: p.location,
        tags: Array.isArray(p.tags) ? p.tags : undefined,
      }, `ai:${ctx.user_id || '?'}`);
      return `已更新 #${p.id.slice(0, 8)} ${entrySummary(maskEntry(e))}`;
    }
    case 'delete': {
      const cur = getEntry(op.params.id);
      if (!cur) return '条目不存在或已删除。';
      if (!canAccessEntry(cur, ctx)) return '条目不存在或已删除，操作已取消。';
      if (!isTypeAllowed(policy, cur.type)) return '条目不存在或已删除，操作已取消。';
      if (!memberCan(ctx.user_id, ctx.group_id, cur.type, 'delete')) return '条目不存在或已删除，操作已取消。';
      const e = deleteEntry(op.params.id, `ai:${ctx.user_id || '?'}`);
      return `已删除 #${op.params.id.slice(0, 8)} ${e.title}`;
    }
    case 'rename_type': {
      if (!isAdminUser(ctx.user_id)) return '改分类名是管理操作，仅管理员可用，操作已取消。';
      const r = saveTypeLabel(op.params.typeKey, op.params.label);
      return `已把分类改名为「${r.label}」。`;
    }
    case 'append_knowledge': {
      const p = op.params;
      if (!isTypeAllowed(policy, p.type)) return '这个群没有开启该类型的记录权限，操作已取消。';
      if (!memberCan(ctx.user_id, ctx.group_id, p.type, 'create')) return '你在本群没有该类型的记录权限，操作已取消。';
      const dynPath = ensureDynamicFile(p.type);
      if (!dynPath) return '该类型没有配置动态知识库文件，操作已取消。';
      try {
        appendFileSync(dynPath, `\n${p.content.trim()}\n`, 'utf-8');
        return `已追加到修仙知识库动态记录 ✅\n${p.content.trim().slice(0, 300)}`;
      } catch (err) {
        return `写入知识库文件失败：${err.message}`;
      }
    }
    case 'edit_knowledge': {
      const p = op.params;
      if (!isTypeAllowed(policy, p.type)) return '这个群没有开启该类型的修改权限，操作已取消。';
      if (!memberCan(ctx.user_id, ctx.group_id, p.type, 'update')) return '你在本群没有该类型的修改权限，操作已取消。';
      const dynPath = knowledgeDynamicPath(p.type);
      if (!dynPath) return '该类型没有配置动态知识库文件，操作已取消。';
      try {
        const cur = readFileSync(dynPath, 'utf-8');
        if (!cur.includes(p.oldText)) return '未在动态知识库中找到与 old_text 完全匹配的内容（可能已被修改），操作已取消。';
        writeFileSync(dynPath, cur.replace(p.oldText, p.newText), 'utf-8');
        return '已修改修仙知识库动态记录 ✅';
      } catch (err) {
        return `写入知识库文件失败：${err.message}`;
      }
    }
    default:
      return '确认操作无效或已过期，请重新发起。';
  }
}

// 命令/消息入口兜底：识别两位确认码并执行待确认操作
export function consumePendingOp(userId, text) {
  const code = matchPendingCode(text);
  if (!code) return null;
  const op = takePendingOp(userId, code);
  if (!op) return null;
  return executePendingOp(op);
}

// 单价（元 / 百万 tokens）：按 DeepSeek 2026-05 永久降价后价格，可在 config.ai.pricing 覆盖
const DEFAULT_PRICING = {
  'deepseek-chat': { inputCacheHitPerMillion: 0.02, inputPerMillion: 1, outputPerMillion: 2 },
  'deepseek-reasoner': { inputCacheHitPerMillion: 0.025, inputPerMillion: 3, outputPerMillion: 6 },
};
const PRICING = {
  ...DEFAULT_PRICING,
  ...(config.ai?.pricing || {}),
};

const usagePath = path.join(DATA_DIR, 'usage.json');
const usage = {
  day: '',
  dayRequests: 0,
  dayTokens: 0,
  dayCostYuan: 0,
  totalRequests: 0,
  totalTokens: 0,
  totalCostYuan: 0,
};

function loadUsage() {
  try {
    if (existsSync(usagePath)) {
      Object.assign(usage, JSON.parse(readFileSync(usagePath, 'utf-8')));
    }
  } catch { /* 损坏则重置 */ }
}

function saveUsage() {
  try {
    writeFileSync(usagePath, JSON.stringify(usage, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ai] 用量保存失败', err.message);
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

loadUsage();
if (usage.day !== todayStr()) {
  usage.day = todayStr();
  usage.dayRequests = 0;
  usage.dayTokens = 0;
  usage.dayCostYuan = 0;
  saveUsage();
}

// 余额缓存（30s），避免每次都打余额接口
let balanceCache = { ts: 0, data: null };

async function fetchBalance() {
  if (Date.now() - balanceCache.ts < 30000) return balanceCache.data;
  const base = String(config.ai?.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${config.ai.apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const info = (data.balance_infos || []).find((b) => b.currency === 'CNY') || (data.balance_infos || [])[0];
    balanceCache = {
      ts: Date.now(),
      data: info
        ? { currency: info.currency, available: Number(info.total_balance), isAvailable: data.is_available }
        : null,
    };
    return balanceCache.data;
  } catch {
    return null;
  }
}

// 费用报告回调：由 main.mjs 注入（发私聊给 costNotifyQQ）
let costReporter = null;
export function setCostReporter(fn) {
  costReporter = fn;
}

function calcCost(usageData, modelKey) {
  const p = PRICING[modelKey] || PRICING['deepseek-chat'];
  const prompt = usageData.prompt_tokens || 0;
  const completion = usageData.completion_tokens || 0;
  const hit = usageData.prompt_cache_hit_tokens || 0;
  const miss = usageData.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit);
  const inputCost = (hit * p.inputCacheHitPerMillion + miss * p.inputPerMillion) / 1e6;
  const outputCost = (completion * p.outputPerMillion) / 1e6;
  return { yuan: inputCost + outputCost, prompt, completion, hit, miss };
}

// 类型覆盖范围说明：让 AI 知道各类型 key 实际包含什么内容，避免误判"不可用"
const TYPE_GUIDE = {
  minecraft_mod: '修仙模组：包含 丹药、丹方、药材、矿石、妖丹、妖兽、灵宠、境界、五行能力、指令、更新公告、玩家指南 等 Minecraft 修仙 Addon 内容',
  computer_knowledge: '电脑文件知识：电脑/文件/路径/软件/系统相关',
  account: '账号信息：平台账号密码（默认私密）',
  note: '备忘提示：备忘、杂事、待办，可带日期提醒（fields.date 如"明天8:30"/"周五晚上8点"/"一分钟后"/"半小时后"，fields.time 可选，advance_days 提前天数，repeat_yearly 每年重复）',
  food_expiry: '食品过期：食物与过期时间',
  item_location: '物品位置：物品放在哪里',
  birthday: '家人生日：支持农历',
  travel: '旅行记录',
  help: '使用帮助：使用手册',
};

const SYSTEM_PROMPT = [
  '你是个人知识库助手，运行在一个自建 wiki 系统里。',
  '你能调用工具搜索、创建、修改、删除知识库条目，以及查询提醒。',
  '规则：',
  '1. 回答简洁，默认用中文。',
  '2. 账号密码默认脱敏（工具已脱敏），不要编造不存在的记录。',
  '3. 删除流程：先调用 delete_entry(id, confirmed:false) 获取两位确认码，把「确认删除 <两位码>」原样转告用户。用户回复"删除/确认删除/删除第N条"即视为确认：若用户说的是两位确认码，把它放进 code 参数（不要当 id）；若用户说第N条，把它映射为你上一条消息列出的第N个条目 id。确认时调用 delete_entry 且 confirmed:true。不要发明两段式确认。',
  '3. 修改流程：任何 create_entry / update_entry / delete_entry / rename_type 工具都会返回「需要确认… #<两位码>」。你必须把这条确认信息原样转告用户，等用户回复两位码或「确认XX <两位码>」后再处理；不要自行声称已执行。',
  '3b. 严禁凭空宣称操作成功：只有用户回复两位码后由系统执行，工具本身不会直接完成写入。',
  '4. 用户没明说类型时，根据内容猜测最合适的类型（模组/知识/账号/琐事/食物/位置/生日/旅行），实在判断不了就填 note；调用 create_entry 一定要带 type，不要留空。',
  '5. 身份：每个 QQ 号可登记一个名字。用户报名字（"我叫/我的名字是/我是 XX"）时调用 register_identity 登记。',
  '6. 回复时用当前说话人的名字称呼他；"我的XX"表示该说话人名下的条目，搜索时 owner 填他的名字。',
  '7. 农历生日：用户说农历生日时（如"1995农历7月24"），birthday 条目的 birth_date 填月-日（07-24）、lunar 填 true、birth_year 填年份。',
  '8. 隐私：私密条目（账号类默认私密）只能由归属人本人在私聊中查看/修改，群里绝不显示；用户要求查看密码等私密内容时提示"请私聊我"。',
  '9. 用户问"怎么用/如何使用/有哪些命令/怎么记"时，用 search_knowledge 搜索 type=help 的条目（关键词如 使用手册、命令）来回答。',
  '10. 标签：用户说"标签是/标记为/分类为 XX（可多个）"时，在创建或修改条目时用 tags 数组设置，不要把标签塞进 fields；用户问"标签是XX的有哪些"时，search_knowledge 用 tags 过滤。',
  '11. Minecraft/修仙等游戏玩法、设定、概率、规则类问题：search_knowledge 优先加 kind="guide"（玩家指南按章节存的内容最准确），再结合具体条目回答。',
  '12. 用户说“把XX分类改名为YY/把某类型名字改成YY”时，调用 rename_type 工具。',
  '13. 群聊有可用类型限制时，只围绕可用类型回答。特别注意：minecraft_mod（修仙模组）包含 丹药、丹方、药材、矿石、妖丹、妖兽、灵宠、境界、五行能力、指令、更新公告、玩家指南 等内容，用户记录/询问这些修仙内容时都属于 minecraft_mod，可以正常处理（不要误判为不可用）。只有内容确实不属于任何可用类型时，才回复“本群只能使用：<可用类型>，不能处理<请求的类型>”，不要建议记录/查询不可用类型，也不要调用工具操作不可用类型。',
  '14. 创建条目时标题取物品/主题名本身：用户说“丹药补天丹”时标题填“补天丹”，不要把药效/描述/备注拼进标题。用户消息里的所有信息都要保存、不能丢失：药效/效果→fields.effect 或 features，配方→fields.recipe，备注/状态（如“功能暂未实现待开发”）→content 或 fields.usage；minecraft_mod 的 fields.kind 填子类型（丹药/丹方/药材/矿石/妖丹/妖兽/灵宠/境界/五行能力/指令/更新公告/玩家指南）。',
  '15. 查询时同一个主题有多个条目（同名/同主题的不同版本，可能由不同人提供、内容不同）时，要如实告诉用户存在多个版本，逐一列出每个版本的 id 和提供者并给出内容要点；不要只挑一个回答，也不要自行合并或编造。示例：「补天丹有 2 个版本：① #e1b11992（提供：FG）：…；② #xxxxxx（提供：SY）：…」；提供者为空/系统时写“系统”。',
  '16. 时间/提醒意图判断：用户说“提醒我/记得/别忘了/到点/交房租/缴费/纪念日/下周三/周五/3号/明天8点半/一分钟后/半小时后”等带时间或提醒意图的内容时，用 note（备忘提示）类型，fields.date 填日期（今天/明天/N天后/X月X日/周X/X号/YYYY-MM-DD，可带时间如“明天8:30”“周五晚上8点”；也支持相对时间“一分钟后/半小时后/2小时后/1小时30分钟后”，表示当前时间加偏移），时间也可单独填 fields.time（如“08:30”“下午3点”）；fields.advance_days 提前提醒天数（默认 0=到点提醒），每年重复用 fields.repeat_yearly=true。用户没给日期时先问清楚日期，不要创建没有日期的提醒条目。纯备忘（无时间）也用 note，不填日期即可。',
  '17. 查询没有结果时直接回答“没有找到相关条目”，不要暗示“可能有但被隐藏”，不要透露被权限过滤掉的内容数量或存在；用户问的内容不在本群可用类型内时，只按规则 13 简单说明本群可用类型，不要列举或暗示不可用类型里存了什么。',
  '18. 记录物品/位置（用户说“XX放在哪里/我的XX在哪/帮我记XX的位置”）时用 item_location 类型：location 参数填位置（如"床头柜第二层"），不要放进 fields（item_location 只有 quantity 字段，其它字段会被丢弃），补充说明可放 content。用户提供的位置信息不能丢失。',
  '19. 同名条目已存在且是空记录时，服务端会直接给出“确认修改 XX”把信息补充进旧条目，按提示把确认码转告用户即可，不要重复新建。',
  '20. 用户按分类名查询（如“我的备忘提示”“看看提醒”“模组里有什么”）时，search_knowledge 的 query 填具体内容关键词（如“铲猫砂”）或留空，type/owner 参数负责分类过滤；不要把分类名/别名（备忘、备忘提示、琐事、提醒、模组、修仙模组等）当作 query 关键词，否则会搜不到。',
  '21. 列出多条条目时，除了标题和 id，还要带上每条的内容要点、位置、提醒时间等关键信息（搜索结果里都有），不要只列标题，也不要自行概括成“待办事项”这类空洞标签；内容为空就写“（无内容）”。',
  '22. 记录备忘/提醒（note）时，content 填用户发的那句话原文（原封不动，包括"提醒我/记得"等字眼），不要留空、不要改写。例：用户说"明天12点记得提醒我冲电费"→ title=冲电费，fields.date=明天12点，content="明天12点记得提醒我冲电费"。',
].join('\n');

function callerNote(msg) {
  const id = getIdentity(String(msg.user_id));
  return id
    ? `【当前说话人】${id.name}（QQ ${msg.user_id}）`
    : `【当前说话人】未登记身份（QQ ${msg.user_id}）。如果对方报出了名字，用 register_identity 登记。`;
}

function inferTypeFromText(s) {
  const text = String(s || '');
  if (/过期|食品|食物|牛奶|面包|菜|冷藏/.test(text)) return 'food_expiry';
  if (/生日|农历|几岁/.test(text)) return 'birthday';
  if (/账号|密码|平台|登录|注册/.test(text)) return 'account';
  if (/放在|位置|哪里|钥匙|物品|东西放/.test(text)) return 'item_location';
  if (/模组|我的世界|minecraft|mc|妖兽|炼丹|丹药|丹方|药材|妖丹|灵宠|境界|修仙|功法|灵石|修士/.test(text)) return 'minecraft_mod';
  if (/电脑|文件|路径|软件|系统|代码|配置/.test(text)) return 'computer_knowledge';
  if (/旅行|旅游|去过|地方|景点/.test(text)) return 'travel';
  return 'note';
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '搜索知识库条目，返回匹配的条目列表（敏感字段已脱敏）',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          type: { type: 'string', description: '可选的类型过滤：minecraft_mod（修仙模组，含 丹药/丹方/妖兽/灵宠/境界 等）、computer_knowledge、account、note（备忘提示）、food_expiry、item_location、birthday、travel。用户问修仙内容（丹药/丹方/妖兽/灵宠/境界等）时填 minecraft_mod' },
          owner: { type: 'string', description: '归属人姓名。用户问"我的XX"时填当前说话人的名字，否则不填' },
          tags: { type: 'array', items: { type: 'string' }, description: '按标签过滤（可多个，用户问"标签是XX"时填）' },
          kind: { type: 'string', description: '条目子类型过滤。问游戏玩法/数值设定/规则时填 guide，问具体物品/配方/指令时可不填' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_entry',
      description: '获取单个条目详情（敏感字段已脱敏）',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '条目 id 或 id 前缀' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_entry',
      description: '创建一条知识库记录。type 是类型 key：minecraft_mod（修仙模组：含 丹药/丹方/药材/矿石/妖丹/妖兽/灵宠/境界/五行能力/指令/更新公告/玩家指南，fields.kind 填子类型如 丹药/丹方/妖兽，可填配方 recipe、效果 effect、最高品阶 max_quality 等字段）、computer_knowledge（电脑文件知识）、account（账号，默认私密）、note（备忘提示：备忘/杂事/待办/提醒，带时间意图时 fields.date 必填（如"明天8:30"/"周五晚上8点"/"一分钟后"/"半小时后"/"2026-08-20"，也可单独 fields.time 如"08:30"），fields.advance_days 提前提醒天数，fields.repeat_yearly 每年重复）、food_expiry（食品过期）、item_location（物品位置）、birthday（家人生日）、travel（旅行）。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '类型：minecraft_mod/computer_knowledge/account/note/food_expiry/item_location/birthday/travel（见上方说明，记录丹药/丹方/妖兽/灵宠/境界等修仙内容填 minecraft_mod；带时间/提醒意图的内容填 note）' },
          title: { type: 'string', description: '标题' },
          content: { type: 'string', description: '正文内容' },
          fields: { type: 'object', description: '类型专属字段，如 {expire_date:"2026-07-20", advance_days:1}；minecraft_mod 可填 kind 子类型（丹药/丹方/药材/矿石/妖丹/妖兽/灵宠/境界/五行能力/指令/更新公告/玩家指南）和 recipe/effect/max_quality 等' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表，如 ["家人","重要"]；用户提到标签时填这里' },
          owner: { type: 'string', description: '归属人姓名，不填默认当前说话人' },
          location: { type: 'string', description: '存放位置，如"床头柜第二层"。用户说物品"放在/在哪里/XX在哪"时必填，不要放进 fields（item_location 只有 quantity 字段，其它字段会被丢弃）' },
          is_private: { type: 'boolean', description: '是否私密（仅归属人私聊可见），账号类默认私密；群里拒绝创建私密条目' },
        },
        required: ['type', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_entry',
      description: '修改已有条目',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目 id 或 id 前缀' },
          fields: { type: 'object', description: '要修改的类型专属字段' },
          tags: { type: 'array', items: { type: 'string' }, description: '新的标签列表（用户要改标签时填）' },
          content: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_entry',
      description: '删除条目。第一次调用：只填 id，confirmed=false，服务端返回两位确认码。用户明确确认后：把两位确认码填到 code，confirmed=true 再次调用',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目 id 前缀（第一次发起删除时填）' },
          code: { type: 'string', description: '两位确认码（用户回复"确认删除 XX"时，XX 填这里）' },
          confirmed: { type: 'boolean', description: '用户是否已明确说"删除/确认删除/删除第N条"' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_type',
      description: '修改一个 wiki 类型的显示名称（需要两位确认码）',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '类型 key 或名称，如 minecraft_mod / 模组 / Minecraft 模组' },
          label: { type: 'string', description: '新的显示名称，如 修仙模组' },
        },
        required: ['type', 'label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_identity',
      description: '登记当前说话人的身份（QQ 号绑定一个名字）',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '用户报出的名字' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: '查询未来 N 天内的提醒事项',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: '天数，默认 7' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_knowledge',
      description: '把新内容追加到修仙模组知识库的动态记录文件末尾（记录新物品/新丹药/新指令等【新增】内容时用，追加到文件末尾对缓存最友好）。需要用户回复确认码后执行',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要追加的 markdown 文本，风格与知识库一致（表格或列表），包含小节标题行' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_knowledge',
      description: '修改修仙模组知识库动态记录中【已有】的段落（更新既有内容时用）。新增内容请用 append_knowledge。需要用户回复确认码后执行',
      parameters: {
        type: 'object',
        properties: {
          old_text: { type: 'string', description: '文件中要替换的原文片段，必须与文件内容完全一致（用于唯一定位）' },
          new_text: { type: 'string', description: '替换后的新文本' },
        },
        required: ['old_text', 'new_text'],
      },
    },
  },
];

export function aiConfigured() {
  return !!config.ai?.enabled && !!config.ai?.apiKey;
}

function historyKey(msg) {
  return `${msg.message_type || 'private'}:${msg.group_id || msg.user_id || '?'}`;
}

function checkBudget() {
  const today = todayStr();
  if (usage.day !== today) {
    usage.day = today;
    usage.dayRequests = 0;
    usage.dayTokens = 0;
    usage.dayCostYuan = 0;
  }
  if (usage.dayRequests >= (config.ai.maxRequestsPerDay || 200)) {
    throw new Error('今日 AI 调用次数已到上限');
  }
}

function runTool(name, args, ctx, groupPolicy) {
  const caller = getIdentity(String(ctx.user_id));
  switch (name) {
    case 'search_knowledge': {
      const type = resolveType(args.type || '');
      const vis = ctxVisibility(ctx);
      // 去掉 query 里的"类型词"（分类名/别名/类型 key）：用户说"我的备忘提示"时，备忘提示/备忘不是内容关键词
      const typeWords = new Set();
      for (const [k, t] of Object.entries(TYPES)) {
        typeWords.add(k);
        typeWords.add(getType(k)?.label || t.label);
      }
      for (const alias of Object.keys(TYPE_ALIASES)) typeWords.add(alias);
      const rawQ = String(args.query || '').trim();
      const q = rawQ
        ? rawQ.split(/\s+|[,，、]/).filter(Boolean).filter((tok) => !typeWords.has(tok)).join(' ')
        : '';
      let tagsFilter = Array.isArray(args.tags) ? args.tags.join(',') : args.tags;
      if (!tagsFilter) {
        const tagMatch = String(args.query || '').match(/标签(?:是|为|[:=＝])?\s*[「"'']?([^\s,，"'」]+)/);
        if (tagMatch) tagsFilter = tagMatch[1];
      }
      const kindFilter = args.kind ? String(args.kind) : '';
      const limit = kindFilter === 'guide' ? 3 : 10;
      let list = listEntries({
        q: q || undefined, limit,
        visibility: vis.visibility, owner: args.owner || undefined,
        tags: tagsFilter, kind: kindFilter || undefined,
      });
      // 只要涉及 Minecraft 模组，或模型忘了指定 kind，都把 guide 条目并进来
      if (type === 'minecraft_mod' || !kindFilter || kindFilter === 'guide') {
        const guide = listEntries({
          q: args.query || '', limit: 3,
          visibility: vis.visibility, kind: 'guide',
        });
        const seen = new Set(list.map((e) => e.id));
        for (const g of guide) {
          if (!seen.has(g.id)) { list.unshift(g); seen.add(g.id); }
        }
      }
      let filtered = list.filter((e) => isTypeAllowed(groupPolicy, e.type) && memberCan(ctx.user_id, ctx.group_id, e.type, 'read'));
      filtered = type ? filtered.filter((e) => e.type === type) : filtered;
      if (!filtered.length) {
        // 权限关闭 = 完全隐形：不透露存在被过滤的内容
        return '没有找到匹配的条目';
      }
      return filtered.map((e) => `#${e.id.slice(0, 8)} ${entrySummary(maskEntry(e))}`).join('\n');
    }
    case 'get_entry': {
      const id = resolveEntryId(args.id);
      if (!id) return '条目不存在';
      const e = getEntryVisible(id, ctx);
      if (!e) return '条目不存在';
      if (!isTypeAllowed(groupPolicy, e.type)) return '条目不存在';
      if (!memberCan(ctx.user_id, ctx.group_id, e.type, 'read')) return '条目不存在';
      const m = maskEntry(e);
      const lines = [`#${id} [${m.type}] ${m.title}`];
      if (m.type === 'minecraft_mod') lines.push(`提供：${m.owner || '系统'}`);
      for (const [k, v] of Object.entries(m.payload)) if (v !== '' && v != null) lines.push(`${k}: ${v}`);
      if (m.content) lines.push(`内容: ${m.content}`);
      if (m.location) lines.push(`位置: ${m.location}`);
      if (m.remindAt) lines.push(`提醒: ${m.remindAt}`);
      return lines.join('\n');
    }
    case 'create_entry': {
      let type = resolveType(args.type || '');
      if (!type) {
        type = inferTypeFromText(`${args.title || ''} ${args.content || ''} ${JSON.stringify(args.fields || {})}`);
      }
      if (!type) return '请告诉我要记录的类型（模组/知识/账号/琐事/食物/位置/生日/旅行），我再记。';
      if (!isTypeAllowed(groupPolicy, type)) return '这个群没有开启该类型的记录权限';
      if (!memberCan(ctx.user_id, ctx.group_id, type, 'create')) return '你在本群没有该类型的记录权限';
      const wantPrivate = args.is_private !== undefined ? !!args.is_private : type === 'account';
      if (ctx.message_type === 'group' && wantPrivate) {
        return '账号/私密内容请私聊我记录，群里会拒绝';
      }
      // 重复判断：同名条目已存在时告知用户；内容相同则拒绝重复记录，内容不同则作为多版本并存
      const title = String(args.title || '').trim();
      const norm = (s) => String(s || '').replace(/[\s，。,、：:；;！!？?（）()]/g, '');
      const params = {
        type, title,
        content: args.content || '',
        payload: args.fields || {},
        tags: Array.isArray(args.tags) ? args.tags : [],
        owner: args.owner || caller?.name || null,
        isPrivate: wantPrivate,
        location: args.location ? String(args.location).trim() : null,
        sourceGroup: ctx.group_id ? String(ctx.group_id) : null,
      };
      // 备忘提示（note）必须有日期才有提醒：用户消息含时间/提醒意图但 AI 没填 date/time 时，强制补填
      if (type === 'note' && !params.payload?.date && !params.payload?.time) {
        const hasTimeIntent = /提醒|记得|别忘了|到点|交房租|缴费|纪念日|今天|明天|后天|周[一二三四五六日天]|下周|\d+号|\d+月\d+日|\d{1,2}[:：]\d{1,2}|点半|分钟后|小时后|(上午|早上|凌晨|中午|下午|晚上)\s*\d{1,2}点/.test(String(ctx.text || ''));
        if (hasTimeIntent) {
          return '用户消息包含时间/提醒意图，note（备忘提示）的 fields.date 必须填一个能解析的日期（如"明天8:30"/"周五晚上8点"/"2026-08-20"，时间也可单独填 fields.time 如"08:30"）。请带上 fields.date 重新调用 create_entry；若用户没说具体时间，先向用户询问。';
        }
      }
      // 备忘提示（note）的 content 应为用户原话：AI 没填 content 时强制补填
      if (type === 'note' && !params.content) {
        const orig = String(ctx.text || '').trim();
        if (orig) {
          return `note（备忘提示）的 content 应填用户发的那句话原文（原封不动），用户说的是："${orig.slice(0, 60)}"。请把 content 设为用户原话后重新调用 create_entry。`;
        }
      }
      const dupes = getByTitle(type, title);
      if (dupes.length) {
        const same = dupes.filter(
          (d) => norm(d.content) === norm(params.content)
            && JSON.stringify(d.payload) === JSON.stringify(params.payload)
            && (d.location || '') === (params.location || '')
        );
        if (same.length) {
          return `知识库已有相同的「${title}」条目（#${same[0].id.slice(0, 8)}，提供：${same[0].owner || '系统'}），内容相同，无需重复记录。`;
        }
        // 同名旧记录是空壳（无位置/无内容/无字段）且新记录有信息 → 直接注册"修改"把信息补充进旧条目，避免新建重复条目
        const placeholder = dupes.find((d) => !d.content && !d.location && Object.keys(d.payload || {}).length === 0);
        if (placeholder) {
          const up = { id: placeholder.id };
          if (Object.keys(params.payload || {}).length) up.fields = params.payload;
          if (params.content) up.content = params.content;
          if (params.location) up.location = params.location;
          if (params.tags?.length) up.tags = params.tags;
          const code = registerPendingOp(ctx.user_id, { kind: 'update', params: up, ctx, groupPolicy });
          return `同名「${title}」已存在 #${placeholder.id.slice(0, 8)}（当前是空记录，没有位置/内容）。将把新信息补充进这条旧记录，需要确认修改 #${code}。请用户回复：确认修改 ${code}`;
        }
        const dupNote = `【注意】知识库已有 ${dupes.length} 条同名「${title}」：${dupes.map((d) => `#${d.id.slice(0, 8)}（提供：${d.owner || '系统'}）`).join('、')}。内容不同将新增为另一个版本。`;
        const code = registerPendingOp(ctx.user_id, { kind: 'create', params, ctx, groupPolicy });
        return `需要确认创建 #${code}「${title}」。${dupNote}\n请用户回复：确认创建 ${code}`;
      }
      const code = registerPendingOp(ctx.user_id, { kind: 'create', params, ctx, groupPolicy });
      return `需要确认创建 #${code}「${title}」。请用户回复：确认创建 ${code}`;
    }
    case 'register_identity': {
      const r = registerIdentity(ctx.user_id, args.name, `ai:${ctx.user_id || '?'}`);
      return `已登记：QQ ${r.qq_id} = ${r.name}`;
    }
    case 'update_entry': {
      const id = resolveEntryId(args.id);
      if (!id) return '条目不存在';
      const cur = getEntry(id);
      if (!canAccessEntry(cur, ctx)) return '条目不存在或已删除';
      if (!isTypeAllowed(groupPolicy, cur.type)) return '条目不存在或已删除';
      if (!memberCan(ctx.user_id, ctx.group_id, cur.type, 'update')) return '条目不存在或已删除';
      const params = {
        id,
        fields: args.fields || {},
        content: args.content,
        location: args.location,
        tags: Array.isArray(args.tags) ? args.tags : undefined,
      };
      const code = registerPendingOp(ctx.user_id, { kind: 'update', params, ctx, groupPolicy });
      return `需要确认修改 #${code}「${cur.title}」。请用户回复：确认修改 ${code}`;
    }
    case 'delete_entry': {
      const id = resolveEntryId(args.id);
      if (!id) return '条目不存在';
      const cur = getEntry(id);
      if (!canAccessEntry(cur, ctx)) return '条目不存在或已删除';
      if (!isTypeAllowed(groupPolicy, cur.type)) return '条目不存在或已删除';
      if (!memberCan(ctx.user_id, ctx.group_id, cur.type, 'delete')) return '条目不存在或已删除';
      const code = registerPendingOp(ctx.user_id, { kind: 'delete', params: { id }, ctx, groupPolicy });
      return `需要确认删除 #${code}「${cur.title}」。请用户回复：确认删除 ${code}`;
    }
    case 'rename_type': {
      if (!isAdminUser(ctx.user_id)) return '改分类名是管理操作，仅管理员可用。';
      const typeKey = resolveTypeLoose(args.type || '');
      if (!typeKey) return '请告诉我要改名的类型（模组/知识/账号/琐事/日期/食物/位置/生日/旅行）。';
      const label = String(args.label || '').trim();
      if (!label) return '新名称不能为空。';
      const code = registerPendingOp(ctx.user_id, { kind: 'rename_type', params: { typeKey, label }, ctx, groupPolicy });
      return `需要确认改名 #${code}（${typeKey} → ${label}）。请用户回复：确认改名 ${code}`;
    }
    case 'list_reminders': {
      const list = getUpcoming(Number(args.days) || 7, 20).filter((e) => isTypeAllowed(groupPolicy, e.type) && memberCan(ctx.user_id, ctx.group_id, e.type, 'read')).slice(0, 8);
      if (!list.length) return '未来几天没有提醒';
      return list.map((e) => `#${e.id.slice(0, 8)} ${entrySummary(maskEntry(e))}`).join('\n');
    }
    case 'append_knowledge': {
      const kb = knowledgeConfigFor(groupPolicy);
      if (!kb) return '当前触发的类型没有配置知识库文件，无法追加。';
      if (!memberCan(ctx.user_id, ctx.group_id, kb.type, 'create')) return '你在本群没有该类型的记录权限';
      const content = String(args.content || '').trim();
      if (!content) return '内容不能为空，请提供要追加的 markdown 文本。';
      const code = registerPendingOp(ctx.user_id, { kind: 'append_knowledge', params: { type: kb.type, content }, ctx, groupPolicy });
      return `需要确认追加 #${code} 到修仙知识库动态记录：\n${content.slice(0, 200)}\n请用户回复：确认追加 ${code}`;
    }
    case 'edit_knowledge': {
      const kb = knowledgeConfigFor(groupPolicy);
      if (!kb) return '当前触发的类型没有配置知识库文件，无法修改。';
      if (!memberCan(ctx.user_id, ctx.group_id, kb.type, 'update')) return '你在本群没有该类型的修改权限';
      const oldText = String(args.old_text || '').trim();
      const newText = String(args.new_text || '').trim();
      if (!oldText || !newText) return 'old_text 和 new_text 都不能为空。';
      const code = registerPendingOp(ctx.user_id, { kind: 'edit_knowledge', params: { type: kb.type, oldText, newText }, ctx, groupPolicy });
      return `需要确认修改 #${code} 修仙知识库动态记录（原文：${oldText.slice(0, 100)}）。请用户回复：确认修改 ${code}`;
    }
    default:
      return `未知工具: ${name}`;
  }
}

async function callLLM(messages) {
  const base = String(config.ai.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.ai.model || 'deepseek-chat',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: config.ai.maxTokens || 800,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data;
}

export async function aiChat(msg) {
  if (!aiConfigured()) return null;
  checkBudget();
  const key = historyKey(msg);
  let hist = histories.get(key) || [];
  let userContent = `${callerNote(msg)}\n\n${msg.text}`;
  if (msg.groupPolicy?.allowedTypes?.length) {
    const labels = msg.groupPolicy.allowedTypes
      .map((k) => `${getType(k)?.label || k}（${k}）${TYPE_GUIDE[k] ? '：' + TYPE_GUIDE[k] : ''}`)
      .join('；');
    userContent += `\n\n【本群可用类型】${labels}。只能在这些类型范围内搜索/记录/修改/删除。特别注意：修仙模组(minecraft_mod) 包含 丹药/丹方/药材/矿石/妖丹/妖兽/灵宠/境界/五行能力/指令/更新公告 等，用户记录或询问这些内容时属于修仙模组，可以正常处理。用户问的内容如果不属于这些类型，请直接回复“本群只能使用：<可用类型>，不能处理<用户请求的类型>”，不要提供其它类型的记录/查询建议，也不要调用工具操作其它类型。`;
  }
  // 前缀触发的文件型知识库：全文注入 system 固定前缀（前缀稳定→缓存命中），AI 直接依据全文回答
  const kb = msg.groupPolicy?.mode === 'prefix' ? knowledgeConfigFor(msg.groupPolicy) : null;
  let systemContent = SYSTEM_PROMPT;
  if (kb) {
    const kbText = loadKnowledgeText(kb.type);
    if (kbText) {
      const label = getType(kb.type)?.label || kb.type;
      systemContent += `\n\n【${label} 知识库全文（已提供，必读）】以下是${label}的完整知识库。回答该类型问题请直接依据此全文（动态记录段优先于主文档）。不要为${label}内容调用 search_knowledge（搜索工具只用于其他类型）。用户要求记录/修改该类型内容时：新增内容用 append_knowledge（追加到文件末尾，对缓存最友好），更新已有内容用 edit_knowledge；两者都需要用户回复确认码后才执行，不要声称已写入。\n${kbText}`;
    }
  }
  let msgs = [
    { role: 'system', content: systemContent },
    ...hist,
    { role: 'user', content: userContent },
  ];
  let reply = '';
  let turnCost = 0;
  let turnTokens = 0;
  let turnInput = 0;
  let turnOutput = 0;
  let lastToolOut = '';
  for (let i = 0; i < 4; i += 1) {
    const data = await callLLM(msgs);
    const choice = data.choices?.[0];
    const m = choice?.message;
    if (!m) break;
    if (data.usage) {
      const cost = calcCost(data.usage, config.ai.model);
      turnCost += cost.yuan;
      turnTokens += (data.usage.total_tokens || 0);
      turnInput += cost.prompt;
      turnOutput += cost.completion;
      usage.dayRequests += 1;
      usage.dayTokens += (data.usage.total_tokens || 0);
      usage.dayCostYuan += cost.yuan;
      usage.totalRequests += 1;
      usage.totalTokens += (data.usage.total_tokens || 0);
      usage.totalCostYuan += cost.yuan;
      saveUsage();
    }
    if (m.tool_calls?.length) {
      msgs = [...msgs, { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls }];
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
        let out;
        try {
          out = runTool(tc.function?.name, args, msg, msg.groupPolicy);
        } catch (err) {
          out = `工具执行失败: ${err.message}`;
        }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: out });
        lastToolOut = out;
      }
      continue;
    }
    reply = m.content || '';
    break;
  }
  if (!reply && lastToolOut) reply = lastToolOut;
  if (!reply) reply = '（AI 没有返回内容，请换个说法重试）';
  hist.push({ role: 'user', content: msg.text }, { role: 'assistant', content: reply });
  const maxMsgs = (config.ai.historyTurns || 6) * 2;
  if (hist.length > maxMsgs) hist = hist.slice(hist.length - maxMsgs);
  histories.set(key, hist);

  // 费用与余额报告
  if (turnTokens > 0 || turnCost > 0) {
    const balance = await fetchBalance();
    const lines = [
      '💸 DeepSeek 调用',
      `模型：${config.ai.model}`,
      `本次费用：¥${turnCost.toFixed(5)}（输入 ${turnInput} / 输出 ${turnOutput} tokens）`,
      `今日累计：¥${usage.dayCostYuan.toFixed(5)}`,
    ];
    if (balance) {
      lines.push(`钱包余额：${balance.currency} ¥${balance.available.toFixed(2)}${balance.isAvailable === false ? '（余额不足）' : ''}`);
    } else {
      lines.push('钱包余额：查询失败（可到 platform.deepseek.com 查看）');
    }
    const report = lines.join('\n');
    console.log(`[ai] ${report.replace(/\n/g, ' | ')}`);
    if (costReporter) {
      try {
        await costReporter({ model: config.ai.model, costYuan: turnCost, tokens: turnTokens, balance, report });
      } catch (err) {
        console.error('[ai] 费用报告发送失败', err.message);
      }
    }
  }

  return reply;
}
