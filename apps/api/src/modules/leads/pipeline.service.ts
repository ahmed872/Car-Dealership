import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { PipelineStageKind, zPipelineStageCreate, zPipelineStageUpdate } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { pipelineStages } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';

registerUniqueConstraint('pipeline_stages_code_uq', 'stage_code_taken', 'A pipeline stage with this code already exists');

export type StageRow = typeof pipelineStages.$inferSelect;
type StageCreate = z.infer<typeof zPipelineStageCreate>;
type StageUpdate = z.infer<typeof zPipelineStageUpdate>;
type StageChanges = Partial<Pick<StageRow, 'nameEn' | 'nameAr' | 'sortOrder' | 'probabilityPct' | 'isActive'>>;

/** API shape of a stage: `isDefault` marks the platform default, `isTerminal` won/lost. */
export function presentStage(s: StageRow) {
  return {
    id: s.id,
    code: s.code,
    nameEn: s.nameEn,
    nameAr: s.nameAr,
    sortOrder: s.sortOrder,
    kind: s.kind as PipelineStageKind,
    probabilityPct: s.probabilityPct,
    isActive: s.isActive,
    isDefault: s.tenantId === null,
    isTerminal: s.kind !== 'open',
  };
}

/**
 * Sales pipeline stages. Platform defaults (tenant_id NULL) are shared by every company and are
 * read-only under RLS, so a company customises a default copy-on-write: editing or deactivating a
 * default creates the company's own stage with the same code, which then replaces ("shadows") the
 * default, and the company's leads are re-pointed to it. The effective pipeline is therefore, per
 * code, the company's own stage if it has one, else the default.
 *
 * Invariants: code and kind never change (leads and history keep their meaning); won/lost stages
 * are terminal with probability 100 / 0; at least one active stage of each kind remains (an open
 * stage for new leads, a won stage to close a sale, a lost stage for lost leads); a stage that
 * still holds open leads cannot be deactivated unless they are moved, with history, to another
 * active open stage. Stage administration takes an exclusive per-tenant advisory lock and lead
 * moves take it shared, so a lead can never land in a stage that is being deactivated.
 */
@Injectable()
export class PipelineService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Per-tenant pipeline lock: exclusive for stage administration, shared for lead moves. */
  async lockStages(mode: 'shared' | 'exclusive'): Promise<void> {
    const fn = mode === 'exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
    await this.dbs.query(`SELECT ${fn}(hashtext('autohub:pipeline:' || app_current_tenant()::text))`);
  }

  /** Every stage the tenant can see (RLS: platform defaults + its own), in pipeline order. */
  private async visible(): Promise<StageRow[]> {
    return this.dbs.db.select().from(pipelineStages).orderBy(asc(pipelineStages.sortOrder), asc(pipelineStages.code));
  }

  /** The tenant's effective pipeline (own stages shadow defaults with the same code). */
  async effective(opts: { includeInactive?: boolean } = {}): Promise<StageRow[]> {
    const rows = await this.visible();
    const own = new Set(rows.filter((r) => r.tenantId !== null).map((r) => r.code));
    return rows.filter((r) => (r.tenantId !== null || !own.has(r.code)) && (opts.includeInactive || r.isActive));
  }

  async list(includeInactive: boolean) {
    return (await this.effective({ includeInactive })).map(presentStage);
  }

  /** Stage rows by id (any visible stage, including shadowed defaults referenced by history). */
  async byIds(ids: string[]): Promise<Map<string, StageRow>> {
    const wanted = new Set(ids);
    return new Map((await this.visible()).filter((r) => wanted.has(r.id)).map((r) => [r.id, r]));
  }

  /** Resolves an id to the effective stage: a shadowed default maps to the tenant's own copy. */
  async resolve(id: string): Promise<StageRow> {
    const rows = await this.visible();
    const s = rows.find((r) => r.id === id);
    if (!s) throw notFound('Pipeline stage');
    if (s.tenantId === null) return rows.find((r) => r.tenantId !== null && r.code === s.code) ?? s;
    return s;
  }

  /** First active stage of a kind in pipeline order (preferring `preferCode` when active). */
  async firstActive(kind: PipelineStageKind, preferCode?: string): Promise<StageRow | null> {
    const eff = (await this.effective()).filter((s) => s.kind === kind);
    return (preferCode ? eff.find((s) => s.code === preferCode) : undefined) ?? eff[0] ?? null;
  }

  private probability(kind: string, p: number | undefined, current?: number): number {
    if (kind === 'won' || kind === 'lost') {
      const fixed = kind === 'won' ? 100 : 0;
      if (p !== undefined && p !== fixed) throw unprocessable('invalid_probability', `A ${kind} stage always has ${fixed}% probability`);
      return fixed;
    }
    return p ?? current ?? 0;
  }

  async create(ctx: TenantContext, input: StageCreate) {
    await this.lockStages('exclusive');
    const rows = await this.visible();
    const clash = rows.find((r) => r.code === input.code);
    if (clash) {
      throw conflict(
        'stage_code_taken',
        clash.tenantId === null ? 'This code belongs to a default stage; edit that stage instead' : 'A pipeline stage with this code already exists',
        { stageId: clash.id },
      );
    }
    const [s] = await this.dbs.db
      .insert(pipelineStages)
      .values({
        tenantId: ctx.tenant.id,
        code: input.code,
        nameEn: input.nameEn,
        nameAr: input.nameAr,
        sortOrder: input.sortOrder,
        kind: input.kind,
        probabilityPct: this.probability(input.kind, input.probabilityPct),
      })
      .returning();
    await this.audit.record({ action: 'pipeline_stage.created', entityType: 'pipeline_stage', entityId: s!.id, summary: `Stage ${s!.code} (${s!.kind})`, after: s });
    return presentStage(s!);
  }

  async update(ctx: TenantContext, id: string, input: StageUpdate) {
    await this.lockStages('exclusive');
    const s = await this.resolve(id);
    const changes: StageChanges = {};
    if (input.nameEn !== undefined) changes.nameEn = input.nameEn;
    if (input.nameAr !== undefined) changes.nameAr = input.nameAr;
    if (input.sortOrder !== undefined) changes.sortOrder = input.sortOrder;
    if (input.probabilityPct !== undefined) changes.probabilityPct = this.probability(s.kind, input.probabilityPct, s.probabilityPct);
    if (!Object.keys(changes).length) return presentStage(s);
    if (s.tenantId === null) return presentStage(await this.materialize(ctx, s, changes));
    const [after] = await this.dbs.db.update(pipelineStages).set(changes).where(eq(pipelineStages.id, s.id)).returning();
    await this.audit.record({ action: 'pipeline_stage.updated', entityType: 'pipeline_stage', entityId: s.id, ...diff(s, after!) });
    return presentStage(after!);
  }

  /**
   * Deactivates a stage. Open leads still in it are refused (`stage_in_use`) unless
   * `moveToStageId` names another active open stage; they are then moved there with history.
   */
  async deactivate(ctx: TenantContext, id: string, input: { moveToStageId?: string }) {
    await this.lockStages('exclusive');
    let s = await this.resolve(id);
    if (!s.isActive) throw conflict('stage_inactive', 'This stage is already inactive');
    const eff = await this.effective();
    if (!eff.some((x) => x.id !== s.id && x.kind === s.kind)) {
      throw conflict(`last_${s.kind}_stage`, `At least one ${s.kind} stage must stay active`, { kind: s.kind });
    }
    if (s.tenantId === null) s = await this.materialize(ctx, s, {});
    const [open] = await this.dbs.query<{ n: number }>(`SELECT count(*)::int AS n FROM leads WHERE stage_id = $1 AND status = 'open'`, [s.id]);
    let moved = 0;
    let dest: StageRow | null = null;
    if ((open?.n ?? 0) > 0) {
      if (!input.moveToStageId) {
        throw conflict('stage_in_use', 'Open leads are still in this stage; move them to another stage first', { openLeads: open!.n });
      }
      dest = await this.resolve(input.moveToStageId);
      if (dest.id === s.id || !dest.isActive || dest.kind !== 'open') {
        throw unprocessable('invalid_move_target', 'Open leads can only be moved to another active open stage');
      }
      const [r] = await this.dbs.query<{ n: number }>(
        `WITH moved AS (
            UPDATE leads SET stage_id = $2, version = version + 1, updated_at = now()
             WHERE stage_id = $1 AND status = 'open'
         RETURNING id, tenant_id),
          hist AS (
            INSERT INTO lead_stage_history (tenant_id, lead_id, from_stage_id, to_stage_id, from_status, to_status, note, changed_by)
            SELECT tenant_id, id, $1, $2, 'open', 'open', $3, $4 FROM moved
         RETURNING 1)
         SELECT count(*)::int AS n FROM hist`,
        [s.id, dest.id, `Stage ${s.code} deactivated`, ctx.userId],
      );
      moved = r?.n ?? 0;
    }
    const [after] = await this.dbs.db.update(pipelineStages).set({ isActive: false }).where(eq(pipelineStages.id, s.id)).returning();
    await this.audit.record({
      action: 'pipeline_stage.deactivated',
      entityType: 'pipeline_stage',
      entityId: s.id,
      summary: `Stage ${s.code} deactivated${moved ? `; ${moved} open leads moved to ${dest!.code}` : ''}`,
      before: { isActive: true },
      after: { isActive: false, movedLeads: moved, moveToStageId: dest?.id ?? null },
    });
    return { ...presentStage(after!), movedLeads: moved };
  }

  async activate(ctx: TenantContext, id: string) {
    await this.lockStages('exclusive');
    const s = await this.resolve(id);
    if (s.isActive) return presentStage(s);
    if (s.tenantId === null) return presentStage(await this.materialize(ctx, s, { isActive: true }));
    const [after] = await this.dbs.db.update(pipelineStages).set({ isActive: true }).where(eq(pipelineStages.id, s.id)).returning();
    await this.audit.record({ action: 'pipeline_stage.activated', entityType: 'pipeline_stage', entityId: s.id, before: { isActive: false }, after: { isActive: true } });
    return presentStage(after!);
  }

  /**
   * Copy-on-write of a platform default: creates the tenant's own stage with the same code (and
   * the given changes) and re-points the tenant's leads from the default to it. Stage history
   * keeps referring to the default row, which stays readable.
   */
  private async materialize(ctx: TenantContext, g: StageRow, changes: StageChanges): Promise<StageRow> {
    const [own] = await this.dbs.db
      .insert(pipelineStages)
      .values({
        tenantId: ctx.tenant.id,
        code: g.code,
        nameEn: g.nameEn,
        nameAr: g.nameAr,
        sortOrder: g.sortOrder,
        kind: g.kind,
        probabilityPct: g.probabilityPct,
        isActive: g.isActive,
        ...changes,
      })
      .returning();
    const [r] = await this.dbs.query<{ n: number }>(
      `WITH u AS (UPDATE leads SET stage_id = $2 WHERE stage_id = $1 RETURNING 1) SELECT count(*)::int AS n FROM u`,
      [g.id, own!.id],
    );
    await this.audit.record({
      action: 'pipeline_stage.customized',
      entityType: 'pipeline_stage',
      entityId: own!.id,
      summary: `Default stage ${g.code} customised`,
      before: presentStage(g),
      after: presentStage(own!),
      metadata: { replacesDefaultStageId: g.id, leadsRepointed: r?.n ?? 0 },
    });
    return own!;
  }
}
