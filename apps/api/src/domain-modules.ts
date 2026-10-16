import type { Type } from '@nestjs/common';
import { VehiclesModule } from './modules/vehicles/vehicles.module';

/** Domain feature modules, registered as phases are delivered. */
export const DOMAIN_MODULES: Type[] = [VehiclesModule];
