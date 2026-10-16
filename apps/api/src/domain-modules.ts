import type { Type } from '@nestjs/common';
import { FinanceModule } from './modules/finance/finance.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';

/** Domain feature modules, registered as phases are delivered. */
export const DOMAIN_MODULES: Type[] = [FinanceModule, VehiclesModule, PurchasingModule];
