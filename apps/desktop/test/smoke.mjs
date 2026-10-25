// End-to-end check of the desktop edition, driven with Playwright's Electron support.
//
//   node test/smoke.mjs
//
// Env:
//   LICENSE_PRIVATE_KEY_FILE  private key matching the public key the app was bundled with (required)
//   DESKTOP_EXECUTABLE        packaged program (e.g. release/win-unpacked/AutoHub Pro.exe); default:
//                             the Electron binary running this unpacked app (needs `stage` + `build`)
//   AUTOHUB_CHROMIUM_PATH     browser for PDF rendering when Edge/Chrome are not in a standard place
//   PLAYWRIGHT_MODULE         path of @playwright/test (default: the e2e package's)
//   SMOKE_EXTRA_ARGS          extra Electron arguments (Linux CI as a non-root user: --no-sandbox)
//   SMOKE_SCREENSHOT_DIR      if set, screenshots of the activation, setup and main windows go there
//
// It uses throwaway data and backup folders and never touches the real ones.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE ?? path.join(desktop, '../../e2e/node_modules/@playwright/test'));

const keyFile = process.env.LICENSE_PRIVATE_KEY_FILE;
if (!keyFile) throw new Error('LICENSE_PRIVATE_KEY_FILE is required');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'autohub-desktop-smoke-'));
const dataDir = path.join(work, 'data');
const backupDir = path.join(work, 'backups');
const EMAIL = 'owner@smoke.test';
const PASSWORD = 'Smoke-Passw0rd-1';
const ARABIC_NAME = 'عبدالرحمن الشمري';

const shotDir = process.env.SMOKE_SCREENSHOT_DIR;
if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
const shot = async (page, name) => {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}.png`) });
};
const step = (s) => console.log(`\n▶ ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  ok(msg);
}

const license = (args) =>
  execFileSync(process.execPath, [path.join(desktop, 'scripts/license.mjs'), ...args], { encoding: 'utf8' }).trim();

async function launch() {
  const env = { ...process.env, AUTOHUB_DATA_DIR: dataDir, AUTOHUB_BACKUP_DIR: backupDir };
  const extra = (process.env.SMOKE_EXTRA_ARGS ?? '').split(' ').filter(Boolean);
  if (process.env.DESKTOP_EXECUTABLE) {
    return electron.launch({ executablePath: process.env.DESKTOP_EXECUTABLE, args: extra, env, timeout: 120_000 });
  }
  return electron.launch({ args: [...extra, desktop], env, timeout: 120_000 });
}

/** Waits for a window whose title or URL matches. */
async function waitWindow(app, test, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (test(await w.title(), w.url())) return w;
      } catch {
        // window closed while checking
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for the ${label} window`);
}
const isMain = (_t, url) => /^http:\/\/127\.0\.0\.1:\d+\//.test(url);

/** Signs in unless the window still has a session from an earlier run. */
async function ensureSignedIn(page) {
  await page.waitForURL(/\/(login|app)(\/|$|\?)/, { timeout: 120_000 });
  if (!/\/login/.test(page.url())) return ok('session kept from the previous run');
  await signIn(page);
}

async function signIn(page) {
  await page.getByLabel('البريد الإلكتروني').fill(EMAIL);
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
}

/** API call from inside the page (same origin, session cookie, CSRF header). */
async function call(page, method, url, body) {
  return page.evaluate(
    async ({ method, url, body }) => {
      const csrf = document.cookie.split('; ').find((c) => /^(__Host-)?ah_csrf=/.test(c))?.split('=')[1];
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const type = res.headers.get('content-type') ?? '';
      const data = type.includes('json') ? await res.json() : { bytes: (await res.arrayBuffer()).byteLength, type };
      return { status: res.status, data };
    },
    { method, url, body },
  );
}

const customerCount = async (page, q) => {
  const r = await call(page, 'GET', `/api/v1/customers?q=${encodeURIComponent(q)}`);
  if (r.status !== 200) throw new Error(`customer search ${r.status}: ${JSON.stringify(r.data)}`);
  return (r.data.items ?? r.data.data ?? r.data).length;
};

async function closeApp(app) {
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  await app.evaluate(({ app: a }) => a.quit());
  await exited;
}

let app;
try {
  step('first launch: activation');
  app = await launch();
  const activation = await waitWindow(app, (t) => t.includes('تفعيل'), 'activation');
  await activation.locator('#code').filter({ hasText: /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/ }).waitFor();
  const code = await activation.locator('#code').textContent();
  ok(`machine code shown: ${code}`);
  await shot(activation, '1-activation');

  await activation.locator('#key').fill('not-a-key');
  await activation.locator('#activate').click();
  await activation.locator('#msg.bad').waitFor();
  ok('garbage key refused');

  const otherDevice = license(['sign', '--key', keyFile, '--code', 'AAAA-BBBB-CCCC-DDDD-EEEE', '--name', 'Other device']);
  await activation.locator('#key').fill(otherDevice);
  await activation.locator('#activate').click();
  await activation.getByText('خاص بجهاز آخر').waitFor();
  ok('key for another device refused');

  const expired = license(['sign', '--key', keyFile, '--code', code, '--name', 'Old', '--exp', '2020-01-01']);
  await activation.locator('#key').fill(expired);
  await activation.locator('#activate').click();
  await activation.getByText('انتهت صلاحية').waitFor();
  ok('expired key refused');

  const good = license(['sign', '--key', keyFile, '--code', code, '--name', 'معرض الاختبار']);
  await activation.locator('#key').fill(good);
  await activation.locator('#activate').click();
  await activation.getByText('تم التفعيل').waitFor();
  ok('valid key accepted');
  await shot(activation, '2-activated');

  step('first-run company setup');
  const setup = await waitWindow(app, (t) => t.includes('إعداد الشركة'), 'setup');
  await setup.locator('#name').waitFor();
  await shot(setup, '3-setup');
  await setup.locator('#name').fill('معرض الاختبار للسيارات');
  await setup.locator('#market').selectOption('SA');
  await setup.locator('#fullName').fill('مالك المعرض');
  await setup.locator('#email').fill(EMAIL);
  await setup.locator('#password').fill('short1');
  await setup.locator('#password2').fill('short1');
  await setup.locator('#submit').click();
  await setup.locator('#msg.bad').waitFor();
  ok('weak password refused');
  await setup.locator('#password').fill(PASSWORD);
  await setup.locator('#password2').fill(PASSWORD);
  await setup.locator('#submit').click();
  // Either the setup window goes away (company created) or it shows the error.
  const setupError = setup.locator('#msg.bad').filter({ hasText: 'تعذر' });
  const outcome = await Promise.race([
    setup.waitForEvent('close', { timeout: 180_000 }).then(() => 'closed'),
    setupError.waitFor({ timeout: 180_000 }).then(() => 'error'),
  ]);
  if (outcome === 'error') throw new Error(`company setup failed: ${await setupError.textContent()}`);
  ok('company created');

  step('main window: sign in and use the app');
  let main = await waitWindow(app, isMain, 'main');
  await main.waitForURL(/\/login/, { timeout: 60_000 });
  await signIn(main);
  ok(`signed in at ${main.url()}`);
  await main.getByText('معرض الاختبار للسيارات').first().waitFor();
  ok('company name shown in the app');
  await shot(main, '4-main');

  const created = await call(main, 'POST', '/api/v1/customers', { fullName: ARABIC_NAME, phone: '+966512345678' });
  assert(created.status === 201, `customer with an Arabic name created (${created.status})`);
  assert((await customerCount(main, 'الشمري')) === 1, 'Arabic partial-name search finds the customer');

  const pdf = await call(main, 'GET', '/api/v1/reports/inventory/export?format=pdf');
  if (process.env.SMOKE_SKIP_PDF) console.log('  - PDF check skipped (SMOKE_SKIP_PDF)');
  else assert(pdf.status === 200 && pdf.data.type?.includes('pdf') && pdf.data.bytes > 1000, `inventory report PDF rendered (${pdf.status}, ${pdf.data.bytes} bytes)`);

  const health = await call(main, 'GET', '/api/v1/health/ready');
  assert(health.status === 200, 'API healthy');
  const rebound = await new Promise((resolve, reject) => {
    const port = new URL(main.url()).port;
    http
      .get({ host: '127.0.0.1', port, path: '/api/v1/health/ready', headers: { Host: `attacker.example:${port}` } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      })
      .on('error', reject);
  });
  assert(rebound === 421, `request for another host name refused (DNS rebinding guard, ${rebound})`);

  step('quit: automatic backup');
  await closeApp(app);
  app = null;
  const backups1 = fs.readdirSync(backupDir).filter((f) => f.endsWith('.tar.gz'));
  assert(backups1.length === 1, `one backup written on quit (${backups1.join(', ')})`);
  const firstBackup = path.join(backupDir, backups1[0]);

  step('second launch: no activation or setup, data kept');
  app = await launch();
  main = await waitWindow(app, isMain, 'main');
  assert(app.windows().every((w) => !w.url().includes('activation') && !w.url().includes('setup')), 'no activation or setup');
  await ensureSignedIn(main);
  assert((await customerCount(main, 'الشمري')) === 1, 'customer still there after restart');
  const later = await call(main, 'POST', '/api/v1/customers', { fullName: 'عميل بعد النسخة', phone: '+966512345679' });
  assert(later.status === 201, 'second customer created');
  assert((await customerCount(main, 'بعد النسخة')) === 1, 'second customer found');

  step('restore the first backup from the menu');
  await app.evaluate(({ dialog }, file) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, firstBackup);
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.label.startsWith('استرجاع'));
    item.click();
  });
  // The window is hidden during the restore and reloaded after it.
  await main.waitForEvent('load', { timeout: 180_000 });
  await ensureSignedIn(main);
  assert((await customerCount(main, 'بعد النسخة')) === 0, 'restored data does not have the later customer');
  assert((await customerCount(main, 'الشمري')) === 1, 'restored data has the original customer');
  assert(fs.existsSync(path.join(dataDir, 'pgdata.before-restore')), 'pre-restore data kept aside');

  step('quit again');
  await closeApp(app);
  app = null;
  assert(fs.readdirSync(backupDir).filter((f) => f.endsWith('.tar.gz')).length === 2, 'second automatic backup written');

  console.log('\nDESKTOP SMOKE TEST PASSED');
} catch (err) {
  console.error('\nDESKTOP SMOKE TEST FAILED:', err);
  for (const f of ['desktop.log', 'api.log', 'api-tasks.log', 'postgres.log', 'postgres-server.log']) {
    const p = path.join(dataDir, 'logs', f);
    if (fs.existsSync(p)) console.error(`\n── ${f} (tail) ──\n${fs.readFileSync(p, 'utf8').slice(-4000)}`);
  }
  process.exitCode = 1;
} finally {
  // A failed start-up may be showing a modal error box: kill rather than close.
  try {
    app?.process().kill('SIGKILL');
  } catch {
    // already gone
  }
  if (!process.exitCode) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`work folder kept: ${work}`);
}
process.exit(process.exitCode ?? 0);
