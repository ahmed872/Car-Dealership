import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Offline activation, one key per device.
 *
 * The seller keeps an Ed25519 private key (tools/license-generator.html). The app ships only the
 * public key. A customer's device shows its machine code; the seller signs
 *   {"v":1,"mid":"<machine code>","name":"<customer>","iat":"YYYY-MM-DD","exp":"YYYY-MM-DD"|null}
 * and the activation key is base64url(payload) + "." + base64url(signature).
 *
 * This stops a copied installation from running on another device. It is not protection against a
 * determined attacker who edits the installed program (KNOWN_ISSUES KI-036).
 */

export interface LicensePayload {
  v: 1;
  mid: string;
  name: string;
  iat: string;
  exp: string | null;
}

export type LicenseCheck =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: 'missing' | 'format' | 'signature' | 'machine' | 'expired' | 'clock' };

async function rawMachineId(): Promise<string> {
  if (process.platform === 'win32') {
    const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    const { stdout } = await run(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], {
      windowsHide: true,
    });
    const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(stdout);
    if (!m?.[1]) throw new Error('MachineGuid not found');
    return m[1].toLowerCase();
  }
  if (process.platform === 'darwin') {
    const { stdout } = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const m = /"IOPlatformUUID" = "([^"]+)"/.exec(stdout);
    if (!m?.[1]) throw new Error('IOPlatformUUID not found');
    return m[1].toLowerCase();
  }
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = fs.readFileSync(f, 'utf8').trim();
      if (id) return id;
    } catch {
      // try the next location
    }
  }
  throw new Error('machine-id not found');
}

/** Stable per Windows installation: XXXX-XXXX-XXXX-XXXX-XXXX (20 hex digits of a salted hash). */
export async function machineCode(): Promise<string> {
  const hex = createHash('sha256').update(`autohub-pro|${await rawMachineId()}`).digest('hex').slice(0, 20).toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}

const normalizeCode = (s: string) => s.toUpperCase().replace(/[^0-9A-F]/g, '');

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function checkLicense(key: string | null, publicKeyB64: string, code: string, today: string): LicenseCheck {
  if (!key) return { ok: false, reason: 'missing' };
  const parts = key.replace(/\s+/g, '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'format' };
  const data = fromB64url(parts[0]);
  const sig = fromB64url(parts[1]);
  let valid = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(publicKeyB64.trim(), 'base64'), format: 'der', type: 'spki' });
    valid = sig.length === 64 && verify(null, data, pub, sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature' };
  let payload: LicensePayload;
  try {
    payload = JSON.parse(data.toString('utf8')) as LicensePayload;
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (payload.v !== 1 || typeof payload.mid !== 'string' || typeof payload.name !== 'string') {
    return { ok: false, reason: 'format' };
  }
  if (payload.exp !== null && (typeof payload.exp !== 'string' || !DATE.test(payload.exp))) {
    return { ok: false, reason: 'format' };
  }
  if (normalizeCode(payload.mid) !== normalizeCode(code)) return { ok: false, reason: 'machine' };
  if (payload.exp && today > payload.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}
