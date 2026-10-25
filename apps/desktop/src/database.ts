import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import type { Secrets } from './config';
import { paths } from './paths';

const exe = (name: string) => path.join(paths.postgres, 'bin', process.platform === 'win32' ? `${name}.exe` : name);

export const DB_NAME = 'autohub';

/** Windows finds the DLLs next to the executables; Linux and macOS need the bundled lib/ on the path. */
function toolEnv(): NodeJS.ProcessEnv {
  const lib = path.join(paths.postgres, 'lib');
  const env: NodeJS.ProcessEnv = { ...process.env, LC_MESSAGES: 'C' };
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = [lib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
  return env;
}

/** Runs a PostgreSQL tool and resolves with its output; rejects with the output on a non-zero exit. */
function tool(name: string, args: string[], logFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe(name), args, { windowsHide: true, env: toolEnv() });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      fs.appendFileSync(logFile, `\n$ ${name} ${args.join(' ')}\n${out}`);
      if (code === 0) resolve(out);
      else reject(new Error(`${name} exited with code ${code}: ${out.trim().slice(-800)}`));
    });
  });
}

export function freePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => {
      if (preferred && err.code === 'EADDRINUSE') freePort(0).then(resolve, reject);
      else reject(err);
    });
    srv.listen(preferred, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export class Postgres {
  port = 0;
  private readonly log = path.join(paths.logs, 'postgres.log');

  constructor(private readonly dataDir = paths.pgdata) {}

  get initialised(): boolean {
    return fs.existsSync(path.join(this.dataDir, 'PG_VERSION'));
  }

  /** Creates the cluster: password authentication only, listening on loopback only. */
  async init(secrets: Secrets): Promise<void> {
    fs.mkdirSync(paths.logs, { recursive: true });
    const pwfile = path.join(os.tmpdir(), `autohub-pw-${process.pid}-${Date.now()}`);
    fs.writeFileSync(pwfile, secrets.superPassword, { mode: 0o600 });
    try {
      // On Windows UTF8 works with any system locale; elsewhere use C.UTF-8 so Arabic text is
      // classified correctly (trigram search).
      const locale = process.platform === 'win32' ? [] : ['--locale=C.UTF-8'];
      await tool(
        'initdb',
        ['-D', this.dataDir, '-U', 'postgres', `--pwfile=${pwfile}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--data-checksums', ...locale],
        this.log,
      );
    } finally {
      fs.rmSync(pwfile, { force: true });
    }
    fs.appendFileSync(
      path.join(this.dataDir, 'postgresql.conf'),
      "\n# AutoHub Pro desktop\nlisten_addresses = '127.0.0.1'\nmax_connections = 40\nshared_buffers = 128MB\n",
    );
  }

  async start(): Promise<void> {
    fs.mkdirSync(paths.logs, { recursive: true });
    // A previous run that crashed leaves the server running (pg_ctl detaches): stop it first so
    // it restarts on the port chosen now.
    if (fs.existsSync(path.join(this.dataDir, 'postmaster.pid'))) {
      await tool('pg_ctl', ['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '60'], this.log).catch(() => undefined);
    }
    this.port = await freePort();
    await tool(
      'pg_ctl',
      ['start', '-D', this.dataDir, '-w', '-t', '120', '-l', path.join(paths.logs, 'postgres-server.log'), '-o', `-p ${this.port}`],
      this.log,
    );
  }

  async stop(): Promise<void> {
    if (!fs.existsSync(path.join(this.dataDir, 'postmaster.pid'))) return;
    await tool('pg_ctl', ['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '120'], this.log);
  }

  url(user: string, password: string, db = DB_NAME): string {
    return `postgres://${user}:${password}@127.0.0.1:${this.port}/${db}`;
  }

  /**
   * Same roles as infra/db/bootstrap-roles.sql: autohub_owner runs migrations, autohub_app is what the
   * API uses (not superuser, not BYPASSRLS, owns nothing, so row-level security always applies).
   * Idempotent; passwords are re-applied so they always match secrets.json.
   */
  async bootstrap(secrets: Secrets): Promise<void> {
    const c = new Client({ connectionString: this.url('postgres', secrets.superPassword, 'postgres') });
    await c.connect();
    try {
      const role = async (name: string, attrs: string, pw: string) => {
        const { rowCount } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
        const verb = rowCount ? 'ALTER' : 'CREATE';
        await c.query(`${verb} ROLE ${name} ${attrs} PASSWORD ${c.escapeLiteral(pw)}`);
      };
      await role('autohub_owner', 'LOGIN', secrets.ownerPassword);
      await role('autohub_app', 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', secrets.appPassword);
      const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
      if (!rowCount) {
        await c.query(`CREATE DATABASE ${DB_NAME} OWNER autohub_owner ENCODING 'UTF8' TEMPLATE template0`);
        await c.query(`REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC`);
        await c.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${DB_NAME} TO autohub_app`);
      }
    } finally {
      await c.end();
    }
  }

  /** Number of companies (0 until the first-run setup has provisioned one). */
  async companyCount(secrets: Secrets): Promise<number> {
    const c = new Client({ connectionString: this.url('postgres', secrets.superPassword) });
    await c.connect();
    try {
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM tenants');
      return rows[0]?.n ?? 0;
    } finally {
      await c.end();
    }
  }
}
