import type { Type } from '@nestjs/common';
import { AccountingModule } from './modules/accounting/accounting.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { FinanceModule } from './modules/finance/finance.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module';

/** Domain feature modules, registered as phases are delivered. */
export const DOMAIN_MODULES: Type[] = [FinanceModule, VehiclesModule, PurchasingModule, ExpensesModule, WorkOrdersModule, AccountingModule];
