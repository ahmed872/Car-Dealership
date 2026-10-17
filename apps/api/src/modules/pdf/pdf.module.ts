import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';

/** Headless-Chromium PDF rendering shared by sale documents and report exports. */
@Module({
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
