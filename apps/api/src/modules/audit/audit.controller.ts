import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { zPaginationQuery } from '@autohub/shared';
import { RequirePermissions } from '../../common/context';
import { AuditService } from './audit.service';

const zAuditQuery = zPaginationQuery.extend({
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(80).optional(),
  actorUserId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
class AuditQueryDto extends createZodDto(zAuditQuery) {}

@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  list(@Query() q: AuditQueryDto) {
    return this.audit.list(q);
  }

  /** Recomputes the tenant's hash chain and reports the first inconsistency, if any. */
  @Post('verify')
  @HttpCode(200)
  @RequirePermissions('audit.read')
  verify() {
    return this.audit.verify();
  }
}
