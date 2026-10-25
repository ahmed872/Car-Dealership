import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultBackupDir, paths } from './paths';

/** Generated once per installation. Copied into every backup so a restored database stays readable. */
export interface Secrets {
  superPassword: string;
  ownerPassword: string;
  appPassword: string;
  /** APP_ENCRYPTION_KEY: 32 bytes, base64. Losing it makes encrypted national IDs unreadable. */
  encryptionKey: string;
}

/** Machine-local; never restored from a backup. */
export interface Settings {
  webPort: number;
  backupDir: string;
  lastBackupAt: string | null;
  /** Latest wall-clock time seen, to notice the clock being turned back on time-limited licenses. */
  lastSeenAt: string | null;
}

export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Hex keeps passwords URL-safe inside postgres:// connection strings.
const password = () => randomBytes(24).toString('hex');

export function loadOrCreateSecrets(): Secrets {
  const existing = readJson<Secrets>(paths.secrets);
  if (existing) return existing;
  const secrets: Secrets = {
    superPassword: password(),
    ownerPassword: password(),
    appPassword: password(),
    encryptionKey: randomBytes(32).toString('base64'),
  };
  writeJsonAtomic(paths.secrets, secrets);
  return secrets;
}

export function readSecrets(file: string): Secrets | null {
  const s = readJson<Partial<Secrets>>(file);
  if (!s || !s.superPassword || !s.ownerPassword || !s.appPassword || !s.encryptionKey) return null;
  return s as Secrets;
}

export const DEFAULT_WEB_PORT = 47615;

export function loadSettings(): Settings {
  const s = readJson<Partial<Settings>>(paths.settings) ?? {};
  return {
    webPort: s.webPort ?? DEFAULT_WEB_PORT,
    backupDir: s.backupDir ?? defaultBackupDir(),
    lastBackupAt: s.lastBackupAt ?? null,
    lastSeenAt: s.lastSeenAt ?? null,
  };
}

export function saveSettings(settings: Settings): void {
  writeJsonAtomic(paths.settings, settings, 0o644);
}
