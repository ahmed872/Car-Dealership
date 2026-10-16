import { Module } from '@nestjs/common';
import { LeadsController, PipelineController } from './leads.controller';
import { LeadsService } from './leads.service';
import { PipelineService } from './pipeline.service';

/** Sales pipeline: configurable stages, leads, stage history, follow-up reminders. */
@Module({
  controllers: [PipelineController, LeadsController],
  providers: [PipelineService, LeadsService],
  exports: [PipelineService, LeadsService],
})
export class LeadsModule {}
