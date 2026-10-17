import { Module } from '@nestjs/common';
import { PdfModule } from '../pdf/pdf.module';
import { DashboardService } from './dashboard.service';
import { ReportExportService } from './report-export.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [PdfModule],
  controllers: [ReportsController],
  providers: [ReportsService, DashboardService, ReportExportService],
})
export class ReportsModule {}
