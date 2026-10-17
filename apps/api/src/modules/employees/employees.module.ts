import { Module } from '@nestjs/common';
import { CommissionPoliciesService } from './commission-policies.service';
import { CommissionPoliciesController, EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';

@Module({
  controllers: [EmployeesController, CommissionPoliciesController],
  providers: [EmployeesService, CommissionPoliciesService],
  exports: [EmployeesService, CommissionPoliciesService],
})
export class EmployeesModule {}
