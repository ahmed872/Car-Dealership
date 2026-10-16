import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { CashService } from './cash.service';
import { CashAccountsService } from './cash-accounts.service';
import { ApprovalsController, CashAccountsController, SupplierPaymentsController } from './finance.controller';
import { PayablesService } from './payables.service';
import { SupplierPaymentsService } from './supplier-payments.service';

/** Money primitives shared by every module that moves cash or creates payables. */
@Global()
@Module({
  controllers: [SupplierPaymentsController, ApprovalsController, CashAccountsController],
  providers: [CashService, CashAccountsService, PayablesService, SupplierPaymentsService, ApprovalsService],
  exports: [CashService, CashAccountsService, PayablesService, SupplierPaymentsService, ApprovalsService],
})
export class FinanceModule {}
