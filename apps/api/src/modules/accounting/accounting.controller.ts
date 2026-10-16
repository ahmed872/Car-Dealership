import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  zCashBookQuery,
  zCashTransfer,
  zCashTransferListQuery,
  zLedgerAccountsQuery,
  zLedgerAsOfQuery,
  zLedgerEntriesQuery,
  zLedgerPeriodQuery,
  zLedgerStatementQuery,
  zReasonRequired,
} from '@autohub/shared';
import { Ctx, Idempotent, RequirePermissions, TenantContext } from '../../common/context';
import { CashBookService } from './cash-book.service';
import { CashTransfersService } from './cash-transfers.service';
import { LedgerReportsService } from './ledger-reports.service';
import { ReconciliationService } from './reconciliation.service';

class CashTransferDto extends createZodDto(zCashTransfer) {}
class CashTransferListQueryDto extends createZodDto(zCashTransferListQuery) {}
class ReasonDto extends createZodDto(zReasonRequired) {}
class CashBookQueryDto extends createZodDto(zCashBookQuery) {}
class LedgerAccountsQueryDto extends createZodDto(zLedgerAccountsQuery) {}
class LedgerPeriodQueryDto extends createZodDto(zLedgerPeriodQuery) {}
class LedgerAsOfQueryDto extends createZodDto(zLedgerAsOfQuery) {}
class LedgerEntriesQueryDto extends createZodDto(zLedgerEntriesQuery) {}
class LedgerStatementQueryDto extends createZodDto(zLedgerStatementQuery) {}

@ApiTags('accounting')
@Controller('cash/transfers')
export class CashTransfersController {
  constructor(private readonly transfers: CashTransfersService) {}

  @Get()
  @RequirePermissions('cash.read')
  list(@Ctx() ctx: TenantContext, @Query() q: CashTransferListQueryDto) {
    return this.transfers.list(ctx, q);
  }

  @Post()
  @Idempotent()
  @RequirePermissions('cash.transfer')
  create(@Ctx() ctx: TenantContext, @Body() body: CashTransferDto) {
    return this.transfers.create(ctx, body);
  }

  @Get(':transferId')
  @RequirePermissions('cash.read')
  get(@Ctx() ctx: TenantContext, @Param('transferId', ParseUUIDPipe) transferId: string) {
    return this.transfers.get(ctx, transferId);
  }

  @Post(':transferId/reverse')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('cash.transfer', 'payments.void')
  reverse(@Ctx() ctx: TenantContext, @Param('transferId', ParseUUIDPipe) transferId: string, @Body() body: ReasonDto) {
    return this.transfers.reverse(ctx, transferId, body.reason);
  }
}

@ApiTags('accounting')
@Controller('cash/accounts')
export class CashBookController {
  constructor(private readonly book: CashBookService) {}

  @Get(':id/book')
  @RequirePermissions('cash.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: CashBookQueryDto) {
    return this.book.book(ctx, id, q);
  }
}

/** Company-wide GL reports: callers need ledger.read AND access to all branches (company_scope_required). */
@ApiTags('accounting')
@Controller('ledger')
export class LedgerController {
  constructor(
    private readonly reports: LedgerReportsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Get('accounts')
  @RequirePermissions('ledger.read')
  accounts(@Ctx() ctx: TenantContext, @Query() q: LedgerAccountsQueryDto) {
    return this.reports.accounts(ctx, q.asOf);
  }

  @Get('accounts/:code/statement')
  @RequirePermissions('ledger.read')
  statement(@Ctx() ctx: TenantContext, @Param('code') code: string, @Query() q: LedgerStatementQueryDto) {
    return this.reports.statement(ctx, code, q);
  }

  @Get('trial-balance')
  @RequirePermissions('ledger.read')
  trialBalance(@Ctx() ctx: TenantContext, @Query() q: LedgerPeriodQueryDto) {
    return this.reports.trialBalance(ctx, q);
  }

  @Get('entries')
  @RequirePermissions('ledger.read')
  entries(@Ctx() ctx: TenantContext, @Query() q: LedgerEntriesQueryDto) {
    return this.reports.entries(ctx, q);
  }

  @Get('entries/:id')
  @RequirePermissions('ledger.read')
  entry(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.entry(ctx, id);
  }

  @Get('income-statement')
  @RequirePermissions('ledger.read')
  incomeStatement(@Ctx() ctx: TenantContext, @Query() q: LedgerPeriodQueryDto) {
    return this.reports.incomeStatement(ctx, q);
  }

  @Get('balance-sheet')
  @RequirePermissions('ledger.read')
  balanceSheet(@Ctx() ctx: TenantContext, @Query() q: LedgerAsOfQueryDto) {
    return this.reports.balanceSheet(ctx, q.asOf);
  }

  @Get('reconciliation')
  @RequirePermissions('ledger.read')
  reconcile(@Ctx() ctx: TenantContext, @Query() q: LedgerAsOfQueryDto) {
    return this.reconciliation.reconcile(ctx, q.asOf);
  }
}
