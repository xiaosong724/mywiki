import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { getDb } from './db.mjs';

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'knowledge.db');
const SNAPSHOT_NAME = 'knowledge.db';

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function quoteSql(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export async function ensureBackupDir() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

export async function listBackups() {
  await ensureBackupDir();
  const names = await fs.readdir(BACKUP_DIR);
  const out = [];
  for (const name of names) {
    const dir = path.join(BACKUP_DIR, name);
    const st = await fs.stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) continue;
    let dbBytes = 0;
    try {
      const dbSt = await fs.stat(path.join(dir, SNAPSHOT_NAME));
      dbBytes = dbSt.size;
    } catch { /* no db file */ }
    out.push({
      name,
      path: dir,
      createdAt: st.mtime.toISOString(),
      sizeBytes: st.size,
      dbBytes,
    });
  }
  out.sort((a, b) => b.name.localeCompare(a.name));
  return out;
}

// 生成一个一致的数据库快照（VACUUM INTO），再把 data 目录里除 backups 外的内容复制到备份目录
export async function createBackup() {
  await ensureBackupDir();
  const name = `backup-${timestamp()}`;
  const dir = path.join(BACKUP_DIR, name);
  await fs.mkdir(dir, { recursive: true });

  const snapshot = path.join(dir, SNAPSHOT_NAME);
  getDb().exec(`VACUUM INTO ${quoteSql(snapshot)}`);

  // 复制附件/其他数据文件（排除 backups 目录自身）
  const entries = await fs.readdir(DATA_DIR);
  for (const item of entries) {
    if (item === 'backups') continue;
    if (item === 'knowledge.db' || item === 'knowledge.db-wal' || item === 'knowledge.db-shm') continue;
    const src = path.join(DATA_DIR, item);
    const dst = path.join(dir, item);
    const st = await fs.stat(src);
    if (st.isDirectory()) {
      await fs.cp(src, dst, { recursive: true });
    } else {
      await fs.copyFile(src, dst);
    }
  }

  return {
    name,
    path: dir,
    createdAt: new Date().toISOString(),
  };
}

// 按保留数量清理最旧的备份；retention 为 0 表示不自动清理
export async function pruneBackups(retention) {
  if (!retention || retention <= 0) return;
  const list = await listBackups();
  const old = list.slice(retention);
  for (const b of old) {
    await fs.rm(b.path, { recursive: true, force: true });
  }
}

export async function deleteBackup(name) {
  if (!/^backup-[\d-]+$/.test(String(name || ''))) throw new Error('备份名不合法');
  const dir = path.join(BACKUP_DIR, name);
  await fs.rm(dir, { recursive: true, force: true });
  return { deleted: name };
}

// 用于调度器/脚本：创建备份并清理旧备份
export async function runBackup(retention = 10) {
  const backup = await createBackup();
  await pruneBackups(retention);
  return backup;
}
