import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { readSecrets } from './config';
import { dataDir, paths } from './paths';

/**
 * A backup is a gzip'd tar of pgdata/, storage/ and secrets.json, taken while PostgreSQL is STOPPED
 * (a cold copy is always consistent). secrets.json holds the encryption key: without it the
 * encrypted national IDs in the database could not be read after a restore, so a backup file must
 * be kept as safely as the data itself.
 */

const PREFIX = 'AutoHub-Backup-';
const AUTO_KEEP = 14;

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

export async function createBackup(destDir: string, kind: 'auto' | 'manual'): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(paths.storage, { recursive: true });
  const file = path.join(destDir, `${PREFIX}${stamp()}${kind === 'auto' ? '' : '-manual'}.tar.gz`);
  const tmp = `${file}.partial`;
  await tar.create({ gzip: true, file: tmp, cwd: dataDir, portable: true }, ['pgdata', 'storage', 'secrets.json']);
  fs.renameSync(tmp, file);
  if (kind === 'auto') pruneAutoBackups(destDir);
  return file;
}

function pruneAutoBackups(destDir: string): void {
  const auto = fs
    .readdirSync(destDir)
    .filter((f) => f.startsWith(PREFIX) && /^AutoHub-Backup-[\d_-]+\.tar\.gz$/.test(f))
    .sort();
  for (const f of auto.slice(0, Math.max(0, auto.length - AUTO_KEEP))) fs.rmSync(path.join(destDir, f), { force: true });
}

/**
 * Replaces the current data with a backup. PostgreSQL must be stopped. The current data is kept
 * next to it (pgdata.before-restore, storage.before-restore, secrets.before-restore.json) until the
 * next restore.
 */
export async function restoreBackup(file: string): Promise<void> {
  const staging = path.join(dataDir, 'restore-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    await tar.extract({ file, cwd: staging, strict: true });
    if (!fs.existsSync(path.join(staging, 'pgdata', 'PG_VERSION')) || !readSecrets(path.join(staging, 'secrets.json'))) {
      throw new Error('not_a_backup');
    }
    fs.mkdirSync(path.join(staging, 'storage'), { recursive: true });
    const keep = (name: string, kept: string) => {
      const from = path.join(dataDir, name);
      const to = path.join(dataDir, kept);
      fs.rmSync(to, { recursive: true, force: true });
      if (fs.existsSync(from)) fs.renameSync(from, to);
    };
    keep('pgdata', 'pgdata.before-restore');
    keep('storage', 'storage.before-restore');
    keep('secrets.json', 'secrets.before-restore.json');
    for (const name of ['pgdata', 'storage', 'secrets.json']) {
      fs.renameSync(path.join(staging, name), path.join(dataDir, name));
    }
    // A stale pid file from the machine the backup came from would block start-up.
    fs.rmSync(path.join(paths.pgdata, 'postmaster.pid'), { force: true });
    // PostgreSQL refuses a data directory readable by others (not applicable on Windows).
    if (process.platform !== 'win32') fs.chmodSync(paths.pgdata, 0o700);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
