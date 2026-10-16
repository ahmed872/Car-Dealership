import { Module } from '@nestjs/common';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { VehiclesModule } from '../vehicles/vehicles.module';

/** Workshop / preparation work orders whose approved items become vehicle costs. */
@Module({
  imports: [VehiclesModule, PurchasingModule],
  controllers: [],
  providers: [],
  exports: [],
})
export class WorkOrdersModule {}
