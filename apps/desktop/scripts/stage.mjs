// Assembles apps/desktop/stage/ = the app's resources folder:
//   api/       API dist + production node_modules (pnpm deploy, hoisted, pruned)
//   web/       built web app (no source maps)
//   postgres/  PostgreSQL 16 binaries for this platform (@embedded-postgres/<platform>)
//   guide.pdf  Arabic user guide
// Prerequisite (repo root): pnpm --filter @autohub/shared build && pnpm --filter @autohub/api build &&
// pnpm --filter @autohub/web build
import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.join(desktop, '..', '..');
const stage = path.join(desktop, 'stage');

for (const need of ['apps/api/dist/main.js', 'apps/web/dist/index.html', 'packages/shared/dist']) {
  if (!existsSync(path.join(repo, need))) {
    console.error(`missing ${need}: build shared, api and web first`);
    process.exit(1);
  }
}
rmSync(stage, { recursive: true, force: true });

// ── api ──
const apiOut = path.join(stage, 'api');
execSync(`pnpm --filter @autohub/api deploy --legacy --prod --config.node-linker=hoisted "${apiOut}"`, {
  cwd: repo,
  stdio: 'inherit',
});
for (const f of ['src', 'test', 'storage', 'Dockerfile', 'drizzle.config.ts', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts']) {
  rmSync(path.join(apiOut, f), { recursive: true, force: true });
}
rmSync(path.join(apiOut, 'node_modules', '.bin'), { recursive: true, force: true });
let pruned = 0;
const prune = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) prune(p);
    else if (/\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i.test(name) && !/^licen[cs]e/i.test(name)) {
      rmSync(p);
      pruned += st.size;
    }
  }
};
prune(path.join(apiOut, 'node_modules'));
prune(path.join(apiOut, 'dist'));
console.log(`api: pruned ${(pruned / 1e6).toFixed(1)} MB of maps/typings/docs`);

// ── web ──
cpSync(path.join(repo, 'apps/web/dist'), path.join(stage, 'web'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});

// ── postgres ──
const platformPkg = { win32: '@embedded-postgres/windows-x64', linux: '@embedded-postgres/linux-x64' }[process.platform];
if (!platformPkg) {
  console.error(`no PostgreSQL package for ${process.platform}`);
  process.exit(1);
}
const pgPkgDir = realpathSync(path.join(desktop, 'node_modules', platformPkg));
cpSync(path.join(pgPkgDir, 'native'), path.join(stage, 'postgres'), { recursive: true });
// The package lists library aliases (libicuuc.so.60 -> libicuuc.so.60.2…) instead of shipping them.
const links = JSON.parse(readFileSync(path.join(stage, 'postgres', 'pg-symlinks.json'), 'utf8'));
for (const { source, target } of links) {
  const to = path.join(stage, 'postgres', path.relative('native', target));
  const from = path.join(stage, 'postgres', path.relative('native', source));
  rmSync(to, { force: true });
  if (process.platform === 'win32') copyFileSync(from, to);
  else symlinkSync(path.basename(from), to);
}
rmSync(path.join(stage, 'postgres', 'pg-symlinks.json'));
if (process.platform !== 'win32') {
  for (const f of readdirSync(path.join(stage, 'postgres', 'bin'))) chmodSync(path.join(stage, 'postgres', 'bin', f), 0o755);
}

// ── guide ──
cpSync(path.join(repo, 'docs/user-guide/AutoHub-Pro-User-Guide-AR.pdf'), path.join(stage, 'guide.pdf'));

const size = (dir) =>
  readdirSync(dir).reduce((n, name) => {
    const p = path.join(dir, name);
    const st = statSync(p);
    return n + (st.isDirectory() ? size(p) : st.size);
  }, 0);
console.log(`stage ready: ${(size(stage) / 1e6).toFixed(0)} MB in ${stage}`);
