import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { CashService } from './cash.service';
import { CashAccountsService } from './cash-accounts.service';
import { ApprovalsController, CashAccountsController, SupplierPaymentsController } from './finance.controller';
import { PayablesService } from './payables.service';
import { ReceiptsController, RefundsController } from './receivables.controller';
import { ReceiptsService } from './receipts.service';
import { RefundsService } from './refunds.service';
import { SupplierPaymentsService } from './supplier-payments.service';

/** Money primitives shared by every module that moves cash or creates payables. */
@Global()
@Module({
  controllers: [SupplierPaymentsController, ApprovalsController, CashAccountsController, ReceiptsController, RefundsController],
  providers: [CashService, CashAccountsService, PayablesService, SupplierPaymentsService, ApprovalsService, ReceiptsService, RefundsService],
  exports: [CashService, CashAccountsService, PayablesService, SupplierPaymentsService, ApprovalsService, ReceiptsService, RefundsService],
})
export class FinanceModule {}
