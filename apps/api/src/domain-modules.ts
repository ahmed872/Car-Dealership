import type { Type } from '@nestjs/common';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { CustomersModule } from './modules/customers/customers.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { LeadsModule } from './modules/leads/leads.module';
import { WishesModule } from './modules/wishes/wishes.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { FinanceModule } from './modules/finance/finance.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module';
import { SalesModule } from './modules/sales/sales.module';
import { CashClosingModule } from './modules/cash-closing/cash-closing.module';

/** Domain feature modules, registered as phases are delivered. */
export const DOMAIN_MODULES: Type[] = [JobsModule, FinanceModule, VehiclesModule, PurchasingModule, ExpensesModule, WorkOrdersModule, AccountingModule, ReservationsModule, CustomersModule, LeadsModule, AppointmentsModule, WishesModule, EmployeesModule, SalesModule, CashClosingModule];
