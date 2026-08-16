// 全量知识库（文件型知识域）管理：主 md 上传/版本保留(5)/回滚 + 动态 md 读写
// 目录结构：<dir>/main.md（当前主文档）、<dir>/versions/vN.md（历史版本，最多 5）、<dir>/dynamic.md（QQ 动态记录）
import config, { SERVER_DIR } from './config.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { getType } from './types.mjs';

export const MAX_VERSIONS = 5;

function resolve(type, key) {
  const rel = config.knowledge?.[type]?.[key];
  if (!rel) return null;
  return path.isAbsolute(rel) ? rel : path.resolve(SERVER_DIR, rel);
}

export function knowledgeMainPath(type) {
  return resolve(type, 'mainFile');
}

export function knowledgeDynamicPath(type) {
  return resolve(type, 'dynamicFile');
}

function versionsDir(type) {
  const main = knowledgeMainPath(type);
  return main ? path.join(path.dirname(main), 'versions') : null;
}

// 所有配置了主文档的知识库类型
export function knowledgeTypes() {
  return Object.entries(config.knowledge || {})
    .filter(([, c]) => c && c.mainFile)
    .map(([type]) => type);
}

// 确保目录结构存在：main.md（缺省占位）、dynamic.md（空模板自动创建）、versions/（首版存档）
export function ensureKnowledgeFiles(type) {
  const main = knowledgeMainPath(type);
  if (!main) return;
  mkdirSync(path.dirname(main), { recursive: true });
  if (!existsSync(main)) {
    writeFileSync(main, `# ${getType(type)?.label || type}\n\n（主文档为空，请上传 md 文件更新）\n`, 'utf-8');
  }
  const dyn = knowledgeDynamicPath(type);
  if (dyn) {
    mkdirSync(path.dirname(dyn), { recursive: true });
    if (!existsSync(dyn)) {
      writeFileSync(dyn, `# ${getType(type)?.label || type} · QQ 动态记录\n\n> 通过前缀指令（如 wiki3）记录的内容追加到本文件末尾，请保持 markdown 风格一致。\n`, 'utf-8');
    }
  }
  const vdir = versionsDir(type);
  if (vdir) {
    mkdirSync(vdir, { recursive: true });
    const has = readdirSync(vdir).some((f) => /^v\d+\.md$/.test(f));
    if (!has) writeFileSync(path.join(vdir, 'v1.md'), readFileSync(main, 'utf-8'), 'utf-8');
  }
}

export function listVersions(type) {
  const vdir = versionsDir(type);
  if (!vdir || !existsSync(vdir)) return [];
  return readdirSync(vdir)
    .filter((f) => /^v\d+\.md$/.test(f))
    .sort((a, b) => Number(a.match(/^v(\d+)\.md$/)[1]) - Number(b.match(/^v(\d+)\.md$/)[1]))
    .map((f) => {
      const st = statSync(path.join(vdir, f));
      return { version: `v${Number(f.match(/^v(\d+)\.md$/)[1])}`, file: f, size: st.size, mtime: st.mtime };
    });
}

export function getKnowledge(type) {
  ensureKnowledgeFiles(type);
  const main = knowledgeMainPath(type);
  const dyn = knowledgeDynamicPath(type);
  return {
    type,
    label: getType(type)?.label || type,
    isKnowledgeType: !!main,
    main: main && existsSync(main) ? readFileSync(main, 'utf-8') : '',
    dynamic: dyn && existsSync(dyn) ? readFileSync(dyn, 'utf-8') : '',
    versions: listVersions(type),
  };
}

function trimVersions(type) {
  const vdir = versionsDir(type);
  const files = readdirSync(vdir)
    .filter((f) => /^v\d+\.md$/.test(f))
    .sort((a, b) => Number(a.match(/^v(\d+)\.md$/)[1]) - Number(b.match(/^v(\d+)\.md$/)[1]));
  while (files.length > MAX_VERSIONS) unlinkSync(path.join(vdir, files.shift()));
}

// 保存新主文档：当前内容先存档为版本（内容不同才存），再写入新内容；版本库最多保留 MAX_VERSIONS 个
export function saveMain(type, content, { commitCurrent = true } = {}) {
  ensureKnowledgeFiles(type);
  const main = knowledgeMainPath(type);
  if (!main) throw new Error('该类型未配置全量知识库主文档');
  const vdir = versionsDir(type);
  const text = String(content ?? '');
  if (commitCurrent && existsSync(main)) {
    const cur = readFileSync(main, 'utf-8').trim();
    if (cur && cur !== text.trim()) {
      const names = readdirSync(vdir).filter((f) => /^v\d+\.md$/.test(f)).map((f) => Number(f.match(/^v(\d+)\.md$/)[1]));
      const next = names.length ? Math.max(...names) + 1 : 1;
      writeFileSync(path.join(vdir, `v${next}.md`), cur, 'utf-8');
    }
  }
  writeFileSync(main, text, 'utf-8');
  trimVersions(type);
  return getKnowledge(type);
}

// 回滚到历史版本：当前内容存档为新版本，目标版本内容写回 main.md
export function rollbackMain(type, version) {
  ensureKnowledgeFiles(type);
  const vdir = versionsDir(type);
  const file = String(version || '').replace(/\.md$/, '');
  if (!/^v\d+$/.test(file)) throw new Error('版本号格式错误，应为 vN');
  const vp = path.join(vdir, `${file}.md`);
  if (!existsSync(vp)) throw new Error(`版本 ${file} 不存在`);
  const target = readFileSync(vp, 'utf-8');
  return saveMain(type, target, { commitCurrent: true });
}

// 读取历史版本内容（供切换前预览）
export function getVersionContent(type, version) {
  ensureKnowledgeFiles(type);
  const vdir = versionsDir(type);
  const file = String(version || '').replace(/\.md$/, '');
  if (!/^v\d+$/.test(file)) throw new Error('版本号格式错误，应为 vN');
  const vp = path.join(vdir, `${file}.md`);
  if (!existsSync(vp)) throw new Error(`版本 ${file} 不存在`);
  return { version: file, content: readFileSync(vp, 'utf-8') };
}

export function saveDynamic(type, content) {
  ensureKnowledgeFiles(type);
  const dyn = knowledgeDynamicPath(type);
  if (!dyn) throw new Error('该类型未配置动态知识库文件');
  writeFileSync(dyn, String(content ?? ''), 'utf-8');
  return readFileSync(dyn, 'utf-8');
}
