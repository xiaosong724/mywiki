// 图库：图片文件存储 + 元数据管理（上传必须绑定身份；单图 ≤200KB）
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { getDb } from './db.mjs';
import { nowLocalISO } from './time.mjs';

const db = () => getDb();

export const GALLERY_DIR = path.join(DATA_DIR, 'gallery');
export const GALLERY_MAX_SIZE = 200 * 1024; // 200KB

function rowToGallery(r) {
  if (!r) return null;
  return {
    id: r.id,
    owner: r.owner,
    caption: r.caption,
    file: r.file,
    mime: r.mime,
    size: r.size,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: `/api/gallery/${r.id}/image?t=${encodeURIComponent(r.updated_at)}`,
  };
}

function extForMime(mime) {
  const m = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/bmp': 'bmp',
  };
  return m[mime] || 'jpg';
}

function ensureDir() { mkdirSync(GALLERY_DIR, { recursive: true }); }

export function listGallery({ q = '', owner = '', offset = 0, limit = 20 } = {}) {
  const conds = [];
  const args = [];
  if (q) {
    conds.push('(owner LIKE ? OR caption LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like);
  }
  if (owner) { conds.push('owner = ?'); args.push(String(owner)); }
  let sql = 'SELECT * FROM gallery';
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  args.push(Number(limit), Number(offset));
  return db().prepare(sql).all(...args).map(rowToGallery);
}

export function countGallery({ q = '', owner = '' } = {}) {
  const conds = [];
  const args = [];
  if (q) {
    conds.push('(owner LIKE ? OR caption LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like);
  }
  if (owner) { conds.push('owner = ?'); args.push(String(owner)); }
  let sql = 'SELECT COUNT(*) AS c FROM gallery';
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  return db().prepare(sql).get(...args).c;
}

export function getGallery(id) {
  return rowToGallery(db().prepare('SELECT * FROM gallery WHERE id = ?').get(String(id)));
}

// 上传：data 为图片 Buffer；必须绑定身份 owner；大小 ≤ 200KB
export function createGallery({ owner, caption = '', data, mime = 'image/jpeg' }) {
  const own = String(owner || '').trim();
  if (!own) throw new Error('上传图片必须绑定身份（先登记 /我是 名字）');
  if (!data || !Buffer.isBuffer(data) || data.length === 0) throw new Error('图片数据为空');
  if (data.length > GALLERY_MAX_SIZE) {
    throw new Error(`图片超过 ${Math.round(GALLERY_MAX_SIZE / 1024)}KB 限制（当前 ${(data.length / 1024).toFixed(0)}KB），请压缩后上传（网页上传会自动压缩）`);
  }
  ensureDir();
  const id = randomUUID();
  const ext = extForMime(mime);
  const file = `${id}.${ext}`;
  const now = nowLocalISO();
  writeFileSync(path.join(GALLERY_DIR, file), data);
  db().prepare(
    'INSERT INTO gallery (id, owner, caption, file, mime, size, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, own, String(caption || '').trim(), file, mime, data.length, now, now);
  return getGallery(id);
}

export function updateGallery(id, { caption, owner } = {}) {
  const cur = getGallery(id);
  if (!cur) throw new Error('图片不存在');
  db().prepare('UPDATE gallery SET caption=?, owner=?, updated_at=? WHERE id=?')
    .run(
      caption !== undefined ? String(caption).trim() : cur.caption,
      owner !== undefined ? String(owner).trim() : cur.owner,
      nowLocalISO(), id,
    );
  return getGallery(id);
}

export function deleteGallery(id) {
  const cur = getGallery(id);
  if (!cur) throw new Error('图片不存在');
  try { unlinkSync(path.join(GALLERY_DIR, cur.file)); } catch { /* 文件可能已不在 */ }
  db().prepare('DELETE FROM gallery WHERE id = ?').run(id);
  return { deleted: id };
}

export function galleryFilePath(id) {
  const cur = getGallery(id);
  if (!cur) return null;
  return path.join(GALLERY_DIR, cur.file);
}

// dataURL → { mime, data(Buffer) }
export function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) throw new Error('图片格式错误，请上传 jpg/png/gif/webp');
  return { mime: m[1], data: Buffer.from(m[2], 'base64') };
}

export function readGalleryImage(id) {
  const p = galleryFilePath(id);
  if (!p || !existsSync(p)) return null;
  return readFileSync(p);
}
