import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { LeadsModule } from '../leads/leads.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { InsightsService } from './insights.service';
import { ListingsService } from './listings.service';
import { PublicShowroomService } from './public-showroom.service';
import { PublicShowroomController, ShowroomController } from './showroom.controller';

@Module({
  imports: [IntegrationsModule, CustomersModule, LeadsModule, VehiclesModule],
  controllers: [ShowroomController, PublicShowroomController],
  providers: [ListingsService, PublicShowroomService, InsightsService],
})
export class ShowroomModule {}
