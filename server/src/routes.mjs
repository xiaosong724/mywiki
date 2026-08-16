import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WEB_DIR, SERVER_DIR } from './config.mjs';
import config, { publicConfig, saveConfigPatch } from './config.mjs';
import { TYPES, getAllTypes } from './types.mjs';
import {
  listEntries, getEntry, createEntry, updateEntry, deleteEntry,
  getDueNow, getUpcoming, recentLogs,
} from './entries.mjs';
import { handleIncoming } from './chat.mjs';
import { aiConfigured } from './ai.mjs';
import { knowledgeTypes, getKnowledge, saveMain, rollbackMain, saveDynamic, getVersionContent, searchKnowledge } from './knowledge.mjs';
import { registerIdentity, listIdentities } from './identities.mjs';
import { listBackups, createBackup, deleteBackup } from './backup.mjs';
import { listGroupConfigs, getGroupConfig, saveGroupConfig, deleteGroupConfig, matchGroupTrigger, looksLikeConfirmation } from './groups.mjs';
import { listTypeLabelOverrides, saveTypeLabel, deleteTypeLabel } from './type_labels.mjs';
import { listMemberPermissions, saveMemberPermissions, deleteMemberPermissions } from './permissions.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  if (!config.token) return true;
  const h = req.headers['x-auth-token'];
  return h === config.token || url.searchParams.get('token') === config.token;
}

export async function routes(req, res) {
  try {
    await routeImpl(req, res);
  } catch (err) {
    console.error('[http]', req.method, req.url, err);
    if (!res.headersSent) sendJSON(res, 500, { error: '服务器内部错误' });
    else {
      try { res.destroy(); } catch { /* noop */ }
    }
  }
}

async function routeImpl(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    if (!authorized(req, url)) return sendJSON(res, 401, { error: '未授权' });

    // 健康检查
    if (req.method === 'GET' && p === '/api/health') {
      return sendJSON(res, 200, {
        ok: true,
        name: 'my-wiki',
        version: '0.1.0',
        now: new Date().toISOString(),
        ai: { enabled: aiConfigured() },
      });
    }

    // QQ 机器人登录二维码（NapCat cache/qrcode.png；重启 NapCat/QQ 会更新）
    const qrPath = () => config.bot?.qrcodePath
      || path.join(SERVER_DIR, '..', 'NapCat.Shell', 'cache', 'qrcode.png');
    if (req.method === 'GET' && p === '/api/bot/qrcode') {
      try {
        const data = await readFile(qrPath());
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'Content-Length': data.length,
        });
        return res.end(data);
      } catch {
        return sendJSON(res, 404, { error: '暂无二维码图片（QQ 已登录或 NapCat 未运行）' });
      }
    }
    if (req.method === 'GET' && p === '/api/bot/qrcode/info') {
      try {
        const st = await stat(qrPath());
        return sendJSON(res, 200, { exists: true, updatedAt: st.mtime.toISOString(), size: st.size });
      } catch {
        return sendJSON(res, 200, { exists: false, updatedAt: null });
      }
    }

    // 重启 QQ/NapCat（命令在 config.bot.restartCommand，固定命令，不可注入）
    if (req.method === 'POST' && p === '/api/bot/restart') {
      const cmd = config.bot?.restartCommand;
      if (!cmd) return sendJSON(res, 400, { error: '未配置 bot.restartCommand（网页设置或 config.json）' });
      try {
        const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' });
        child.unref();
        return sendJSON(res, 200, { ok: true, msg: '重启命令已发送' });
      } catch (err) {
        return sendJSON(res, 500, { error: `重启失败：${err.message}` });
      }
    }

    // 运行配置
    if (req.method === 'GET' && p === '/api/config') {
      return sendJSON(res, 200, publicConfig());
    }
    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const updated = saveConfigPatch({
        ai: body.ai,
        notify: body.notify,
        scheduler: body.scheduler,
      });
      return sendJSON(res, 200, updated);
    }

    // 类型注册中心
    if (req.method === 'GET' && p === '/api/types') {
      return sendJSON(res, 200, { types: getAllTypes() });
    }
    if (req.method === 'GET' && p === '/api/type-labels') {
      return sendJSON(res, 200, { labels: listTypeLabelOverrides(), types: getAllTypes() });
    }
    if (req.method === 'POST' && p === '/api/type-labels') {
      const body = await readBody(req);
      const r = saveTypeLabel(body.typeKey, body.label);
      return sendJSON(res, 200, { label: r, types: getAllTypes() });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/type-labels/')) {
      const typeKey = decodeURIComponent(p.slice('/api/type-labels/'.length));
      return sendJSON(res, 200, await deleteTypeLabel(typeKey));
    }

    // 成员权限
    if (req.method === 'GET' && p === '/api/permissions') {
      return sendJSON(res, 200, { permissions: listMemberPermissions() });
    }
    if (req.method === 'POST' && p === '/api/permissions') {
      const body = await readBody(req);
      const perm = saveMemberPermissions({
        qqId: body.qqId,
        groupId: body.groupId,
        rules: body.rules,
      });
      return sendJSON(res, 201, { permission: perm });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/permissions/')) {
      const rest = decodeURIComponent(p.slice('/api/permissions/'.length)).split('/');
      return sendJSON(res, 200, await deleteMemberPermissions(rest[0], rest[1]));
    }

    // 身份
    if (req.method === 'GET' && p === '/api/identities') {
      return sendJSON(res, 200, { identities: listIdentities() });
    }
    if (req.method === 'POST' && p === '/api/identities') {
      const body = await readBody(req);
      const r = registerIdentity(body.qq_id, body.name, 'web');
      return sendJSON(res, 201, { identity: r });
    }

    // 群组权限
    if (req.method === 'GET' && p === '/api/groups') {
      return sendJSON(res, 200, { groups: listGroupConfigs() });
    }
    if (req.method === 'POST' && p === '/api/groups') {
      const body = await readBody(req);
      const cfg = saveGroupConfig({
        groupId: body.groupId,
        name: body.name,
        enabled: body.enabled,
        typeRules: body.typeRules,
        memberPrivateChat: body.memberPrivateChat,
        defaultMemberRules: body.defaultMemberRules,
      });
      return sendJSON(res, 201, { group: cfg });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/groups/')) {
      const groupId = decodeURIComponent(p.slice('/api/groups/'.length));
      return sendJSON(res, 200, await deleteGroupConfig(groupId));
    }

    // 条目列表
    if (req.method === 'GET' && p === '/api/entries') {
      const q = url.searchParams.get('q') || '';
      const type = url.searchParams.get('type') || '';
      const done = url.searchParams.get('done');
      const tags = url.searchParams.get('tags') || '';
      const limit = Number(url.searchParams.get('limit') || 100);
      const offset = Number(url.searchParams.get('offset') || 0);
      const list = listEntries({
        type: type || undefined,
        q: q || undefined,
        tags: tags || undefined,
        done: done === null ? undefined : done,
        limit, offset,
      });
      let merged = list;
      if (q) {
        // 全量知识库 md 章节并入搜索结果（权威源优先，排在 SQLite 结果前）
        const kb = searchKnowledge(q, 6).map((h) => ({
          source: 'knowledge',
          kbType: h.type, kbLabel: h.label, kbSource: h.source, kbSection: h.section,
          id: `kb:${h.type}:${h.source}:${h.section}`,
          type: h.type,
          title: `${h.section}（${h.label}${h.source === 'dynamic' ? '·动态' : ''}）`,
          content: h.snippet,
          payload: {}, tags: [], isPrivate: false,
        }));
        if (kb.length) merged = [...kb, ...list];
      }
      return sendJSON(res, 200, { entries: merged, total: merged.length });
    }

    // 到期 / 未来提醒
    if (req.method === 'GET' && p === '/api/entries/due') {
      return sendJSON(res, 200, { entries: getDueNow() });
    }
    if (req.method === 'GET' && p === '/api/upcoming') {
      const days = Number(url.searchParams.get('days') || 7);
      return sendJSON(res, 200, { entries: getUpcoming(days, 100) });
    }

    // 日志
    if (req.method === 'GET' && p === '/api/logs') {
      return sendJSON(res, 200, { logs: recentLogs(50) });
    }

    // 备份
    if (req.method === 'GET' && p === '/api/backups') {
      return sendJSON(res, 200, { backups: await listBackups() });
    }
    if (req.method === 'POST' && p === '/api/backups') {
      const b = await createBackup();
      return sendJSON(res, 201, { backup: b });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/backups/')) {
      const name = decodeURIComponent(p.slice('/api/backups/'.length));
      return sendJSON(res, 200, await deleteBackup(name));
    }

    // 全量知识库（文件型知识域）
    if (req.method === 'GET' && p === '/api/knowledge') {
      const types = knowledgeTypes();
      const list = types.map((t) => {
        const k = getKnowledge(t);
        return { type: t, label: k.label, mainSize: k.main.length, dynamicSize: k.dynamic.length, versions: k.versions.length };
      });
      return sendJSON(res, 200, { types: list });
    }
    const kbVerMatch = p.match(/^\/api\/knowledge\/([^/]+)\/versions\/([^/]+)$/);
    if (kbVerMatch && req.method === 'GET') {
      const type = decodeURIComponent(kbVerMatch[1]);
      const k = getKnowledge(type);
      if (!k.isKnowledgeType) return sendJSON(res, 404, { error: '该类型不是全量知识库' });
      return sendJSON(res, 200, { version: getVersionContent(type, kbVerMatch[2]) });
    }
    const kbMatch = p.match(/^\/api\/knowledge\/([^/]+)(?:\/(main|dynamic))?(?:\/(rollback))?$/);
    if (kbMatch) {
      const type = decodeURIComponent(kbMatch[1]);
      const sub = kbMatch[2] || '';
      const act = kbMatch[3] || '';
      const k = getKnowledge(type);
      if (!k.isKnowledgeType) return sendJSON(res, 404, { error: '该类型不是全量知识库' });
      if (req.method === 'GET' && !sub) return sendJSON(res, 200, { knowledge: k });
      if (req.method === 'POST' && sub === 'main' && !act) {
        const body = await readBody(req);
        return sendJSON(res, 200, { knowledge: saveMain(type, body.content || '') });
      }
      if (req.method === 'POST' && sub === 'main' && act === 'rollback') {
        const body = await readBody(req);
        return sendJSON(res, 200, { knowledge: rollbackMain(type, body.version) });
      }
      if (req.method === 'PUT' && sub === 'dynamic') {
        const body = await readBody(req);
        return sendJSON(res, 200, { dynamic: saveDynamic(type, body.content || '') });
      }
      return sendJSON(res, 405, { error: '不支持的操作' });
    }

    // 创建条目
    if (req.method === 'POST' && p === '/api/entries') {
      const body = await readBody(req);
      const e = createEntry({
        type: body.type, title: body.title, content: body.content || '',
        payload: body.payload || {}, tags: body.tags || [], location: body.location || null,
        owner: body.owner || null, isPrivate: body.isPrivate, actor: 'web',
      });
      return sendJSON(res, 201, { entry: e });
    }

    // 机器人对话入口（NapCat 适配器转发到这里）
    if (req.method === 'POST' && p === '/api/chat') {
      const body = await readBody(req);
      // 私聊完全禁用：所有对话只能在群里进行
      if ((body.message_type || 'private') === 'private') {
        return sendJSON(res, 200, { reply: '' });
      }
      let groupPolicy = null;
      let groupCfg = null;
      let effectiveText = body.text || '';
      if (body.message_type === 'group' && body.group_id) {
        const cfg = getGroupConfig(String(body.group_id));
        groupCfg = cfg;
        // 未配置权限或已停用的群：机器人完全不可用（不响应任何消息）
        if (!cfg?.enabled) return sendJSON(res, 200, { reply: '' });
        if (!effectiveText.trim().startsWith('/')) {
          const trigger = matchGroupTrigger(cfg, effectiveText);
          if (trigger) {
            groupPolicy = { allowedTypes: trigger.allowedTypes, mode: trigger.mode };
            effectiveText = trigger.query;
          } else if (looksLikeConfirmation(effectiveText)) {
            // 确认消息（两位码 / 确认XX）：受限群里放行，否则确认码无法执行
            groupPolicy = { allowedTypes: Object.entries(cfg.typeRules || {}).filter(([, r]) => r.mode !== 'off').map(([type]) => type) };
          } else {
            return sendJSON(res, 200, { reply: '' });
          }
        } else {
          groupPolicy = { allowedTypes: Object.entries(cfg.typeRules || {}).filter(([, r]) => r.mode !== 'off').map(([type]) => type) };
        }
      }
      const { reply } = await handleIncoming({
        text: effectiveText,
        group_id: body.group_id,
        user_id: body.user_id,
        self_id: body.self_id,
        message_type: body.message_type || 'private',
        groupPolicy,
        groupCfg,
      });
      return sendJSON(res, 200, { reply });
    }

    // 单条目
    const m = p.match(/^\/api\/entries\/([^/]+)$/);
    if (m) {
      const id = m[1];
      if (req.method === 'GET') {
        const e = getEntry(id);
        if (!e) return sendJSON(res, 404, { error: '条目不存在' });
        return sendJSON(res, 200, { entry: e });
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const e = updateEntry(id, body, 'web');
        return sendJSON(res, 200, { entry: e });
      }
      if (req.method === 'DELETE') {
        const e = deleteEntry(id, 'web');
        return sendJSON(res, 200, { deleted: e.id });
      }
    }

    return sendJSON(res, 404, { error: '接口不存在' });
  }

  // 静态网页
  return serveStatic(res, url.pathname);
}

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.resolve(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}
