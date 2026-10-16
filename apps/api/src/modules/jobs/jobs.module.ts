import { Global, Module } from '@nestjs/common';
import { NotificationsController } from '../notifications/notifications.controller';
import { NotificationsService } from '../notifications/notifications.service';
import { JobsService } from './jobs.service';

/** Scheduler + notifications, available to every domain module. */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [JobsService, NotificationsService],
  exports: [JobsService, NotificationsService],
})
export class JobsModule {}
