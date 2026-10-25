import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { zPrivacySearch, zRedactionRequest } from '@autohub/shared';
import { Ctx, RequirePermissions, TenantContext } from '../../common/context';
import { PrivacyService } from './privacy.service';

class PrivacySearchDto extends createZodDto(zPrivacySearch) {}
class RedactionDto extends createZodDto(zRedactionRequest) {}

/**
 * Data-protection requests (KSA PDPL, UAE PDPL, Egypt Law 151/2020; OPERATIONS §9). Company-wide:
 * `privacy.manage` AND access to all branches (403 company_scope_required), like the audit log.
 */
@ApiTags('privacy')
@Controller('privacy')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /**
   * Inquiries and messages of one person (by phone and/or email), with masked contacts only. A POST
   * with a JSON body (read-only) so the data subject's contact never appears in a URL (D-054).
   */
  @Post('search')
  @HttpCode(200)
  @RequirePermissions('privacy.manage')
  search(@Ctx() ctx: TenantContext, @Body() body: PrivacySearchDto) {
    return this.privacy.search(ctx, body);
  }

  /** Overwrites the personal fields of the given rows (irreversible); audited by the database function. */
  @Post('redactions')
  @HttpCode(200)
  @RequirePermissions('privacy.manage')
  redact(@Ctx() ctx: TenantContext, @Body() body: RedactionDto) {
    return this.privacy.redact(ctx, body);
  }
}
