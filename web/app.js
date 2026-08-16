const $ = (s) => document.querySelector(s);
const state = { types: {}, identities: [], view: 'dashboard', type: '', q: '', editingId: null, editingGroup: '', kbJump: null, current: null };

// ===== 视图状态持久化（刷新后保留当前分类/搜索）=====
const VIEW_KEY = 'wiki-view-state';
function saveViewState() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      view: state.view, type: state.type, q: state.q, current: state.current,
    }));
  } catch { /* localStorage 不可用时忽略 */ }
}
function loadViewState() {
  try {
    const s = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    if (s.view) state.view = s.view;
    if (s.type) state.type = s.type;
    if (s.q) { state.q = s.q; $('#searchInput').value = s.q; }
    if (s.current) state.current = s.current;
  } catch { /* 忽略损坏的状态 */ }
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ===== 搜索高亮 =====
function escRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function currentTerms() { return String(state.q || '').split(/\s+|[,，、]/).filter(Boolean); }
function highlightText(text, terms) {
  let s = esc(text);
  for (const t of (terms || [])) {
    if (!t) continue;
    s = s.replace(new RegExp(escRegex(t), 'gi'), (m) => `<mark>${m}</mark>`);
  }
  return s;
}

function fmtTime(iso) {
  return iso ? String(iso).replace('T', ' ') : '';
}

function typeMeta(type) {
  return state.types[type] || { label: type, icon: '📄', fields: [] };
}

function cardHtml(e, extraClass = '') {
  // 全量知识库搜索结果（md 章节）：点击跳转到该类型页对应章节
  if (e.source === 'knowledge') {
    const terms = currentTerms();
    return `<div class="card kb-hit" data-view="kb" data-kb-type="${esc(e.kbType)}" data-kb-section="${esc(e.kbSection)}">
      <h3>📚 ${highlightText(e.title, terms)}</h3>
      <div class="meta">${highlightText(e.content || '', terms)}</div>
      <div class="meta" style="color:var(--accent)">↳ 查看全量知识库「${esc(e.kbLabel)}」对应章节</div>
    </div>`;
  }
  const t = typeMeta(e.type);
  const owner = e.owner ? ` · 👤 ${esc(e.owner)}` : '';
  const remind = e.remindAt ? `<div>⏰ ${fmtTime(e.remindAt)}${e.recurrence === 'yearly' ? '（每年）' : ''}</div>` : '';
  const tags = (e.tags || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('');
  const priv = e.isPrivate ? ' 🔒' : '';
  const searchSummary = state.view === 'search' && e.content
    ? `<div class="meta">${highlightText(e.content, currentTerms())}</div>` : '';
  return `<div class="card ${extraClass}" data-id="${esc(e.id)}" data-view="detail">
    <h3>${t.icon} ${highlightText(e.title, state.view === 'search' ? currentTerms() : null)}${priv}</h3>
    <div class="meta">
      <div>${esc(t.label)}${owner}${e.location ? ' · 📍 ' + esc(e.location) : ''}</div>
      ${remind}
      <div>${tags}</div>
    </div>
    ${searchSummary}
  </div>`;
}

async function loadTypes() {
  const [t, i] = await Promise.all([api('/api/types'), api('/api/identities')]);
  state.types = t.types;
  state.identities = i.identities;
  renderNav();
  fillTypeSelect();
}

function renderNav() {
  const nav = $('#typeNav');
  const btn = (key, label, active) =>
    `<button data-view="${key}" class="${active ? 'active' : ''}">${label}</button>`;
  let html = btn('dashboard', '🏠 仪表盘', state.view === 'dashboard');
  for (const [key, t] of Object.entries(state.types)) {
    html += btn(`type:${key}`, `${t.icon} ${t.label}`, state.view === `type:${key}`);
  }
  html += btn('logs', '🗒 日志', state.view === 'logs');
  html += btn('backups', '💾 备份', state.view === 'backups');
  html += btn('groups', '⚙️ 群组权限', state.view === 'groups');
  html += btn('perms', '👥 成员权限', state.view === 'perms');
  html += btn('settings', '🛠️ 设置', state.view === 'settings');
  html += btn('help', '📖 使用帮助', state.view === 'help');
  nav.innerHTML = html;
}

async function renderDashboard() {
  const [due, upcoming] = await Promise.all([
    api('/api/entries/due'),
    api('/api/upcoming?days=7'),
  ]);
  const v = $('#view');
  let html = `<div class="section-title">⏰ 已到期（${due.entries.length}）</div>`;
  html += due.entries.length
    ? `<div class="grid">${due.entries.map((e) => cardHtml(e, 'due')).join('')}</div>`
    : '<div class="empty">暂无到期提醒</div>';
  html += `<div class="section-title">📅 未来 7 天（${upcoming.entries.length}）</div>`;
  html += upcoming.entries.length
    ? `<div class="grid">${upcoming.entries.map((e) => cardHtml(e)).join('')}</div>`
    : '<div class="empty">暂无安排</div>';
  v.innerHTML = html;
}

async function renderList() {
  const type = state.type;
  // 全量知识库类型：显示主 md + 动态 md（不做条目列表）
  if (type) {
    const kbSet = await kbTypeSet();
    if (kbSet.has(type)) return renderKnowledgeView(type);
  }
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (state.q) params.set('q', state.q);
  params.set('limit', '200');
  const { entries } = await api(`/api/entries?${params}`);
  const v = $('#view');
  const title = state.q ? `「${state.q}」搜索结果（${entries.length}）` : `${typeMeta(type).icon} ${typeMeta(type).label}（${entries.length}）`;
  v.innerHTML = `<div class="section-title">${esc(title)}</div>` +
    (entries.length
      ? `<div class="grid">${entries.map((e) => cardHtml(e)).join('')}</div>`
      : '<div class="empty">这里还没有条目，点右下角 ＋ 新建</div>');
}

async function renderLogs() {
  const { logs } = await api('/api/logs');
  const v = $('#view');
  v.innerHTML = `<div class="section-title">操作日志（最近 ${logs.length} 条）</div>` +
    (logs.length
      ? `<div class="grid">${logs.map((l) => `<div class="card"><h3>${esc(l.action)} · ${esc(l.summary)}</h3><div class="meta">${fmtTime(l.ts)} · ${esc(l.actor)}${l.entry_id ? ' · ' + esc(l.entry_id.slice(0, 8)) : ''}</div></div>`).join('')}</div>`
      : '<div class="empty">暂无日志</div>');
}

// ===== 全量知识库视图（文件型知识域：显示主 md + 动态 md，不做条目列表）=====
let kbTypeCache = null;
async function kbTypeSet() {
  if (!kbTypeCache) {
    const r = await api('/api/knowledge').catch(() => ({ types: [] }));
    kbTypeCache = new Set(r.types.map((t) => t.type));
  }
  return kbTypeCache;
}

// 极简 markdown 渲染（仅支持本项目 md 使用的语法：标题/表格/列表/引用/粗体/行内代码）
function mdToHtml(md, terms) {
  const inline = (s) => {
    let t = esc(s);
    for (const term of (terms || [])) {
      if (!term) continue;
      t = t.replace(new RegExp(escRegex(term), 'gi'), (m) => `<mark>${m}</mark>`);
    }
    return t
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  };
  const lines = String(md || '').split('\n');
  const out = [];
  let listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t) { closeList(); continue; }
    // 表格：当前行以 | 开头结尾，且下一行是 |---| 分隔
    if (/^\|.*\|\s*$/.test(t) && /^\|/.test(t) && lines[i + 1] && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1].trim()) && /^\|[\s:-]*---/.test(lines[i + 1].trim())) {
      const header = t.split('|').slice(1, -1).map((s) => s.trim());
      i += 1;
      const rows = [];
      while (i + 1 < lines.length && /^\|.*\|\s*$/.test(lines[i + 1].trim()) && /^\|/.test(lines[i + 1].trim())) {
        i += 1;
        rows.push(lines[i].split('|').slice(1, -1).map((s) => s.trim()));
      }
      out.push(`<table><thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const h = t.match(/^(#{1,5})\s+(.+)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^>\s?/.test(t)) { closeList(); out.push(`<blockquote>${inline(t.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    const ul = t.match(/^[-*]\s+(.+)$/);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`); continue;
    }
    const ol = t.match(/^\d+[.、]\s+(.+)$/);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`); continue;
    }
    if (/^---+$/.test(t)) { closeList(); out.push('<hr>'); continue; }
    closeList(); out.push(`<p>${inline(t)}</p>`);
  }
  closeList();
  return out.join('\n');
}

async function renderKnowledgeView(type) {
  const { knowledge } = await api(`/api/knowledge/${encodeURIComponent(type)}`);
  const t = typeMeta(type);
  const v = $('#view');
  const terms = currentTerms();
  const verBtns = (knowledge.versions || []).map((vv) =>
    `<button class="kb-rollback" data-version="${esc(vv.version)}" title="切回此版本（当前内容自动存档）">${esc(vv.version)}</button>`).join('');
  v.innerHTML = `
    <div class="section-title">${t.icon} ${esc(knowledge.label)} · 全量知识库（主文档 + 动态记录）</div>
    <div class="card kb-manage">
      <h3>📤 主文档更新</h3>
      <div class="kb-upload">
        <input type="file" id="kbMainFile" accept=".md,.markdown,.txt">
        <button class="btn-primary" id="kbUploadBtn">上传并更新</button>
      </div>
      <div class="kb-hint">上传后旧版本自动保留（最多 5 个），可随时切换回旧版；动态记录文件在创建全量知识库时已自动生成（可为空）。</div>
      <div class="kb-versions">历史版本：${verBtns || '<span class="muted">（暂无）</span>'}</div>
    </div>
    <div class="section-title">📖 主文档</div>
    <div class="card kb-content" id="kbMainDoc">${mdToHtml(knowledge.main, terms)}</div>
    <div class="section-title">📝 动态记录（QQ 前缀指令写入 / 可编辑）<button class="btn-plain" id="kbDynamicEditBtn" style="margin-left:8px">✏️ 编辑</button></div>
    <div class="card kb-content" id="kbDynamicDoc">${mdToHtml(knowledge.dynamic, terms)}</div>
    <div class="card" id="kbDynamicEdit" style="display:none">
      <textarea id="kbDynamicText" rows="12" style="width:100%">${esc(knowledge.dynamic)}</textarea>
      <div class="actions" style="margin-top:10px"><button class="btn-primary" id="kbDynamicSave">保存</button><button class="btn-plain" id="kbDynamicCancel">取消</button></div>
    </div>`;
  // 从搜索结果跳转：滚动到目标章节并高亮
  if (state.kbJump) {
    const target = state.kbJump.section;
    state.kbJump = null;
    requestAnimationFrame(() => {
      const heads = v.querySelectorAll('#kbMainDoc h2, #kbMainDoc h3, #kbMainDoc h4, #kbDynamicDoc h2, #kbDynamicDoc h3, #kbDynamicDoc h4');
      for (const h of heads) {
        const text = h.textContent.trim();
        if (text === target || text.includes(target) || target.includes(text)) {
          h.classList.add('kb-jump');
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        }
      }
    });
  }
  $('#kbUploadBtn').onclick = async () => {
    const f = $('#kbMainFile').files[0];
    if (!f) return toast('请先选择 md 文件');
    if (f.size > 5 * 1024 * 1024) return toast('文件超过 5MB 限制');
    const content = await f.text();
    try {
      await api(`/api/knowledge/${encodeURIComponent(type)}/main`, { method: 'POST', body: JSON.stringify({ content }) });
      toast('主文档已更新（旧版本已保留）');
      renderKnowledgeView(type);
    } catch (err) { toast('更新失败：' + err.message); }
  };
  v.querySelectorAll('.kb-rollback').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api(`/api/knowledge/${encodeURIComponent(type)}/versions/${encodeURIComponent(b.dataset.version)}`);
        $('#kbPreviewTitle').textContent = `版本 ${r.version.version} 预览（点击下方按钮切换）`;
        $('#kbPreviewBody').innerHTML = mdToHtml(r.version.content);
        $('#kbPreviewSwitch').dataset.version = b.dataset.version;
        $('#kbPreviewModal').classList.remove('hidden');
      } catch (err) { toast('预览失败：' + err.message); }
    };
  });
  $('#kbDynamicEditBtn').onclick = () => {
    $('#kbDynamicEdit').style.display = 'block';
    $('#kbDynamicDoc').style.display = 'none';
  };
  $('#kbDynamicSave').onclick = async () => {
    const content = $('#kbDynamicText').value;
    try {
      await api(`/api/knowledge/${encodeURIComponent(type)}/dynamic`, { method: 'PUT', body: JSON.stringify({ content }) });
      toast('动态记录已保存');
      renderKnowledgeView(type);
    } catch (err) { toast('保存失败：' + err.message); }
  };
  $('#kbDynamicCancel').onclick = () => {
    $('#kbDynamicEdit').style.display = 'none';
    $('#kbDynamicDoc').style.display = '';
  };
}

async function renderBackups() {
  const { backups } = await api('/api/backups');
  const v = $('#view');
  v.innerHTML = `<div class="section-title">💾 数据备份</div>
    <div class="actions" style="margin: 8px 0 16px;">
      <button class="btn-primary" id="backupNow">立即备份</button>
    </div>
    <div class="empty">备份说明：每个备份是一个目录，包含 knowledge.db 和 data 下除备份目录外的所有文件。换服务器/恢复时复制对应目录即可。</div>` +
    (backups.length
      ? `<div class="grid">${backups.map((b) => `
        <div class="card" data-backup="${esc(b.name)}">
          <h3>💾 ${esc(b.name)}</h3>
          <div class="meta">${fmtTime(b.createdAt)} · ${(b.sizeBytes / 1024).toFixed(1)} KB</div>
          <div class="meta">数据库 ${(b.dbBytes / 1024).toFixed(1)} KB</div>
        </div>`).join('')}</div>`
      : '<div class="empty">还没有备份，点「立即备份」创建第一份。</div>');
  $('#backupNow').onclick = async () => {
    try {
      const r = await api('/api/backups', { method: 'POST' });
      toast(`已创建备份 ${r.backup.name}`);
      renderBackups();
    } catch (err) { toast('备份失败：' + err.message); }
  };
  v.querySelectorAll('[data-backup]').forEach((el) => {
    el.onclick = async () => {
      const name = el.dataset.backup;
      if (!confirm(`删除备份「${name}」？此操作不可恢复。`)) return;
      try {
        await api(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
        toast('备份已删除');
        renderBackups();
      } catch (err) { toast('删除失败：' + err.message); }
    };
  });
}

async function renderGroups() {
  const [{ groups }] = await Promise.all([api('/api/groups')]);
  const v = $('#view');

  const listHtml = groups.length
    ? `<div class="grid">${groups.map((g) => {
      const modeList = Object.entries(g.typeRules || {})
        .filter(([, r]) => r.mode !== 'off')
        .map(([type, r]) => `${state.types[type]?.label || type}：${r.mode === 'prefix' ? '前缀「' + (r.prefix || '?') + '」' : '自由'}`)
        .join('、');
      const modeLine = modeList ? `可用类型：${modeList}` : '全部类型关闭';
      return `
      <div class="card" data-group="${esc(g.groupId)}">
        <h3>${g.enabled ? '✅' : '⛔'} ${esc(g.name || g.groupId)}</h3>
        <div class="meta">群号：${esc(g.groupId)}</div>
        <div class="meta">${g.enabled ? '已启用' : '已停用'} · ${g.memberPrivateChat ? '成员可私聊' : '成员禁私聊（群主除外）'}</div>
        <div class="meta">${esc(modeLine)}</div>
        <div class="meta">${fmtTime(g.updatedAt)}</div>
        <div class="actions">
          <button type="button" class="btn-danger" data-group-del="${esc(g.groupId)}">删除配置</button>
        </div>
      </div>`;
    }).join('')}</div>`
    : '<div class="empty">还没有群组权限配置。未配置权限的群不能使用 QQ 机器人（需要在 bot.allowedGroups 白名单且配置群权限）。</div>';

  v.innerHTML = `<div class="section-title">⚙️ 群组权限</div>
    <div class="actions" style="margin: 8px 0 16px;">
      <button type="button" class="btn-primary" id="groupAdd">添加群组</button>
    </div>
    <div class="empty">说明：给某个 QQ 群单独设置可用的 wiki 类型和触发方式。<b>未配置权限或停用（⛔）的群，机器人完全不响应</b>；全量知识库类型（如修仙模组）只能指令触发，不能自由触发。</div>
    ${listHtml}`;

}

async function openGroupForm(groupId = null) {
  let group = null;
  if (groupId) {
    const { groups } = await api('/api/groups');
    group = groups.find((g) => g.groupId === groupId) || null;
  }
  state.editingGroup = group?.groupId || '';
  $('#groupModalTitle').textContent = group ? '编辑群组权限' : '添加群组权限';
  $('#gGroupId').value = group?.groupId || '';
  $('#gGroupName').value = group?.name || '';
  $('#gEnabled').checked = group ? !!group.enabled : true;
  $('#gMemberPrivate').checked = group ? !!group.memberPrivateChat : true;
  const [typeResp, kbResp] = await Promise.all([
    api('/api/types'),
    api('/api/knowledge').catch(() => ({ types: [] })),
  ]);
  const typeMap = typeResp?.types || state.types || {};
  const kbSet = new Set((kbResp?.types || []).map((t) => t.type));
  const box = $('#gTypeRules');
  box.innerHTML = Object.entries(typeMap).map(([key, t]) => {
    const r = group?.typeRules?.[key] || {};
    const isKb = kbSet.has(key);
    const modeOpts = isKb
      ? `<option value="off" ${r.mode === 'off' ? 'selected' : ''}>关闭</option>
         <option value="prefix" ${r.mode === 'prefix' ? 'selected' : ''}>指令触发</option>`
      : `<option value="off" ${r.mode === 'off' ? 'selected' : ''}>关闭</option>
         <option value="free" ${r.mode === 'free' ? 'selected' : ''}>自由触发</option>
         <option value="prefix" ${r.mode === 'prefix' ? 'selected' : ''}>前缀触发</option>`;
    const kbHint = isKb ? ' <span class="muted" style="font-size:12px">（全量知识库，只能指令触发）</span>' : '';
    return `<div class="group-type-row" data-type="${esc(key)}">
      <span class="group-type-label">${t.icon} ${esc(t.label)}${kbHint}</span>
      <select class="group-mode">
        ${modeOpts}
      </select>
      <input class="group-prefix" placeholder="前缀，如 wiki" value="${esc(r.prefix || '')}" ${r.mode === 'prefix' ? '' : 'disabled'}>
    </div>`;
  }).join('');
  const prefixInputs = () => box.querySelectorAll('.group-prefix');
  const sync = () => {
    box.querySelectorAll('.group-type-row').forEach((row) => {
      const sel = row.querySelector('.group-mode');
      const inp = row.querySelector('.group-prefix');
      inp.disabled = sel.value !== 'prefix';
    });
  };
  box.querySelectorAll('.group-mode').forEach((sel) => sel.addEventListener('change', sync));
  sync();
  box.querySelectorAll('.group-mode').forEach((sel) => {
    sel.onchange = () => {
      const row = sel.closest('.group-type-row');
      const input = row.querySelector('.group-prefix');
      input.disabled = sel.value !== 'prefix';
      const defaultRow = $(`[data-default-row="${row.dataset.type}"]`);
      if (defaultRow) defaultRow.style.display = sel.value === 'off' ? 'none' : '';
    };
  });
  const defaultBox = $('#gDefaultRules');
  defaultBox.innerHTML = Object.entries(typeMap).map(([key, t]) => {
    const mode = group?.typeRules?.[key]?.mode || 'off';
    const d = group?.defaultMemberRules?.[key] || { read: true, create: true, update: true, delete: true };
    // 注意：data-default-action 必须用英文键（read/create/update/delete），后端只认英文；显示用中文标签
    const check = (actionKey, label, val) => `<label class="inline-check"><input type="checkbox" data-default-type="${esc(key)}" data-default-action="${actionKey}" ${val ? 'checked' : ''}>${label}</label>`;
    return `<div class="group-type-row" data-default-row="${esc(key)}" style="${mode === 'off' ? 'display:none' : ''}">
      <span class="group-type-label">${t.icon} ${esc(t.label)}</span>
      <span>${check('read', '查', d.read !== false)} ${check('create', '增', !!d.create)} ${check('update', '改', !!d.update)} ${check('delete', '删', !!d.delete)}</span>
    </div>`;
  }).join('');
  $('#groupModal').classList.remove('hidden');
}

async function submitGroupForm(e) {
  e.preventDefault();
  console.log('[groups] submit');
  const typeRules = {};
  for (const row of document.querySelectorAll('#gTypeRules .group-type-row')) {
    const type = row.dataset.type;
    const mode = row.querySelector('.group-mode').value;
    const prefix = row.querySelector('.group-prefix').value.trim();
    if (mode === 'prefix' && !prefix) {
      toast('前缀触发必须填写前缀');
      return;
    }
    typeRules[type] = { mode, prefix };
  }
  const defaultMemberRules = {};
  for (const el of document.querySelectorAll('#gDefaultRules [data-default-type]')) {
    const type = el.dataset.defaultType;
    const action = el.dataset.defaultAction;
    defaultMemberRules[type] = defaultMemberRules[type] || { read: true, create: false, update: false, delete: false };
    defaultMemberRules[type][action] = el.checked;
  }
  const body = {
    groupId: $('#gGroupId').value.trim(),
    name: $('#gGroupName').value.trim(),
    enabled: $('#gEnabled').checked,
    memberPrivateChat: $('#gMemberPrivate').checked,
    typeRules,
    defaultMemberRules,
  };
  if (!body.groupId) {
    toast('群号不能为空');
    return;
  }
  try {
    await api('/api/groups', { method: 'POST', body: JSON.stringify(body) });
    toast('群组权限已保存');
    closeGroupModal();
    renderGroups();
  } catch (err) {
    toast('保存失败：' + err.message);
  }
}

function closeGroupModal() {
  $('#groupModal').classList.add('hidden');
  state.editingGroup = '';
}

async function renderMemberPerms() {
  const { permissions } = await api('/api/permissions');
  const v = $('#view');
  v.innerHTML = `<div class="section-title">👥 成员权限</div>
    <div class="actions" style="margin: 8px 0 16px;">
      <button type="button" class="btn-primary" id="memberPermAdd">添加成员权限</button>
    </div>
    <div class="empty">说明：给某个成员在指定群里设置分类的增删改查权限。输入群号后只显示该群已开启的分类；未配置的成员默认拥有群里开启类型的全部权限。</div>` +
    (permissions.length
      ? `<div class="grid">${permissions.map((p) => {
        const flags = Object.entries(p.rules || {})
          .filter(([, r]) => r.read || r.create || r.update || r.delete)
          .map(([k, r]) => {
            const t = state.types[k];
            const s = [r.read ? '查' : '', r.create ? '增' : '', r.update ? '改' : '', r.delete ? '删' : ''].filter(Boolean).join('/');
            return `${t?.icon || ''}${t?.label || k}：${s || '无'}`;
          }).join('；');
        return `
        <div class="card" data-perm-qq="${esc(p.qqId)}" data-perm-group="${esc(p.groupId)}">
          <h3>👤 ${esc(p.qqId)}</h3>
          <div class="meta">群号：${esc(p.groupId)}</div>
          <div class="meta">${esc(flags || '全部类型均无权限')}</div>
          <div class="meta">${fmtTime(p.updatedAt)}</div>
          <div class="actions">
            <button type="button" class="btn-danger" data-perm-del="${esc(p.qqId)}|${esc(p.groupId)}">删除配置</button>
          </div>
        </div>`;
      }).join('')}</div>`
      : '<div class="empty">还没有成员权限配置。</div>');
}

async function openMemberPermForm(qqId = null, groupId = null) {
  let perm = null;
  if (qqId && groupId) {
    const { permissions } = await api('/api/permissions');
    perm = permissions.find((p) => p.qqId === qqId && p.groupId === groupId) || null;
  }
  const [typeResp, groupsResp] = await Promise.all([api('/api/types'), api('/api/groups')]);
  const typeMap = typeResp?.types || state.types || {};
  const groupConfigs = groupsResp?.groups || [];
  $('#memberPermModalTitle').textContent = perm ? '编辑成员权限' : '添加成员权限';
  $('#mpQqId').value = perm?.qqId || '';
  $('#mpGroupId').value = perm?.groupId || '';
  const box = $('#mpTypeRules');
  // 根据群号只显示该群已开启的分类；未配置或停用的群默认显示全部类型
  const renderTypeRows = (gid) => {
    const gidStr = String(gid || '').trim();
    const cfg = groupConfigs.find((g) => String(g.groupId) === gidStr);
    const visible = cfg && cfg.enabled
      ? Object.entries(typeMap).filter(([key]) => (cfg.typeRules?.[key]?.mode || 'off') !== 'off')
      : Object.entries(typeMap);
    if (!visible.length) {
      box.innerHTML = '<div class="empty">该群没有开启任何分类，无需配置成员权限。</div>';
      return;
    }
    box.innerHTML = visible.map(([key, t]) => {
      const r = perm?.rules?.[key] || {};
      // data-perm-action 用英文键，后端只认 read/create/update/delete
      const check = (actionKey, label, val) => `<label class="inline-check"><input type="checkbox" data-perm-type="${esc(key)}" data-perm-action="${actionKey}" ${val ? 'checked' : ''}>${label}</label>`;
      return `<div class="group-type-row">
        <span class="group-type-label">${t.icon} ${esc(t.label)}</span>
        <span>${check('read', '查', r.read !== false)} ${check('create', '增', !!r.create)} ${check('update', '改', !!r.update)} ${check('delete', '删', !!r.delete)}</span>
      </div>`;
    }).join('');
  };
  renderTypeRows($('#mpGroupId').value);
  $('#mpGroupId').oninput = () => renderTypeRows($('#mpGroupId').value);
  $('#memberPermModal').classList.remove('hidden');
}

async function submitMemberPermForm(e) {
  e.preventDefault();
  console.log('[perms] submit');
  const qqId = $('#mpQqId').value.trim();
  const groupId = $('#mpGroupId').value.trim();
  if (!qqId || !groupId) {
    toast('QQ 号和群号都不能为空');
    return;
  }
  const rules = {};
  for (const el of document.querySelectorAll('[data-perm-type]')) {
    const type = el.dataset.permType;
    const action = el.dataset.permAction;
    rules[type] = rules[type] || { read: true, create: false, update: false, delete: false };
    rules[type][action] = el.checked;
  }
  try {
    await api('/api/permissions', { method: 'POST', body: JSON.stringify({ qqId, groupId, rules }) });
    toast('成员权限已保存');
    closeMemberPermModal();
    renderMemberPerms();
  } catch (err) {
    toast('保存失败：' + err.message);
  }
}

function closeMemberPermModal() {
  $('#memberPermModal').classList.add('hidden');
}

async function renderSettings() {
  const [cfg, typeResp] = await Promise.all([api('/api/config'), api('/api/types')]);
  const types = typeResp.types || {};
  const v = $('#view');
  v.innerHTML = `<div class="section-title">🛠️ 设置</div>
    <div class="detail" style="max-width:640px">
      <form id="settingsForm">
        <label>AI 开关
          <select id="sAiEnabled">
            <option value="true" ${cfg.ai.enabled ? 'selected' : ''}>启用</option>
            <option value="false" ${!cfg.ai.enabled ? 'selected' : ''}>关闭</option>
          </select>
        </label>
        <label>每日 AI 请求上限
          <input id="sMaxRequests" type="number" min="1" value="${Number(cfg.ai.maxRequestsPerDay)}">
        </label>
        <label>AI 模型
          <select id="sModel">
            <option value="deepseek-chat" ${cfg.ai.model === 'deepseek-chat' ? 'selected' : ''}>deepseek-chat（省）</option>
            <option value="deepseek-reasoner" ${cfg.ai.model === 'deepseek-reasoner' ? 'selected' : ''}>deepseek-reasoner（强）</option>
          </select>
        </label>
        <label>单次回复最大 tokens
          <input id="sMaxTokens" type="number" min="50" value="${Number(cfg.ai.maxTokens)}">
        </label>
        <label>对话记忆轮数
          <input id="sHistoryTurns" type="number" min="1" max="20" value="${Number(cfg.ai.historyTurns)}">
        </label>
        <label>费用报告接收 QQ
          <input id="sCostQQ" value="${esc(cfg.ai.costNotifyQQ || '')}">
        </label>
        <label>提醒接收 QQ
          <input id="sNotifyQQ" value="${esc(cfg.notify.qqUserId || '')}">
        </label>
        <label>提醒群（到点发群并 @创建者；留空=私聊创建的提醒仍私发）
          <input id="sNotifyGroup" value="${esc(cfg.notify.groupId || '')}">
        </label>
        <label>提醒扫描间隔（秒）
          <input id="sScheduler" type="number" min="10" value="${Number(cfg.scheduler.intervalSeconds)}">
        </label>
        <label>DeepSeek API Key（留空保持不变）
          <input id="sApiKey" type="password" autocomplete="off" placeholder="${cfg.ai.hasApiKey ? '已设置，留空不变' : '填写 key'}">
        </label>
        <label>重启 QQ/NapCat 命令（留空=网页不显示重启按钮）
          <input id="sRestartCmd" value="${esc(cfg.bot.restartCommand || '')}" placeholder="如 powershell -File C:\my-wiki\scripts\restart-napcat.ps1">
        </label>
        <div class="actions">
          <button type="submit" class="btn-primary">保存设置</button>
        </div>
      </form>
    </div>
    <div class="detail" style="max-width:640px; margin-top:16px">
      <div class="section-title">分类名称</div>
      <form id="typeLabelForm">
        ${Object.entries(types).map(([key, t]) => `<label>${t.icon} ${esc(key)}
          <input data-type-label="${esc(key)}" value="${esc(t.label)}">
        </label>`).join('')}
        <div class="actions">
          <button type="submit" class="btn-primary">保存分类名称</button>
        </div>
      </form>
    </div>
    <div class="detail" style="max-width:640px; margin-top:16px">
      <div class="section-title">🤖 QQ 机器人登录</div>
      <div class="empty">重启 NapCat/QQ 或需要重新登录时，这里会显示登录二维码，用手机 QQ 扫码即可。二维码会随重启/登录更新。</div>
      <div id="botQrBox" style="text-align:center; padding:8px 0;">
        <img id="botQr" src="/api/bot/qrcode?t=${Date.now()}" alt="二维码"
             style="width:200px;height:200px;object-fit:contain;background:#fff;padding:8px;border:1px solid #ddd;border-radius:8px;">
        <div class="actions" style="justify-content:center;">
          <button type="button" class="btn-primary" id="botQrRefresh">🔄 刷新二维码</button>
          ${cfg.bot.restartCommand ? '<button type="button" class="btn-danger" id="botQrRestart">♻️ 重启 QQ/NapCat</button>' : ''}
        </div>
        <div class="meta" id="botQrInfo"></div>
      </div>
    </div>`;
  $('#settingsForm').addEventListener('submit', submitSettings);
  $('#typeLabelForm').addEventListener('submit', submitTypeLabels);
  const refreshQr = () => {
    const img = $('#botQr');
    if (img) img.src = `/api/bot/qrcode?t=${Date.now()}`;
    api('/api/bot/qrcode/info')
      .then((r) => {
        const el = $('#botQrInfo');
        if (!el) return;
        el.textContent = r.exists
          ? `二维码更新于 ${fmtTime(r.updatedAt)}（重启 NapCat/QQ 后点刷新）`
          : '暂无二维码（QQ 已登录或 NapCat 未运行）。重启 NapCat/QQ 后点刷新。';
      })
      .catch(() => {});
  };
  const qrBtn = $('#botQrRefresh');
  if (qrBtn) qrBtn.onclick = refreshQr;
  const restartBtn = $('#botQrRestart');
  if (restartBtn) restartBtn.onclick = async () => {
    if (!confirm('确定重启 QQ/NapCat？重启后若需重新登录，稍等片刻点「刷新二维码」扫码。')) return;
    try {
      await api('/api/bot/restart', { method: 'POST' });
      toast('重启命令已发送，等待 QQ 重新登录…');
      setTimeout(refreshQr, 10000);
    } catch (err) { toast('重启失败：' + err.message); }
  };
  refreshQr();
}

async function submitTypeLabels(e) {
  e.preventDefault();
  const inputs = [...document.querySelectorAll('[data-type-label]')];
  try {
    await Promise.all(inputs.map((el) => api('/api/type-labels', {
      method: 'POST',
      body: JSON.stringify({ typeKey: el.dataset.typeLabel, label: el.value.trim() }),
    })));
    toast('分类名称已保存');
    await loadTypes();
    renderSettings();
  } catch (err) {
    toast('保存失败：' + err.message);
  }
}

async function submitSettings(e) {
  e.preventDefault();
  const apiKey = $('#sApiKey').value.trim();
  const body = {
    ai: {
      enabled: $('#sAiEnabled').value === 'true',
      maxRequestsPerDay: Number($('#sMaxRequests').value),
      model: $('#sModel').value,
      maxTokens: Number($('#sMaxTokens').value),
      historyTurns: Number($('#sHistoryTurns').value),
      costNotifyQQ: $('#sCostQQ').value.trim(),
      ...(apiKey ? { apiKey } : {}),
    },
    notify: { qqUserId: $('#sNotifyQQ').value.trim(), groupId: $('#sNotifyGroup').value.trim() },
    bot: { restartCommand: $('#sRestartCmd').value.trim(), qrcodePath: cfg.bot?.qrcodePath || '' },
    scheduler: { intervalSeconds: Number($('#sScheduler').value) },
  };
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
    toast('设置已保存');
    renderSettings();
  } catch (err) {
    toast('保存失败：' + err.message);
  }
}

async function renderHelp() {
  const { entries } = await api('/api/entries?type=help&limit=100');
  const sorted = entries.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const v = $('#view');
  if (!sorted.length) {
    v.innerHTML = '<div class="empty">手册还没写入，运行 node scripts/store-manual.mjs</div>';
    return;
  }
  v.innerHTML = '<div class="section-title">📖 使用帮助</div>' +
    sorted.map((e) => `
      <div class="detail help-block">
        <h2>${esc(e.title)}</h2>
        <div class="help-content">${esc(e.content)}</div>
      </div>`).join('');
}

async function renderDetail(id) {
  let e;
  try {
    const r = await api(`/api/entries/${encodeURIComponent(id)}`);
    e = r.entry;
  } catch (err) {
    // 条目不存在（可能刚被删除/他人删除）→ 自动返回列表/仪表盘，避免卡在失效详情页
    toast('条目不存在或已被删除');
    state.view = state.q ? 'search' : (state.type ? `type:${state.type}` : 'dashboard');
    return renderView();
  }
  const t = typeMeta(e.type);
  const rows = [];
  for (const [k, v] of Object.entries(e.payload)) {
    if (v === '' || v === null || v === undefined) continue;
    rows.push(`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`);
  }
  if (e.content) rows.push(`<tr><td>内容</td><td>${highlightText(e.content, currentTerms())}</td></tr>`);
  if (e.location) rows.push(`<tr><td>位置</td><td>${esc(e.location)}</td></tr>`);
  if (e.owner) rows.push(`<tr><td>归属</td><td>${esc(e.owner)}</td></tr>`);
  if (e.isPrivate) rows.push(`<tr><td>私密</td><td>🔒 仅网页和归属人本人私聊可见</td></tr>`);
  if (e.tags.length) rows.push(`<tr><td>标签</td><td>${esc(e.tags.join(', '))}</td></tr>`);
  if (e.remindAt) rows.push(`<tr><td>提醒</td><td>${fmtTime(e.remindAt)}（${e.recurrence === 'yearly' ? '每年' : '一次'}）</td></tr>`);
  rows.push(`<tr><td>状态</td><td>${e.done ? '✅ 已完成' : '进行中'}</td></tr>`);
  rows.push(`<tr><td>ID</td><td>${esc(e.id)}</td></tr>`);

  const v = $('#view');
  v.innerHTML = `
    <button class="back" data-view="back">← 返回</button>
    <div class="detail">
      <h2>${t.icon} ${esc(e.title)}</h2>
      <div class="meta">${esc(t.label)}</div>
      <table>${rows.join('')}</table>
      <div class="actions">
        <button class="btn-primary" data-action="edit">编辑</button>
        <button class="btn-danger" data-action="delete">删除</button>
      </div>
    </div>`;
  v.querySelector('[data-action="edit"]').onclick = () => openForm(e);
  v.querySelector('[data-action="delete"]').onclick = async () => {
    if (!confirm(`确认删除「${e.title}」？`)) return;
    try {
      await api(`/api/entries/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
      toast('已删除');
      // 删除后返回之前的列表/搜索/仪表盘，不要重新渲染已删除的详情页
      state.view = state.q ? 'search' : (state.type ? `type:${state.type}` : 'dashboard');
      renderView();
    } catch (err) { toast('删除失败：' + err.message); }
  };
}

function fillTypeSelect() {
  const sel = $('#fType');
  sel.innerHTML = Object.entries(state.types)
    .map(([k, t]) => `<option value="${k}">${t.icon} ${t.label}</option>`)
    .join('');
  renderFields();
}

function fillOwnerSelect() {
  const sel = $('#fOwner');
  sel.innerHTML = '<option value="">无</option>' +
    state.identities.map((i) => `<option value="${esc(i.name)}">${esc(i.name)}（${esc(i.qq_id)}）</option>`).join('');
}

function renderFields() {
  const type = $('#fType').value;
  const t = typeMeta(type);
  const box = $('#fFields');
  $('#fPrivate').checked = type === 'account';
  box.innerHTML = t.fields.map((f) => {
    let input = '';
    if (f.kind === 'textarea') {
      input = `<textarea data-field="${f.key}" rows="3"></textarea>`;
    } else if (f.kind === 'bool') {
      input = `<select data-field="${f.key}"><option value="false">否</option><option value="true">是</option></select>`;
    } else if (f.kind === 'number') {
      input = `<input data-field="${f.key}" type="number">`;
    } else if (f.kind === 'time') {
      input = `<input data-field="${f.key}" type="time">`;
    } else if (f.kind === 'date') {
      input = `<input data-field="${f.key}" type="date">`;
    } else if (f.kind === 'monthday') {
      input = `<input data-field="${f.key}" placeholder="MM-DD 或 3月8日">`;
    } else {
      input = `<input data-field="${f.key}" type="text">`;
    }
    return `<label>${esc(f.label)}${input}</label>`;
  }).join('');
}

function openForm(entry = null) {
  state.editingId = entry?.id || null;
  $('#modalTitle').textContent = entry ? '编辑条目' : '新建条目';
  $('#fTitle').value = entry?.title || '';
  $('#fContent').value = entry?.content || '';
  $('#fLocation').value = entry?.location || '';
  fillOwnerSelect();
  $('#fOwner').value = entry?.owner || '';
  $('#fPrivate').checked = !!(entry?.isPrivate || entry?.type === 'account');
  $('#fTags').value = (entry?.tags || []).join(',');
  if (entry) {
    $('#fType').value = entry.type;
    renderFields();
    for (const [k, v] of Object.entries(entry.payload || {})) {
      const el = $(`[data-field="${k}"]`);
      if (el) el.value = String(v);
    }
  } else {
    fillTypeSelect();
  }
  $('#modal').classList.remove('hidden');
}

async function submitForm(e) {
  e.preventDefault();
  const type = $('#fType').value;
  const payload = {};
  for (const el of document.querySelectorAll('#fFields [data-field]')) {
    const v = el.value;
    if (v !== '' && v !== null && v !== undefined) {
      payload[el.dataset.field] = el.type === 'number' ? Number(v) : v;
    }
  }
  const body = {
    type,
    title: $('#fTitle').value.trim(),
    content: $('#fContent').value,
    location: $('#fLocation').value || null,
    owner: $('#fOwner').value || null,
    isPrivate: $('#fPrivate').checked,
    tags: $('#fTags').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
    payload,
  };
  try {
    if (state.editingId) {
      await api(`/api/entries/${encodeURIComponent(state.editingId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      toast('已保存');
    } else {
      const r = await api('/api/entries', { method: 'POST', body: JSON.stringify(body) });
      toast(`已创建 #${r.entry.id.slice(0, 8)}`);
    }
    closeModal();
    renderView();
  } catch (err) {
    toast('保存失败：' + err.message);
  }
}

function closeModal() {
  $('#modal').classList.add('hidden');
  $('#entryForm').reset();
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

async function renderView() {
  saveViewState();
  renderNav();
  if (state.view === 'dashboard') return renderDashboard();
  if (state.view === 'logs') return renderLogs();
  if (state.view === 'backups') return renderBackups();
  if (state.view === 'groups') return renderGroups();
  if (state.view === 'perms') return renderMemberPerms();
  if (state.view === 'settings') return renderSettings();
  if (state.view === 'help') return renderHelp();
  if (state.view.startsWith('type:')) {
    state.type = state.view.slice(5);
    return renderList();
  }
  if (state.view === 'search') return renderList();
  if (state.view === 'detail') return renderDetail(state.current);
  state.view = 'dashboard';
  return renderDashboard();
}

// 事件绑定
document.addEventListener('click', (e) => {
  const permDel = e.target.closest('[data-perm-del]');
  if (permDel) {
    const [qq, gid] = permDel.dataset.permDel.split('|');
    if (confirm(`删除成员 ${qq} 在群 ${gid} 的权限配置？该成员将回到群默认权限。`)) {
      api(`/api/permissions/${encodeURIComponent(qq)}/${encodeURIComponent(gid)}`, { method: 'DELETE' })
        .then(() => { toast('成员权限已删除'); renderMemberPerms(); })
        .catch((err) => toast('删除失败：' + err.message));
    }
    return;
  }
  const groupDel = e.target.closest('[data-group-del]');
  if (groupDel) {
    const gid = groupDel.dataset.groupDel;
    if (confirm(`删除群 ${gid} 的权限配置？该群将回到默认规则（受 bot.allowedGroups 白名单约束）。`)) {
      api(`/api/groups/${encodeURIComponent(gid)}`, { method: 'DELETE' })
        .then(() => { toast('群配置已删除'); renderGroups(); })
        .catch((err) => toast('删除失败：' + err.message));
    }
    return;
  }
  const memberPermAdd = e.target.closest('#memberPermAdd');
  if (memberPermAdd) {
    openMemberPermForm().catch((err) => {
      console.error('[perms] open failed', err);
      toast('打开失败：' + err.message);
    });
    return;
  }
  const memberPermCard = e.target.closest('[data-perm-qq]');
  if (memberPermCard) {
    openMemberPermForm(memberPermCard.dataset.permQq, memberPermCard.dataset.permGroup).catch((err) => {
      console.error('[perms] open failed', err);
      toast('打开失败：' + err.message);
    });
    return;
  }
  const groupAdd = e.target.closest('#groupAdd');
  if (groupAdd) {
    openGroupForm().catch((err) => {
      console.error('[groups] open failed', err);
      toast('打开失败：' + err.message);
    });
    return;
  }
  const groupCard = e.target.closest('[data-group]');
  if (groupCard) {
    openGroupForm(groupCard.dataset.group).catch((err) => {
      console.error('[groups] open failed', err);
      toast('打开失败：' + err.message);
    });
    return;
  }
  const kbCard = e.target.closest('[data-view="kb"]');
  if (kbCard) {
    state.kbJump = { section: kbCard.dataset.kbSection };
    state.type = kbCard.dataset.kbType;
    state.view = `type:${state.type}`;
    renderView();
    return;
  }
  const card = e.target.closest('[data-view="detail"]');
  if (card) {
    state.view = 'detail';
    state.current = card.dataset.id;
    renderView();
    return;
  }
  const navBtn = e.target.closest('nav button');
  if (navBtn) {
    state.view = navBtn.dataset.view;
    state.q = '';
    $('#searchInput').value = '';
    renderView();
    return;
  }
  const back = e.target.closest('[data-view="back"]');
  if (back) {
    state.view = state.q ? 'search' : (state.type ? `type:${state.type}` : 'dashboard');
    renderView();
  }
});

$('#searchBtn').onclick = () => {
  const q = $('#searchInput').value.trim();
  if (!q) return;
  state.q = q;
  state.type = '';   // 清空类型：任何视图搜索都进入搜索结果页（否则知识库类型页会吞掉搜索）
  state.view = 'search';
  renderView();
};
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#searchBtn').click();
});

$('#refreshBtn').onclick = () => renderView();
$('#fab').onclick = () => openForm();
$('#modalClose').onclick = closeModal;
$('#formCancel').onclick = closeModal;
$('#entryForm').addEventListener('submit', submitForm);
$('#fType').addEventListener('change', renderFields);
$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal')) closeModal();
});

$('#groupModalClose').onclick = closeGroupModal;
$('#groupFormCancel').onclick = closeGroupModal;
$('#groupModal').addEventListener('click', (e) => {
  if (e.target === $('#groupModal')) closeGroupModal();
});

$('#memberPermModalClose').onclick = closeMemberPermModal;
$('#memberPermFormCancel').onclick = closeMemberPermModal;
$('#memberPermModal').addEventListener('click', (e) => {
  if (e.target === $('#memberPermModal')) closeMemberPermModal();
});

// 全量知识库：版本预览 modal
function closeKbPreview() { $('#kbPreviewModal').classList.add('hidden'); }
$('#kbPreviewClose').onclick = closeKbPreview;
$('#kbPreviewCancel').onclick = closeKbPreview;
$('#kbPreviewModal').addEventListener('click', (e) => {
  if (e.target === $('#kbPreviewModal')) closeKbPreview();
});
$('#kbPreviewSwitch').onclick = async () => {
  const ver = $('#kbPreviewSwitch').dataset.version;
  if (!ver) return;
  try {
    const type = state.type;
    await api(`/api/knowledge/${encodeURIComponent(type)}/main/rollback`, { method: 'POST', body: JSON.stringify({ version: ver }) });
    toast(`已切换回 ${ver}（当前内容已自动存档）`);
    closeKbPreview();
    renderKnowledgeView(type);
  } catch (err) { toast('切换失败：' + err.message); }
};

document.addEventListener('submit', (e) => {
  if (e.target.id === 'groupForm') {
    submitGroupForm(e);
    return;
  }
  if (e.target.id === 'memberPermForm') {
    submitMemberPermForm(e);
    return;
  }
});

// 仪表盘定时刷新
setInterval(() => {
  if (state.view === 'dashboard') renderDashboard();
}, 30000);

loadTypes().then(() => {
  loadViewState();
  renderView();
}).catch((err) => {
  $('#view').innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
});
