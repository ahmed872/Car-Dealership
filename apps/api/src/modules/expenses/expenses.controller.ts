import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { zDecisionNote, zExpenseCreate, zExpenseListQuery, zExpenseSummaryQuery, zReasonRequired } from '@autohub/shared';
import { Authenticated, Ctx, Idempotent, RequirePermissions, TenantContext } from '../../common/context';
import { ExpensesService } from './expenses.service';

class ExpenseCreateDto extends createZodDto(zExpenseCreate) {}
class ExpenseListQueryDto extends createZodDto(zExpenseListQuery) {}
class ExpenseSummaryQueryDto extends createZodDto(zExpenseSummaryQuery) {}
class NoteDto extends createZodDto(zDecisionNote) {}
class ReasonDto extends createZodDto(zReasonRequired) {}

@ApiTags('expenses')
@Controller()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  /** Operating (P&L) categories for expense pickers; vehicle categories come from /cost-categories. */
  @Get('expense-categories')
  @Authenticated()
  categories() {
    return this.expenses.categories();
  }

  @Get('expenses')
  @RequirePermissions('expenses.read')
  list(@Ctx() ctx: TenantContext, @Query() q: ExpenseListQueryDto) {
    return this.expenses.list(ctx, q);
  }

  // Declared before ':id' so "summary" is not parsed as an id.
  @Get('expenses/summary')
  @RequirePermissions('expenses.read')
  summary(@Ctx() ctx: TenantContext, @Query() q: ExpenseSummaryQueryDto) {
    return this.expenses.summary(ctx, q);
  }

  @Get('expenses/:id')
  @RequirePermissions('expenses.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.get(ctx, id);
  }

  @Post('expenses')
  @Idempotent()
  @RequirePermissions('expenses.create')
  create(@Ctx() ctx: TenantContext, @Body() body: ExpenseCreateDto) {
    return this.expenses.create(ctx, body);
  }

  @Post('expenses/:id/approve')
  @HttpCode(200)
  @RequirePermissions('expenses.approve')
  approve(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: NoteDto) {
    return this.expenses.approve(ctx, id, body.note);
  }

  @Post('expenses/:id/reject')
  @HttpCode(200)
  @RequirePermissions('expenses.approve')
  reject(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.expenses.reject(ctx, id, body.reason);
  }

  @Post('expenses/:id/reverse')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('expenses.approve')
  reverse(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.expenses.reverse(ctx, id, body.reason);
  }
}
