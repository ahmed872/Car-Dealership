import { Injectable } from '@nestjs/common';
import { and, eq, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import { zDocumentInput, zMediaUpdate } from '@autohub/shared';
import { assertBranchAccess, TenantContext } from '../../common/context';
import { notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { files, vehicleDocuments, vehicleMedia } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { FilesService, UploadedTemp } from '../files/files.service';
import { VehiclesService } from './vehicles.service';

@Injectable()
export class VehicleMediaService {
  constructor(
    private readonly dbs: DbService,
    private readonly files: FilesService,
    private readonly vehicles: VehiclesService,
    private readonly audit: AuditService,
  ) {}

  async addMedia(ctx: TenantContext, vehicleId: string, upload: UploadedTemp, meta: { category?: string; caption?: string | null; isPublic?: boolean }) {
    const v = await this.vehicles.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    const stored = await this.files.store(upload, { purpose: 'vehicle_media', readPermission: 'vehicles.read' });
    const kind = stored.kind === 'video' ? 'video' : 'photo';
    const [{ maxOrder }] = (await this.dbs.db
      .select({ maxOrder: max(vehicleMedia.sortOrder) })
      .from(vehicleMedia)
      .where(eq(vehicleMedia.vehicleId, vehicleId))) as [{ maxOrder: number | null }];
    const [hasPrimary] = await this.dbs.db
      .select({ id: vehicleMedia.id })
      .from(vehicleMedia)
      .where(and(eq(vehicleMedia.vehicleId, vehicleId), eq(vehicleMedia.isPrimary, true)))
      .limit(1);
    const category = (['general', 'damage', 'inspection', 'before', 'after', 'document'] as const).includes(meta.category as never)
      ? (meta.category as string)
      : 'general';
    const [m] = await this.dbs.db
      .insert(vehicleMedia)
      .values({
        tenantId: ctx.tenant.id,
        vehicleId,
        fileId: stored.id,
        kind,
        category,
        caption: meta.caption ?? null,
        // Damage photos are internal by default; only general photos go public.
        // Only general photos may be shown publicly; damage, inspection and document images never are.
        isPublic: category === 'general' && (meta.isPublic ?? true),
        isPrimary: !hasPrimary && kind === 'photo',
        sortOrder: (maxOrder ?? 0) + 1,
        createdBy: ctx.userId,
      })
      .returning();
    await this.audit.record({ action: 'vehicle.media_added', entityType: 'vehicle', entityId: vehicleId, after: { mediaId: m!.id, kind, category } });
    return m;
  }

  async updateMedia(ctx: TenantContext, vehicleId: string, mediaId: string, input: z.infer<typeof zMediaUpdate>) {
    const v = await this.vehicles.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    const [before] = await this.dbs.db
      .select()
      .from(vehicleMedia)
      .where(and(eq(vehicleMedia.id, mediaId), eq(vehicleMedia.vehicleId, vehicleId)));
    if (!before) throw notFound('Media');
    // Moving a photo out of "general" (e.g. to "document") also withdraws it from public view.
    const category = input.category ?? before.category;
    if (input.isPublic && category !== 'general') throw unprocessable('media_not_publishable', 'Only general photos can be shown publicly');
    if (input.isPrimary) {
      if (before.kind !== 'photo') throw unprocessable('primary_must_be_photo', 'Only a photo can be the main image');
      await this.dbs.db.update(vehicleMedia).set({ isPrimary: false }).where(and(eq(vehicleMedia.vehicleId, vehicleId), eq(vehicleMedia.isPrimary, true)));
    }
    const [after] = await this.dbs.db
      .update(vehicleMedia)
      .set({
        caption: input.caption === undefined ? before.caption : input.caption,
        isPublic: category === 'general' && (input.isPublic ?? before.isPublic),
        isPrimary: input.isPrimary ?? before.isPrimary,
        category,
      })
      .where(eq(vehicleMedia.id, mediaId))
      .returning();
    await this.audit.record({ action: 'vehicle.media_updated', entityType: 'vehicle', entityId: vehicleId, ...diff(before, after!) });
    return after;
  }

  async reorder(ctx: TenantContext, vehicleId: string, mediaIds: string[]) {
    const v = await this.vehicles.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    const existing = await this.dbs.db.select({ id: vehicleMedia.id }).from(vehicleMedia).where(eq(vehicleMedia.vehicleId, vehicleId));
    const set = new Set(existing.map((e) => e.id));
    if (mediaIds.length !== set.size || mediaIds.some((id) => !set.has(id))) {
      throw unprocessable('order_mismatch', 'The order must list every media item of this vehicle exactly once');
    }
    for (const [i, id] of mediaIds.entries()) {
      await this.dbs.db.update(vehicleMedia).set({ sortOrder: i + 1 }).where(eq(vehicleMedia.id, id));
    }
    return { ok: true };
  }

  async deleteMedia(ctx: TenantContext, vehicleId: string, mediaId: string) {
    const v = await this.vehicles.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    const [m] = await this.dbs.db
      .select({ media: vehicleMedia, key: files.storageKey })
      .from(vehicleMedia)
      .innerJoin(files, eq(files.id, vehicleMedia.fileId))
      .where(and(eq(vehicleMedia.id, mediaId), eq(vehicleMedia.vehicleId, vehicleId)));
    if (!m) throw notFound('Media');
    await this.dbs.db.delete(vehicleMedia).where(eq(vehicleMedia.id, mediaId));
    await this.dbs.db.delete(files).where(eq(files.id, m.media.fileId));
    this.files.scheduleDelete(m.key);
    if (m.media.isPrimary) {
      const [next] = await this.dbs.db
        .select({ id: vehicleMedia.id })
        .from(vehicleMedia)
        .where(and(eq(vehicleMedia.vehicleId, vehicleId), eq(vehicleMedia.kind, 'photo')))
        .orderBy(vehicleMedia.sortOrder)
        .limit(1);
      if (next) await this.dbs.db.update(vehicleMedia).set({ isPrimary: true }).where(eq(vehicleMedia.id, next.id));
    }
    await this.audit.record({ action: 'vehicle.media_deleted', entityType: 'vehicle', entityId: vehicleId, before: { mediaId, fileId: m.media.fileId } });
    return { ok: true };
  }

  // ── Documents ─────────────────────────────────────────────────────────────────────────
  async addDocument(ctx: TenantContext, vehicleId: string, input: z.infer<typeof zDocumentInput>, upload?: UploadedTemp) {
    const v = await this.vehicles.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    if (input.issuedAt && input.expiresAt && input.expiresAt < input.issuedAt) {
      throw unprocessable('invalid_dates', 'Expiry date is before the issue date');
    }
    const stored = upload
      ? await this.files.store(upload, {
          purpose: 'vehicle_document',
          readPermission: input.isSensitive ? 'documents.read_sensitive' : 'vehicles.read',
          scrub: false,
        })
      : null;
    const [doc] = await this.dbs.db
      .insert(vehicleDocuments)
      .values({
        tenantId: ctx.tenant.id,
        vehicleId,
        fileId: stored?.id ?? null,
        docType: input.docType,
        docNumber: input.docNumber ?? null,
        issuedAt: input.issuedAt ?? null,
        expiresAt: input.expiresAt ?? null,
        isSensitive: input.isSensitive,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await this.audit.record({
      action: 'vehicle.document_added',
      entityType: 'vehicle',
      entityId: vehicleId,
      after: { documentId: doc!.id, docType: doc!.docType, isSensitive: doc!.isSensitive, expiresAt: doc!.expiresAt },
    });
    return doc;
  }

  async updateDocument(ctx: TenantContext, vehicleId: string, docId: string, input: Partial<z.infer<typeof zDocumentInput>>) {
    const v = await this.vehicles.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    const [before] = await this.dbs.db
      .select()
      .from(vehicleDocuments)
      .where(and(eq(vehicleDocuments.id, docId), eq(vehicleDocuments.vehicleId, vehicleId), isNull(vehicleDocuments.deletedAt)));
    if (!before) throw notFound('Document');
    const [after] = await this.dbs.db
      .update(vehicleDocuments)
      .set({
        docType: input.docType ?? before.docType,
        docNumber: input.docNumber === undefined ? before.docNumber : input.docNumber,
        issuedAt: input.issuedAt === undefined ? before.issuedAt : input.issuedAt,
        expiresAt: input.expiresAt === undefined ? before.expiresAt : input.expiresAt,
        isSensitive: input.isSensitive ?? before.isSensitive,
        notes: input.notes === undefined ? before.notes : input.notes,
      })
      .where(eq(vehicleDocuments.id, docId))
      .returning();
    // Keep the file's read permission aligned with the document's sensitivity.
    if (after!.fileId && after!.isSensitive !== before.isSensitive) {
      await this.dbs.db
        .update(files)
        .set({ purpose: `vehicle_document:${after!.isSensitive ? 'documents.read_sensitive' : 'vehicles.read'}` })
        .where(eq(files.id, after!.fileId));
    }
    await this.audit.record({ action: 'vehicle.document_updated', entityType: 'vehicle', entityId: vehicleId, ...diff(before, after!) });
    return after;
  }

  /** Soft delete: the record and file stay for audit; the document disappears from the vehicle. */
  async deleteDocument(ctx: TenantContext, vehicleId: string, docId: string, reason: string) {
    const v = await this.vehicles.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    const [doc] = await this.dbs.db
      .update(vehicleDocuments)
      .set({ deletedAt: new Date() })
      .where(and(eq(vehicleDocuments.id, docId), eq(vehicleDocuments.vehicleId, vehicleId), isNull(vehicleDocuments.deletedAt)))
      .returning();
    if (!doc) throw notFound('Document');
    await this.audit.record({ action: 'vehicle.document_deleted', entityType: 'vehicle', entityId: vehicleId, before: { documentId: docId }, after: { reason } });
    return { ok: true };
  }
}
