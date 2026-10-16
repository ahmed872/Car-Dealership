import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient, types } from 'pg';
import { getEnv } from '../config/env';
import * as schema from './schema';

// Keep numeric/decimal as strings (default), parse int8 counts as JS numbers (safe for counts/sequences).
types.setTypeParser(types.builtins.INT8, (v) => Number(v));
// Keep DATE as an ISO string ("YYYY-MM-DD") — never shift calendar dates through JS Date/time zones.
types.setTypeParser(types.builtins.DATE, (v) => v);

export type Database = NodePgDatabase<typeof schema>;

export interface TxContext {
  tenantId: string | null;
  userId: string | null;
}

interface TxStore {
  db: Database;
  client: PoolClient;
  ctx: TxContext;
  afterCommit: Array<() => void | Promise<void>>;
  onRollback: Array<() => void | Promise<void>>;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly pool: Pool;
  private readonly als = new AsyncLocalStorage<TxStore>();

  constructor() {
    const env = getEnv();
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      application_name: 'autohub-api',
    });
    this.pool.on('error', (err) => this.logger.error(`Idle client error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Refuses to run when the configured role could bypass RLS: superuser, BYPASSRLS, or owner
   * of any application table. This turns a misconfiguration into a startup failure instead of
   * a silent loss of tenant isolation.
   */
  async assertSafeRole(): Promise<void> {
    const { rows } = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owned: number }>(
      `SELECT r.rolsuper, r.rolbypassrls,
              (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const r = rows[0];
    if (!r || r.rolsuper || r.rolbypassrls || r.owned > 0) {
      throw new Error(
        'DATABASE_URL role is unsafe for multi-tenancy (superuser, BYPASSRLS, or table owner). Use the autohub_app role.',
      );
    }
  }

  /** The current request transaction. Throws if called outside runInTenant(). */
  get db(): Database {
    const store = this.als.getStore();
    if (!store) throw new Error('No active database transaction (use runInTenant)');
    return store.db;
  }

  get context(): TxContext | null {
    return this.als.getStore()?.ctx ?? null;
  }

  get inTransaction(): boolean {
    return this.als.getStore() !== undefined;
  }

  /** Registers work to run after a successful commit (e.g. deleting files, sending notifications). */
  afterCommit(fn: () => void | Promise<void>): void {
    const store = this.als.getStore();
    if (!store) throw new Error('afterCommit requires an active transaction');
    store.afterCommit.push(fn);
  }

  /** Registers compensation work if the transaction rolls back (e.g. removing an uploaded object). */
  onRollback(fn: () => void | Promise<void>): void {
    const store = this.als.getStore();
    if (!store) throw new Error('onRollback requires an active transaction');
    store.onRollback.push(fn);
  }

  /** Raw query on the current transaction connection (for SQL functions like app_next_number). */
  async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const store = this.als.getStore();
    if (!store) throw new Error('No active database transaction');
    const res = await store.client.query<T>(sql, params);
    return res.rows;
  }

  /**
   * Runs `fn` inside one transaction with transaction-local tenant/user context.
   * Joins the enclosing transaction when already inside one with the same context.
   */
  async runInTenant<T>(ctx: TxContext, fn: () => Promise<T>): Promise<T> {
    const existing = this.als.getStore();
    if (existing) {
      if (existing.ctx.tenantId !== ctx.tenantId || existing.ctx.userId !== ctx.userId) {
        throw new Error('Nested transaction with a different tenant context is not allowed');
      }
      return fn();
    }
    const client = await this.pool.connect();
    let committed = false;
    const store: TxStore = { db: drizzle(client, { schema }), client, ctx, afterCommit: [], onRollback: [] };
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [ctx.tenantId ?? '', ctx.userId ?? ''],
      );
      const result = await this.als.run(store, fn);
      await client.query('COMMIT');
      committed = true;
      return result;
    } catch (err) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
      const hooks = committed ? store.afterCommit : store.onRollback;
      if (hooks.length) {
        for (const hook of hooks) {
          try {
            await hook();
          } catch (e) {
            this.logger.error(`transaction hook failed: ${(e as Error).message}`);
          }
        }
      }
    }
  }
}
