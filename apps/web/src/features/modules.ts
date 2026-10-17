import type { FeatureModule } from './registry';
import { purchasingModule } from './purchasing/module';
import { costsModule } from './costs/module';
import { workOrdersModule } from './workOrders/module';
import { approvalsModule } from './approvals/module';
import { cashModule } from './cash/module';
import { expensesModule } from './expenses/module';
import { accountingModule } from './accounting/module';
import { customersModule } from './customers/module';
import { leadsModule } from './leads/module';
import { appointmentsModule } from './appointments/module';
import { reservationsModule } from './reservations/module';
import { receivablesModule } from './receivables/module';
import { wishesModule } from './wishes/module';
import { notificationsModule } from './notifications/module';
import { employeesModule } from './employees/module';

/** Every feature module, in sidebar order within each group. */
export const FEATURE_MODULES: FeatureModule[] = [
  purchasingModule,
  costsModule,
  workOrdersModule,
  approvalsModule,
  cashModule,
  expensesModule,
  accountingModule,
  customersModule,
  leadsModule,
  appointmentsModule,
  reservationsModule,
  receivablesModule,
  wishesModule,
  notificationsModule,
  employeesModule,
];
