import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { TenantContext } from '../../common/context';
import { getEnv } from '../../config/env';
import { DbService } from '../../db/db.service';
import { SYSTEM_USER_ID, systemContext } from './system-context';

export interface Job {
  name: string;
  everyMs: number;
  /** Runs once per active tenant, each in its own transaction with RLS set to that tenant. */
  run: (ctx: TenantContext) => Promise<unknown>;
}

/**
 * In-process scheduler (D-012). A session-level advisory lock per job guarantees only one
 * instance runs a job at a time across API replicas; each tenant runs in its own transaction so
 * one tenant's failure never blocks the others.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly jobs = new Map<string, Job & { lastRun: number }>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dbs: DbService) {}

  register(job: Job): void {
    this.jobs.set(job.name, { ...job, lastRun: 0 });
  }

  onApplicationBootstrap(): void {
    if (!getEnv().JOBS_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const job of this.jobs.values()) {
        if (now - job.lastRun < job.everyMs) continue;
        job.lastRun = now;
        await this.runJob(job.name).catch((e: Error) => this.logger.error(`job ${job.name} failed: ${e.message}`));
      }
    } finally {
      this.running = false;
    }
  }

  /** Runs a job now (also used by tests). Returns per-tenant results, or null if another instance holds the lock. */
  async runJob(name: string, opts: { tenantId?: string } = {}): Promise<Array<{ tenantId: string; ok: boolean; result?: unknown; error?: string }> | null> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`unknown job ${name}`);
    const client = await this.dbs.pool.connect();
    try {
      const lockKey = `autohub:job:${name}`;
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
      if (!rows[0]?.ok) return null;
      try {
        const tenantIds = opts.tenantId
          ? [opts.tenantId]
          : (await this.dbs.runInTenant({ tenantId: null, userId: null }, () => this.dbs.query<{ id: string }>('SELECT id FROM app_active_tenants()'))).map((r) => r.id);
        const results: Array<{ tenantId: string; ok: boolean; result?: unknown; error?: string }> = [];
        for (const tenantId of tenantIds) {
          try {
            const result = await this.dbs.runInTenant({ tenantId, userId: SYSTEM_USER_ID }, async () => job.run(await systemContext(this.dbs, tenantId)));
            results.push({ tenantId, ok: true, result });
          } catch (e) {
            this.logger.error(`job ${name} failed for tenant ${tenantId}: ${(e as Error).message}`);
            results.push({ tenantId, ok: false, error: (e as Error).message });
          }
        }
        return results;
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
      }
    } finally {
      client.release();
    }
  }
}
