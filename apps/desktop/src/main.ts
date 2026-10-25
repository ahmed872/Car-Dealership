import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, session, shell } from 'electron';
import { ApiServer, type CompanySetup, migrate, provisionCompany } from './api';
import { createBackup, restoreBackup } from './backup';
import { type Secrets, type Settings, loadOrCreateSecrets, loadSettings, saveSettings } from './config';
import { Postgres, freePort } from './database';
import { type LicenseCheck, type LicensePayload, checkLicense, machineCode } from './license';
import { dataDir, paths } from './paths';
import { WebServer } from './server';

const pg = new Postgres();
const api = new ApiServer();
const web = new WebServer(paths.web);
let secrets: Secrets;
let settings: Settings;
let license: LicensePayload | null = null;
let code = '';
let origin = '';
let mainWindow: BrowserWindow | null = null;
let statusWindow: BrowserWindow | null = null;
let quitting = false;
let busy = false;
/** Set once the main window is open: the start-up windows (activation, setup, status) come and go before. */
let started = false;

const DAY = 24 * 60 * 60 * 1000;
const securePrefs = (preload = true): Electron.WebPreferences => ({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
  ...(preload ? { preload: path.join(__dirname, 'preload.js') } : {}),
});

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fail(title: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.appendFileSync(path.join(paths.logs, 'desktop.log'), `${new Date().toISOString()} ${title}: ${message}\n`);
  dialog.showErrorBox(title, `${message}\n\nالسجلات: ${paths.logs}`);
}

// ── status window (start-up, backups, restore) ──────────────────────────────────────────────────
function showStatus(text: string): void {
  if (!statusWindow || statusWindow.isDestroyed()) {
    statusWindow = new BrowserWindow({
      width: 460,
      height: 220,
      resizable: false,
      frame: false,
      show: false,
      title: 'AutoHub Pro',
      webPreferences: securePrefs(),
    });
    void statusWindow.loadFile(path.join(paths.renderer, 'status.html'));
    statusWindow.once('ready-to-show', () => statusWindow?.show());
    statusWindow.webContents.once('did-finish-load', () => statusWindow?.webContents.send('status', text));
  } else {
    statusWindow.webContents.send('status', text);
  }
}

function hideStatus(): void {
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.destroy();
  statusWindow = null;
}

// ── activation ─────────────────────────────────────────────────────────────────────────────────
function evaluateLicense(key: string | null): LicenseCheck {
  const pub = fs.readFileSync(paths.publicKey, 'utf8');
  const result = checkLicense(key, pub, code, localDate());
  // A time-limited key with the clock turned back more than two days.
  if (result.ok && result.payload.exp && settings.lastSeenAt && Date.now() < Date.parse(settings.lastSeenAt) - 2 * DAY) {
    return { ok: false, reason: 'clock' };
  }
  return result;
}

function readStoredKey(): string | null {
  try {
    return fs.readFileSync(paths.license, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function ensureLicense(): Promise<LicensePayload> {
  const first = evaluateLicense(readStoredKey());
  if (first.ok) return Promise.resolve(first.payload);
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640,
      height: 560,
      resizable: false,
      title: 'تفعيل أوتوهب برو',
      webPreferences: securePrefs(),
    });
    win.setMenuBarVisibility(false);
    let done = false;
    ipcMain.handle('activation:info', () => ({ code, reason: first.reason }));
    ipcMain.handle('activation:submit', (_e, key: unknown) => {
      const result = evaluateLicense(typeof key === 'string' ? key.trim() : null);
      if (!result.ok) return { ok: false, reason: result.reason };
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(paths.license, `${String(key).trim()}\n`);
      done = true;
      ipcMain.removeHandler('activation:info');
      ipcMain.removeHandler('activation:submit');
      setTimeout(() => {
        win.destroy();
        resolve(result.payload);
      }, 900);
      return { ok: true, name: result.payload.name, exp: result.payload.exp };
    });
    win.on('closed', () => {
      if (!done) app.exit(0);
    });
    void win.loadFile(path.join(paths.renderer, 'activation.html'));
  });
}

// ── services ───────────────────────────────────────────────────────────────────────────────────
async function startDatabaseAndApi(): Promise<void> {
  showStatus('تشغيل قاعدة البيانات…');
  await pg.start();
  await pg.bootstrap(secrets);
  showStatus('تحديث قاعدة البيانات…');
  await migrate({ pg, secrets, webOrigin: origin });
  showStatus('تشغيل البرنامج…');
  await api.start({ pg, secrets, webOrigin: origin });
  web.apiPort = api.port;
}

async function stopDatabaseAndApi(): Promise<void> {
  await api.stop();
  await pg.stop();
}

async function backupNow(kind: 'auto' | 'manual'): Promise<string> {
  const file = await createBackup(settings.backupDir, kind);
  settings.lastBackupAt = new Date().toISOString();
  saveSettings(settings);
  return file;
}

function companySetup(): Promise<void> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 720,
      height: 760,
      title: 'إعداد الشركة — أوتوهب برو',
      webPreferences: securePrefs(),
    });
    win.setMenuBarVisibility(false);
    let done = false;
    ipcMain.handle('setup:submit', async (_e, input: CompanySetup) => {
      try {
        await provisionCompany({ pg, secrets, webOrigin: origin }, input);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      done = true;
      ipcMain.removeHandler('setup:submit');
      setTimeout(() => {
        win.destroy();
        resolve();
      }, 300);
      return { ok: true };
    });
    win.on('closed', () => {
      if (!done) app.quit();
    });
    void win.loadFile(path.join(paths.renderer, 'setup.html'));
  });
}

// ── main window ────────────────────────────────────────────────────────────────────────────────
function openMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'أوتوهب برو',
    webPreferences: securePrefs(false),
  });
  mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  const local = (url: string) => url === origin || url.startsWith(`${origin}/`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Documents (PDF previews) open in a window of the app; web links in the default browser.
    if (local(url) || url.startsWith('blob:')) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: securePrefs(false) } };
    }
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!local(url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  mainWindow.on('closed', () => (mainWindow = null));
  void mainWindow.loadURL(`${origin}/`);
}

/** Stops the services, runs `task` with the database stopped, starts everything again. */
async function maintenance(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    mainWindow?.hide();
    showStatus('إيقاف الخدمات…');
    await stopDatabaseAndApi();
    try {
      await task();
    } finally {
      await startDatabaseAndApi();
      hideStatus();
      mainWindow?.reload();
      mainWindow?.show();
    }
  } catch (err) {
    hideStatus();
    fail('حدث خطأ', err);
    mainWindow?.show();
  } finally {
    busy = false;
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'الملف',
      submenu: [
        {
          label: 'نسخة احتياطية الآن',
          click: () =>
            void maintenance(async () => {
              showStatus('جاري حفظ نسخة احتياطية…');
              const file = await backupNow('manual');
              void dialog.showMessageBox({ type: 'info', message: 'تم حفظ النسخة الاحتياطية', detail: file });
            }),
        },
        {
          label: 'استرجاع نسخة احتياطية…',
          click: async () => {
            const confirm = await dialog.showMessageBox({
              type: 'warning',
              buttons: ['اختيار ملف النسخة', 'إلغاء'],
              defaultId: 1,
              cancelId: 1,
              message: 'استرجاع نسخة احتياطية',
              detail:
                'ستُستبدل كل البيانات الحالية بمحتوى النسخة المختارة. تُحفظ البيانات الحالية بجانبها حتى الاسترجاع التالي.',
            });
            if (confirm.response !== 0) return;
            const pick = await dialog.showOpenDialog({
              defaultPath: settings.backupDir,
              properties: ['openFile'],
              filters: [{ name: 'AutoHub Pro backup', extensions: ['gz'] }],
            });
            const file = pick.filePaths[0];
            if (pick.canceled || !file) return;
            await maintenance(async () => {
              showStatus('جاري الاسترجاع…');
              try {
                await restoreBackup(file);
              } catch (err) {
                const bad = err instanceof Error && err.message === 'not_a_backup';
                throw new Error(bad ? 'الملف المختار ليس نسخة احتياطية من أوتوهب برو. لم يتغير شيء.' : String(err));
              }
              secrets = loadOrCreateSecrets();
              void dialog.showMessageBox({ type: 'info', message: 'تم الاسترجاع', detail: file });
            });
          },
        },
        { label: 'فتح مجلد النسخ الاحتياطية', click: () => void shell.openPath(settings.backupDir) },
        {
          label: 'تغيير مجلد النسخ الاحتياطية…',
          click: async () => {
            const pick = await dialog.showOpenDialog({ defaultPath: settings.backupDir, properties: ['openDirectory', 'createDirectory'] });
            const dir = pick.filePaths[0];
            if (pick.canceled || !dir) return;
            settings.backupDir = dir;
            saveSettings(settings);
            void dialog.showMessageBox({ type: 'info', message: 'سيتم حفظ النسخ الاحتياطية في', detail: dir });
          },
        },
        { type: 'separator' },
        { label: 'خروج', role: 'quit' },
      ],
    },
    {
      label: 'عرض',
      submenu: [
        { label: 'إعادة تحميل', role: 'reload' },
        { label: 'تكبير', role: 'zoomIn' },
        { label: 'تصغير', role: 'zoomOut' },
        { label: 'الحجم الافتراضي', role: 'resetZoom' },
        { label: 'ملء الشاشة', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'مساعدة',
      submenu: [
        { label: 'دليل المستخدم', click: () => void shell.openPath(paths.guide) },
        { label: 'فتح مجلد السجلات', click: () => void shell.openPath(paths.logs) },
        {
          label: 'عن البرنامج',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: 'عن البرنامج',
              message: `أوتوهب برو — الإصدار ${app.getVersion()}`,
              detail: [
                `مرخّص لـ: ${license?.name ?? ''}`,
                `صلاحية الترخيص: ${license?.exp ? `حتى ${license.exp}` : 'دائم'}`,
                `رمز الجهاز: ${code}`,
                `مجلد البيانات: ${dataDir}`,
                `مجلد النسخ الاحتياطية: ${settings.backupDir}`,
                `آخر نسخة احتياطية: ${settings.lastBackupAt ? new Date(settings.lastBackupAt).toLocaleString('ar') : 'لا يوجد'}`,
              ].join('\n'),
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── lifecycle ──────────────────────────────────────────────────────────────────────────────────
async function startup(): Promise<void> {
  // Electron grants permission requests (camera, microphone, location, notifications…) by default.
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  fs.mkdirSync(dataDir, { recursive: true });
  settings = loadSettings();
  code = await machineCode();
  ipcMain.handle('clipboard:write', (_e, text: unknown) => clipboard.writeText(String(text)));
  ipcMain.handle('app:quit', () => app.quit());

  license = await ensureLicense();
  settings.lastSeenAt = new Date(Math.max(Date.now(), Date.parse(settings.lastSeenAt ?? '') || 0)).toISOString();
  saveSettings(settings);

  secrets = loadOrCreateSecrets();
  if (!pg.initialised) {
    showStatus('تجهيز قاعدة البيانات لأول مرة…');
    await pg.init(secrets);
  } else if (!settings.lastBackupAt || Date.now() - Date.parse(settings.lastBackupAt) > DAY) {
    // The database is stopped here, so a daily copy can be taken before anything starts.
    await pg.stop();
    showStatus('نسخة احتياطية يومية…');
    await backupNow('auto');
  }

  let port: number;
  try {
    port = await web.listen(settings.webPort);
  } catch {
    port = await web.listen(await freePort());
  }
  if (port !== settings.webPort) {
    settings.webPort = port;
    saveSettings(settings);
  }
  origin = `http://127.0.0.1:${port}`;

  await startDatabaseAndApi();
  api.onUnexpectedExit = (exitCode) => {
    if (quitting || busy) return;
    fail('توقف البرنامج بشكل غير متوقع', new Error(`exit code ${exitCode}; restarting`));
    void maintenance(async () => undefined);
  };

  if ((await pg.companyCount(secrets)) === 0) {
    hideStatus();
    await companySetup();
  }
  hideStatus();
  buildMenu();
  openMainWindow();
  started = true;
}

async function shutdown(): Promise<void> {
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  try {
    await web.close();
    await stopDatabaseAndApi();
    if (pg.initialised && secrets) await backupNow('auto');
  } catch (err) {
    fs.mkdirSync(paths.logs, { recursive: true });
    fs.appendFileSync(path.join(paths.logs, 'desktop.log'), `${new Date().toISOString()} shutdown: ${String(err)}\n`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('pro.autohub.desktop');
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => {
    // During shutdown the windows are destroyed on purpose; quitting again here would end the
    // process before the database is stopped and backed up.
    if (started && !quitting) app.quit();
  });
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void shutdown().finally(() => app.exit(0));
  });
  app
    .whenReady()
    .then(startup)
    .catch((err: unknown) => {
      hideStatus();
      fail('تعذر تشغيل أوتوهب برو', err);
      quitting = true;
      void stopDatabaseAndApi().finally(() => app.exit(1));
    });
}
