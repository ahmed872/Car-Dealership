import { Module } from '@nestjs/common';
import { CashBookController, CashTransfersController, LedgerController } from './accounting.controller';
import { CashBookService } from './cash-book.service';
import { CashTransfersService } from './cash-transfers.service';
import { LedgerReportsService } from './ledger-reports.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Cash transfers, cash book views and general-ledger reports (trial balance, statements,
 * reconciliation). Money primitives (CashService) come from the global FinanceModule.
 */
@Module({
  controllers: [CashTransfersController, CashBookController, LedgerController],
  providers: [CashTransfersService, CashBookService, LedgerReportsService, ReconciliationService],
  exports: [CashTransfersService, CashBookService, LedgerReportsService, ReconciliationService],
})
export class AccountingModule {}
