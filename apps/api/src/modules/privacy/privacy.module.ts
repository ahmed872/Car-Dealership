import { Module } from '@nestjs/common';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';

/** Data protection (D-053): find and redact personal data of showroom visitors; retention job. */
@Module({
  controllers: [PrivacyController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
