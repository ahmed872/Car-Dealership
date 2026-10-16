import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { WishesController } from './wishes.controller';
import { WishesService } from './wishes.service';

@Module({
  imports: [CustomersModule],
  controllers: [WishesController],
  providers: [WishesService],
  exports: [WishesService],
})
export class WishesModule {}
