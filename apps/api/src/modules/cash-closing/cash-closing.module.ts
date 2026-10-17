import { Module } from '@nestjs/common';
import { CashClosingController } from './cash-closing.controller';
import { CashClosingService } from './cash-closing.service';

@Module({
  controllers: [CashClosingController],
  providers: [CashClosingService],
  exports: [CashClosingService],
})
export class CashClosingModule {}
