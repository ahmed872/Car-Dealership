import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AllowNoTenant, AuthContext, AuthCtx, NoTransaction } from '../../common/context';
import { InvitationsService } from './invitations.service';

/** The signed-in user's own company invitations; no active company is needed (signed_in policy). */
@ApiTags('auth')
@Controller('me/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @AllowNoTenant()
  list() {
    return this.invitations.list();
  }

  /** Runs in the inviting company's context, so it manages its own transactions. */
  @Post(':id/accept')
  @AllowNoTenant()
  @NoTransaction()
  @HttpCode(200)
  accept(@AuthCtx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.invitations.respond(auth, id, true);
  }

  @Post(':id/decline')
  @AllowNoTenant()
  @NoTransaction()
  @HttpCode(200)
  decline(@AuthCtx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.invitations.respond(auth, id, false);
  }
}
