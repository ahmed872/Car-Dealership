// Seller license tool (same format as tools/license-generator.html and src/license.ts).
//   node scripts/license.mjs keygen <dir>                       writes private-key.txt + public-key.txt
//   node scripts/license.mjs sign --key <private-key.txt> --code <machine code> --name <customer> [--exp YYYY-MM-DD]
//   node scripts/license.mjs code                               this machine's code (needs `pnpm build`)
// The private key must never be committed or shipped.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

if (cmd === 'keygen') {
  const dir = rest[0];
  if (!dir) throw new Error('usage: keygen <dir>');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'private-key.txt'), `${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}\n`, { mode: 0o600 });
  writeFileSync(path.join(dir, 'public-key.txt'), `${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}\n`);
  console.log(`keys written to ${dir}`);
} else if (cmd === 'sign') {
  const keyFile = arg('key');
  const code = arg('code');
  const name = arg('name');
  const exp = arg('exp') ?? null;
  if (!keyFile || !code || !name) throw new Error('usage: sign --key <file> --code <machine code> --name <customer> [--exp YYYY-MM-DD]');
  if (exp !== null && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) throw new Error('--exp must be YYYY-MM-DD');
  const key = createPrivateKey({ key: Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64'), format: 'der', type: 'pkcs8' });
  const payload = Buffer.from(
    JSON.stringify({ v: 1, mid: code.trim().toUpperCase(), name: name.trim(), iat: new Date().toISOString().slice(0, 10), exp }),
    'utf8',
  );
  console.log(`${b64url(payload)}.${b64url(sign(null, payload, key))}`);
} else if (cmd === 'code') {
  const require = createRequire(import.meta.url);
  const { machineCode } = require('../dist/license.js');
  console.log(await machineCode());
} else {
  console.error('commands: keygen <dir> | sign --key … --code … --name … [--exp …] | code');
  process.exit(1);
}
