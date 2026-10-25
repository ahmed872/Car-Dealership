// Bundles the main process and preload into dist/ (no node_modules ship with the app), copies the
// start-up pages and embeds the seller's license public key.
// LICENSE_PUBLIC_KEY_FILE overrides resources/license-public-key.txt (CI test builds use a throwaway key).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'pg-native'], logLevel: 'warning' };
await build({ ...common, entryPoints: [path.join(root, 'src/main.ts')], outfile: path.join(dist, 'main.js') });
await build({ ...common, entryPoints: [path.join(root, 'src/preload.ts')], outfile: path.join(dist, 'preload.js') });
// license.js on its own for scripts/license.mjs `code`.
await build({ ...common, entryPoints: [path.join(root, 'src/license.ts')], outfile: path.join(dist, 'license.js') });

cpSync(path.join(root, 'src/renderer'), path.join(dist, 'renderer'), { recursive: true });

const keyFile = process.env.LICENSE_PUBLIC_KEY_FILE ?? path.join(root, 'resources/license-public-key.txt');
if (!existsSync(keyFile)) {
  console.error(`Missing ${keyFile}: create the seller key pair with tools/license-generator.html (see README.md).`);
  process.exit(1);
}
const key = readFileSync(keyFile, 'utf8').trim();
if (Buffer.from(key, 'base64').length !== 44) {
  console.error(`${keyFile} is not an Ed25519 public key (base64 SPKI, 44 bytes).`);
  process.exit(1);
}
writeFileSync(path.join(dist, 'license-public-key.txt'), `${key}\n`);
console.log(`bundled; license public key from ${keyFile}`);
