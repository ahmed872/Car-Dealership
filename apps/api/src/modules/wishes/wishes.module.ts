import { Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module';

@Module({
  imports: [VehiclesModule],
  controllers: [],
  providers: [],
  exports: [],
})
export class WishesModule {}
