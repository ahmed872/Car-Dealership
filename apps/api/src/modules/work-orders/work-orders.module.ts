import { Module } from '@nestjs/common';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';

/** Workshop / preparation work orders whose approved items become vehicle costs. */
@Module({
  imports: [VehiclesModule, PurchasingModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService],
  exports: [WorkOrdersService],
})
export class WorkOrdersModule {}
