import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { InspectionSaveInput, PANEL_CODES, TemplateSections, zInspectionStart, zTemplateInput } from '@autohub/shared';
import { assertBranchAccess, TenantContext } from '../../common/context';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { inspectionItems, inspectionMedia, inspectionPanels, inspectionTemplates, users, vehicleInspections, vehicles } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { FilesService, UploadedTemp } from '../files/files.service';
import { VehiclesService } from './vehicles.service';

@Injectable()
export class InspectionsService {
  constructor(
    private readonly dbs: DbService,
    private readonly vehicles: VehiclesService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  // ── Templates ─────────────────────────────────────────────────────────────────────────
  listTemplates() {
    return this.dbs.db
      .select()
      .from(inspectionTemplates)
      .where(eq(inspectionTemplates.isActive, true))
      .orderBy(desc(inspectionTemplates.isDefault), asc(inspectionTemplates.name));
  }

  async createTemplate(ctx: TenantContext, input: z.infer<typeof zTemplateInput>) {
    this.assertUniqueKeys(input.sections);
    if (input.isDefault) await this.clearDefault(ctx);
    const [t] = await this.dbs.db
      .insert(inspectionTemplates)
      .values({ tenantId: ctx.tenant.id, name: input.name, vehicleCategory: input.vehicleCategory, sections: input.sections, isDefault: input.isDefault })
      .returning();
    await this.audit.record({ action: 'inspection_template.created', entityType: 'inspection_template', entityId: t!.id, after: { name: t!.name } });
    return t;
  }

  async updateTemplate(ctx: TenantContext, id: string, input: z.infer<typeof zTemplateInput>) {
    this.assertUniqueKeys(input.sections);
    const [before] = await this.dbs.db.select().from(inspectionTemplates).where(and(eq(inspectionTemplates.id, id), eq(inspectionTemplates.tenantId, ctx.tenant.id)));
    if (!before) throw notFound('Template');
    if (input.isDefault) await this.clearDefault(ctx);
    // Existing inspections keep their own snapshot, so editing a template never rewrites history.
    const [after] = await this.dbs.db
      .update(inspectionTemplates)
      .set({ name: input.name, vehicleCategory: input.vehicleCategory, sections: input.sections, isDefault: input.isDefault, version: before.version + 1, updatedAt: new Date() })
      .where(eq(inspectionTemplates.id, id))
      .returning();
    await this.audit.record({ action: 'inspection_template.updated', entityType: 'inspection_template', entityId: id, after: { version: after!.version } });
    return after;
  }

  private async clearDefault(ctx: TenantContext) {
    await this.dbs.db.update(inspectionTemplates).set({ isDefault: false }).where(eq(inspectionTemplates.tenantId, ctx.tenant.id));
  }

  private assertUniqueKeys(sections: TemplateSections) {
    const keys = new Set<string>();
    for (const s of sections) {
      for (const i of s.items) {
        const k = `${s.key}.${i.key}`;
        if (keys.has(k)) throw unprocessable('duplicate_item_key', `Duplicate item key ${k}`);
        keys.add(k);
      }
    }
  }

  private async resolveTemplate(templateId?: string) {
    const db = this.dbs.db;
    if (templateId) {
      const [t] = await db.select().from(inspectionTemplates).where(and(eq(inspectionTemplates.id, templateId), eq(inspectionTemplates.isActive, true)));
      if (!t) throw notFound('Inspection template');
      return t;
    }
    // Tenant default first, then the platform default.
    const [t] = await db
      .select()
      .from(inspectionTemplates)
      .where(and(eq(inspectionTemplates.isDefault, true), eq(inspectionTemplates.isActive, true)))
      .orderBy(sql`${inspectionTemplates.tenantId} IS NULL`)
      .limit(1);
    if (!t) throw notFound('Default inspection template');
    return t;
  }

  // ── Inspections ───────────────────────────────────────────────────────────────────────
  async start(ctx: TenantContext, vehicleId: string, input: z.infer<typeof zInspectionStart>) {
    const v = await this.vehicles.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    if (['delivered', 'removed'].includes(v.status)) throw conflict('vehicle_closed', 'This vehicle is no longer in stock');
    const db = this.dbs.db;
    const [draft] = await db
      .select({ id: vehicleInspections.id })
      .from(vehicleInspections)
      .where(and(eq(vehicleInspections.vehicleId, vehicleId), eq(vehicleInspections.status, 'draft')))
      .limit(1);
    if (draft) throw conflict('inspection_in_progress', 'An inspection is already in progress for this vehicle', { inspectionId: draft.id });

    const template = await this.resolveTemplate(input.templateId);
    const sections = template.sections as TemplateSections;
    const [{ maxV }] = (await db
      .select({ maxV: max(vehicleInspections.versionNo) })
      .from(vehicleInspections)
      .where(eq(vehicleInspections.vehicleId, vehicleId))) as [{ maxV: number | null }];
    const [insp] = await db
      .insert(vehicleInspections)
      .values({
        tenantId: ctx.tenant.id,
        vehicleId,
        templateId: template.id,
        templateSnapshot: { name: template.name, version: template.version, sections },
        versionNo: (maxV ?? 0) + 1,
        type: input.type,
        inspectorUserId: ctx.userId,
        odometerValue: v.odometerValue,
        odometerUnit: v.odometerUnit,
      })
      .returning();
    await db.insert(inspectionItems).values(
      sections.flatMap((s) =>
        s.items.map((i) => ({
          tenantId: ctx.tenant.id,
          inspectionId: insp!.id,
          sectionKey: s.key,
          itemKey: i.key,
          labelEn: i.en,
          labelAr: i.ar,
          measuredUnit: i.unit ?? null,
        })),
      ),
    );
    await db.insert(inspectionPanels).values(PANEL_CODES.map((panelCode) => ({ tenantId: ctx.tenant.id, inspectionId: insp!.id, panelCode })));
    // Listed/reserved/sold vehicles keep their status during periodic re-inspection.
    if (['incoming', 'awaiting_inspection', 'in_preparation', 'ready', 'returned'].includes(v.status)) {
      await this.vehicles.transition(ctx, vehicleId, 'in_inspection', { system: true, source: 'system', sourceId: insp!.id, reason: 'inspection started' });
    }
    await this.audit.record({ action: 'inspection.started', entityType: 'vehicle', entityId: vehicleId, after: { inspectionId: insp!.id, versionNo: insp!.versionNo } });
    return insp;
  }

  private async load(id: string) {
    const [insp] = await this.dbs.db.select().from(vehicleInspections).where(eq(vehicleInspections.id, id));
    if (!insp) throw notFound('Inspection');
    const [v] = await this.dbs.db.select({ branchId: vehicles.branchId }).from(vehicles).where(eq(vehicles.id, insp.vehicleId));
    return { insp, branchId: v!.branchId };
  }

  async get(ctx: TenantContext, id: string) {
    const { insp, branchId } = await this.load(id);
    assertBranchAccess(ctx, branchId);
    const db = this.dbs.db;
    const [items, panels, media, inspector] = await Promise.all([
      db.select().from(inspectionItems).where(eq(inspectionItems.inspectionId, id)),
      db.select().from(inspectionPanels).where(eq(inspectionPanels.inspectionId, id)),
      db.select().from(inspectionMedia).where(eq(inspectionMedia.inspectionId, id)).orderBy(asc(inspectionMedia.createdAt)),
      insp.inspectorUserId ? db.select({ fullName: users.fullName }).from(users).where(eq(users.id, insp.inspectorUserId)) : Promise.resolve([]),
    ]);
    return { ...insp, inspectorName: inspector[0]?.fullName ?? null, items, panels, media };
  }

  async save(ctx: TenantContext, id: string, input: InspectionSaveInput) {
    const { insp, branchId } = await this.load(id);
    assertBranchAccess(ctx, branchId);
    if (insp.status !== 'draft') throw conflict('inspection_closed', 'Completed or cancelled inspections cannot be edited');
    const db = this.dbs.db;
    await db
      .update(vehicleInspections)
      .set({
        odometerValue: input.odometerValue === undefined ? insp.odometerValue : input.odometerValue,
        odometerUnit: input.odometerUnit === undefined ? insp.odometerUnit : input.odometerUnit,
        overallResult: input.overallResult === undefined ? insp.overallResult : input.overallResult,
        summary: input.summary === undefined ? insp.summary : input.summary,
        recommendations: input.recommendations === undefined ? insp.recommendations : input.recommendations,
        accidentHistory: input.accidentHistory === undefined ? insp.accidentHistory : input.accidentHistory,
        updatedAt: new Date(),
      })
      .where(eq(vehicleInspections.id, id));
    const existing = await db.select({ sectionKey: inspectionItems.sectionKey, itemKey: inspectionItems.itemKey }).from(inspectionItems).where(eq(inspectionItems.inspectionId, id));
    const known = new Set(existing.map((e) => `${e.sectionKey}.${e.itemKey}`));
    for (const it of input.items) {
      if (!known.has(`${it.sectionKey}.${it.itemKey}`)) throw unprocessable('unknown_item', `Unknown inspection item ${it.sectionKey}.${it.itemKey}`);
      await db
        .update(inspectionItems)
        .set({
          result: it.result,
          severity: it.result === 'ok' || it.result === 'na' ? 'none' : it.severity,
          measuredValue: it.measuredValue ?? null,
          measuredUnit: it.measuredUnit ?? undefined,
          measuredText: it.measuredText ?? null,
          isMeasured: it.measuredValue ? it.isMeasured : false,
          notes: it.notes ?? null,
        })
        .where(and(eq(inspectionItems.inspectionId, id), eq(inspectionItems.sectionKey, it.sectionKey), eq(inspectionItems.itemKey, it.itemKey)));
    }
    for (const p of input.panels) {
      await db
        .update(inspectionPanels)
        .set({ condition: p.condition, paintThicknessMicrons: p.paintThicknessMicrons ?? null, notes: p.notes ?? null })
        .where(and(eq(inspectionPanels.inspectionId, id), eq(inspectionPanels.panelCode, p.panelCode)));
    }
    return this.get(ctx, id);
  }

  /** Finalises the inspection. After this the DB rejects any modification (trigger). */
  async complete(ctx: TenantContext, id: string) {
    const { insp, branchId } = await this.load(id);
    assertBranchAccess(ctx, branchId);
    if (insp.status !== 'draft') throw conflict('inspection_closed', 'This inspection is not a draft');
    const db = this.dbs.db;
    const sections = (insp.templateSnapshot as { sections: TemplateSections }).sections;
    const required = new Set(sections.flatMap((s) => s.items.filter((i) => i.required).map((i) => `${s.key}.${i.key}`)));
    const items = await db.select().from(inspectionItems).where(eq(inspectionItems.inspectionId, id));
    const missing = items.filter((i) => required.has(`${i.sectionKey}.${i.itemKey}`) && i.result === 'not_checked').map((i) => `${i.sectionKey}.${i.itemKey}`);
    if (missing.length) throw unprocessable('inspection_incomplete', 'Some required items are not checked', { missing });
    if (!insp.overallResult) throw unprocessable('overall_result_required', 'Choose an overall result');
    if (insp.odometerValue === null) throw unprocessable('odometer_required', 'Record the odometer reading');
    const failedCritical = items.some((i) => i.result === 'fail' && i.severity === 'critical');
    if (failedCritical && insp.overallResult === 'pass') {
      throw unprocessable('inconsistent_result', 'An inspection with a critical failure cannot be marked as passed');
    }

    await db.update(vehicleInspections).set({ status: 'completed', completedAt: new Date(), inspectorUserId: ctx.userId, updatedAt: new Date() }).where(eq(vehicleInspections.id, id));
    const v = await this.vehicles.get(insp.vehicleId);
    if (insp.odometerValue !== v.odometerValue || insp.odometerUnit !== v.odometerUnit) {
      await this.vehicles.addOdometer(ctx, insp.vehicleId, {
        value: insp.odometerValue,
        unit: (insp.odometerUnit ?? 'km') as 'km' | 'mi',
        source: 'inspection',
        notes: `Inspection #${insp.versionNo}`,
      });
    }
    await this.audit.record({
      action: 'inspection.completed',
      entityType: 'vehicle',
      entityId: insp.vehicleId,
      summary: `Inspection #${insp.versionNo}: ${insp.overallResult}`,
      after: { inspectionId: id, overallResult: insp.overallResult, failed: items.filter((i) => i.result === 'fail').length },
    });
    return this.get(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string, reason: string) {
    const { insp, branchId } = await this.load(id);
    assertBranchAccess(ctx, branchId);
    if (insp.status !== 'draft') throw conflict('inspection_closed', 'Only drafts can be cancelled');
    await this.dbs.db.update(vehicleInspections).set({ status: 'cancelled', summary: reason, updatedAt: new Date() }).where(eq(vehicleInspections.id, id));
    await this.audit.record({ action: 'inspection.cancelled', entityType: 'vehicle', entityId: insp.vehicleId, after: { inspectionId: id, reason } });
    return { ok: true };
  }

  async addMedia(ctx: TenantContext, id: string, upload: UploadedTemp, meta: { itemKey?: string | null; panelCode?: string | null; caption?: string | null }) {
    const { insp, branchId } = await this.load(id);
    assertBranchAccess(ctx, branchId);
    if (insp.status !== 'draft') throw conflict('inspection_closed', 'Evidence can only be added while the inspection is open');
    if (meta.panelCode && !(PANEL_CODES as readonly string[]).includes(meta.panelCode)) throw unprocessable('unknown_panel', 'Unknown panel');
    const stored = await this.files.store(upload, { purpose: 'inspection_media', readPermission: 'inspections.read' });
    const [m] = await this.dbs.db
      .insert(inspectionMedia)
      .values({
        tenantId: ctx.tenant.id,
        inspectionId: id,
        fileId: stored.id,
        itemKey: meta.itemKey ?? null,
        panelCode: meta.panelCode ?? null,
        caption: meta.caption ?? null,
      })
      .returning();
    return m;
  }

  /** Latest completed inspection summary for listing/showroom decisions. */
  async latestCompleted(vehicleId: string) {
    const [insp] = await this.dbs.db
      .select()
      .from(vehicleInspections)
      .where(and(eq(vehicleInspections.vehicleId, vehicleId), eq(vehicleInspections.status, 'completed')))
      .orderBy(desc(vehicleInspections.versionNo))
      .limit(1);
    return insp ?? null;
  }
}

