import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module';
import { CustomersController, InteractionsController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [ReservationsModule],
  controllers: [CustomersController, InteractionsController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
