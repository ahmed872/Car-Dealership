import { Module } from '@nestjs/common';
import { AiTextService } from './ai-text.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { MessagingService } from './messaging.service';
import { OcrService } from './ocr.service';
import { VinDecoderService } from './vin-decoder.service';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, VinDecoderService, AiTextService, MessagingService, OcrService],
  exports: [IntegrationsService, AiTextService, MessagingService, OcrService],
})
export class IntegrationsModule {}
