import { z } from 'zod';
import { patchOf, zOptText, zText, zUuid } from './common';
import { LEAD_SOURCES } from './crm';

// Shared input schemas owned by the leads module (sales pipeline). Core lead schemas
// (zLeadCreate, zLeadUpdate, zLeadStageChange, zLeadLost, zLeadListQuery) live in ./crm.

export const PIPELINE_STAGE_KINDS = ['open', 'won', 'lost'] as const;
export type PipelineStageKind = (typeof PIPELINE_STAGE_KINDS)[number];

/** A tenant's own pipeline stage. Won/lost stages are terminal (probability fixed at 100 / 0). */
export const zPipelineStageCreate = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, 'invalid_code'),
  nameEn: zText(80).min(1),
  nameAr: zText(80).min(1),
  sortOrder: z.number().int().min(0).max(10_000),
  kind: z.enum(PIPELINE_STAGE_KINDS).default('open'),
  probabilityPct: z.number().int().min(0).max(100).optional(),
});
export type PipelineStageCreateInput = z.infer<typeof zPipelineStageCreate>;

/** Code and kind are fixed once created (leads and history refer to the stage's meaning). */
export const zPipelineStageUpdate = patchOf(
  zPipelineStageCreate.pick({ nameEn: true, nameAr: true, sortOrder: true, probabilityPct: true }),
);
export type PipelineStageUpdateInput = z.infer<typeof zPipelineStageUpdate>;

/** Open leads still in the stage must be moved to another active open stage first (or here). */
export const zPipelineStageDeactivate = z.object({ moveToStageId: zUuid.optional() });

export const zPipelineStageListQuery = z.object({ includeInactive: z.enum(['true', 'false']).optional() });

/** Re-opens a won/lost lead into an open stage (default: the 'new' stage). */
export const zLeadReopen = z.object({
  stageId: zUuid.optional(),
  note: zOptText(500),
  version: z.number().int().min(1).optional(),
});

export const zLeadAssign = z.object({
  userId: zUuid,
  note: zOptText(500),
  version: z.number().int().min(1).optional(),
});

/** Kanban board of open leads; `perStage` cards per column (counts and totals cover all). */
export const zLeadBoardQuery = z.object({
  branchId: zUuid.optional(),
  assignedUserId: zUuid.optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  mine: z.enum(['true', 'false']).optional(),
  perStage: z.coerce.number().int().min(0).max(200).default(20),
});

/** The caller's follow-ups: overdue, and due before the end of today (tenant time zone). */
export const zLeadFollowUpQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
