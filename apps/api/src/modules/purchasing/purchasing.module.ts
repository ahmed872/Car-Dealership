import { Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { AcquisitionsService } from './acquisitions.service';
import { CostsService } from './costs.service';
import { AcquisitionsController, CostsController, SuppliersController } from './purchasing.controller';
import { SuppliersService } from './suppliers.service';

@Module({
  imports: [VehiclesModule],
  controllers: [SuppliersController, AcquisitionsController, CostsController],
  providers: [SuppliersService, AcquisitionsService, CostsService],
  exports: [SuppliersService, AcquisitionsService, CostsService],
})
export class PurchasingModule {}
