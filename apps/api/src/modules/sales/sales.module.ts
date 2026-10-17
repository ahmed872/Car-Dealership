import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { EmployeesModule } from '../employees/employees.module';
import { LeadsModule } from '../leads/leads.module';
import { PdfModule } from '../pdf/pdf.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { CommissionsService } from './commissions.service';
import { SaleDocumentsService } from './documents.service';
import { InstallmentsService } from './installments.service';
import { SaleMoneyService } from './sale-money.service';
import { CommissionsController, InstallmentPlansController, SaleDocumentsController, SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [VehiclesModule, PurchasingModule, ReservationsModule, CustomersModule, LeadsModule, EmployeesModule, PdfModule],
  controllers: [SalesController, SaleDocumentsController, InstallmentPlansController, CommissionsController],
  providers: [SalesService, SaleMoneyService, InstallmentsService, CommissionsService, SaleDocumentsService],
  exports: [SalesService, SaleMoneyService, InstallmentsService, CommissionsService],
})
export class SalesModule {}
