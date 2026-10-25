import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Secrets } from './config';
import { type Postgres, freePort } from './database';
import { paths } from './paths';

/** Chromium-based browser for PDF rendering: Edge ships with Windows 10/11. */
export function findChromium(): string | undefined {
  const env = process.env.AUTOHUB_CHROMIUM_PATH;
  const candidates: string[] = env ? [env] : [];
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  } else {
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge');
  }
  return candidates.find((p) => fs.existsSync(p));
}

export interface ApiEnvInput {
  pg: Postgres;
  secrets: Secrets;
  webOrigin: string;
  port: number;
}

function apiEnv({ pg, secrets, webOrigin, port }: ApiEnvInput): NodeJS.ProcessEnv {
  const chromium = findChromium();
  return {
    // The system environment (Windows needs SystemRoot, TEMP, ProgramFiles… for the PDF browser).
    ...process.env,
    // Electron's own binary runs the API as plain Node.
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: pg.url('autohub_app', secrets.appPassword),
    DATABASE_MIGRATION_URL: pg.url('autohub_owner', secrets.ownerPassword),
    DATABASE_POOL_MAX: '10',
    APP_ORIGINS: webOrigin,
    PUBLIC_WEB_URL: webOrigin,
    APP_ENCRYPTION_KEY: secrets.encryptionKey,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: paths.storage,
    JOBS_ENABLED: 'true',
    TRUST_PROXY: 'false',
    LOG_LEVEL: 'info',
    // One user at one desk: generous limits for the local machine (everything comes from 127.0.0.1).
    RATE_LIMIT_PER_MIN: '6000',
    AUTH_RATE_LIMIT_PER_MIN: '30',
    EXPORT_RATE_LIMIT_PER_MIN: '60',
    ...(chromium ? { CHROMIUM_PATH: chromium } : {}),
  };
}

function logStream(name: string): fs.WriteStream {
  fs.mkdirSync(paths.logs, { recursive: true });
  const file = path.join(paths.logs, name);
  // Keep logs bounded: start over when a file passes 10 MB.
  try {
    if (fs.statSync(file).size > 10 * 1024 * 1024) fs.rmSync(file);
  } catch {
    // no previous log
  }
  return fs.createWriteStream(file, { flags: 'a' });
}

/** Runs a script of the API bundle to completion (migrations, provisioning). */
function runScript(script: string, args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(paths.api, 'dist', script), ...args], {
      cwd: paths.api,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const log = logStream('api-tasks.log');
    let out = '';
    let err = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      log.write(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      err += d.toString();
      log.write(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      log.end();
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || out.trim() || `${script} exited with code ${code}`));
    });
    child.stdin!.end(stdin ?? '');
  });
}

export async function migrate(input: Omit<ApiEnvInput, 'port'>): Promise<void> {
  await runScript('db/migrate.js', [], apiEnv({ ...input, port: 1 }));
}

export interface CompanySetup {
  name: string;
  market: 'EG' | 'SA' | 'AE';
  branchName: string;
  owner: { fullName: string; email: string; password: string };
}

export async function provisionCompany(input: Omit<ApiEnvInput, 'port'>, setup: CompanySetup): Promise<void> {
  const payload = {
    name: setup.name,
    slug: 'company',
    market: setup.market,
    locale: 'ar',
    branchName: setup.branchName,
    planCode: 'enterprise',
    owner: setup.owner,
  };
  await runScript('cli.js', ['provision-tenant', '-'], apiEnv({ ...input, port: 1 }), JSON.stringify(payload));
}

export class ApiServer {
  port = 0;
  private child: ChildProcess | null = null;
  private stopping = false;
  onUnexpectedExit: ((code: number | null) => void) | null = null;

  async start(input: Omit<ApiEnvInput, 'port'>): Promise<void> {
    this.port = await freePort();
    this.stopping = false;
    const log = logStream('api.log');
    const child = spawn(process.execPath, [path.join(paths.api, 'dist', 'main.js')], {
      cwd: paths.api,
      env: apiEnv({ ...input, port: this.port }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout!.pipe(log);
    child.stderr!.pipe(log);
    let exited = false;
    child.on('exit', (code) => {
      exited = true;
      this.child = null;
      if (!this.stopping) this.onUnexpectedExit?.(code);
    });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`The API stopped during start-up; see ${path.join(paths.logs, 'api.log')}`);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/api/v1/health/ready`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    await this.stop();
    throw new Error(`The API did not become ready in time; see ${path.join(paths.logs, 'api.log')}`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
    this.child = null;
  }
}
