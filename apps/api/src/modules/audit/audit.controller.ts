import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { zPaginationQuery } from '@autohub/shared';
import { Ctx, RequirePermissions, TenantContext } from '../../common/context';
import { AppError } from '../../common/errors';
import { AuditService } from './audit.service';

const zAuditQuery = zPaginationQuery.extend({
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(80).optional(),
  actorUserId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
class AuditQueryDto extends createZodDto(zAuditQuery) {}

/**
 * The audit log is a company-wide record: entries are not attributable to a branch (their before /
 * after snapshots can describe any branch's customers, vehicles or users), so it is readable only
 * with access to all branches, like the general-ledger reports.
 */
function assertCompanyScope(ctx: TenantContext): void {
  if (!ctx.allBranches) {
    throw new AppError('company_scope_required', 403, 'The audit log covers the whole company; it requires access to all branches');
  }
}

@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  list(@Ctx() ctx: TenantContext, @Query() q: AuditQueryDto) {
    assertCompanyScope(ctx);
    return this.audit.list(q);
  }

  /** Recomputes the tenant's hash chain and reports the first inconsistency, if any. */
  @Post('verify')
  @HttpCode(200)
  @RequirePermissions('audit.read')
  verify(@Ctx() ctx: TenantContext) {
    assertCompanyScope(ctx);
    return this.audit.verify();
  }
}
