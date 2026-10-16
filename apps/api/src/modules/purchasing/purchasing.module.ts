import { Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { AcquisitionsService } from './acquisitions.service';
import { CostsService } from './costs.service';
import { PayablesReportService } from './payables-report.service';
import { AcquisitionsController, CostsController } from './purchasing.controller';
import { PayablesController, SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

@Module({
  imports: [VehiclesModule],
  controllers: [SuppliersController, PayablesController, AcquisitionsController, CostsController],
  providers: [SuppliersService, AcquisitionsService, CostsService, PayablesReportService],
  exports: [SuppliersService, AcquisitionsService, CostsService, PayablesReportService],
})
export class PurchasingModule {}
