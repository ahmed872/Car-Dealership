import { Global, Module } from '@nestjs/common';
import { DbService } from './db/db.service';
import { AuditService } from './modules/audit/audit.service';
import { PasswordService } from './modules/auth/password.service';
import { SessionService } from './modules/auth/session.service';
import { PostingService } from './modules/ledger/posting.service';
import { NumberingService } from './modules/numbering/numbering.service';
import { SubscriptionService } from './modules/tenancy/subscription.service';

/** Cross-cutting services shared by every domain module. */
@Global()
@Module({
  providers: [DbService, AuditService, PasswordService, SessionService, PostingService, NumberingService, SubscriptionService],
  exports: [DbService, AuditService, PasswordService, SessionService, PostingService, NumberingService, SubscriptionService],
})
export class CoreModule {}
