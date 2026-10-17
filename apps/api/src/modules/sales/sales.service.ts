import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, SQL, sql } from 'drizzle-orm';
import {
  computeTax,
  d,
  evaluateSalePrice,
  InstallmentTermsInput,
  money,
  SaleCreateInput,
  SaleListQuery,
  SalePreviewInput,
  SaleUpdateInput,
  sum,
  todayInZone,
  TradeInInput,
} from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { assertWorkingMember } from '../../common/members';
import { DbService } from '../../db/db.service';
import { customers, leads, receiptAllocations, receipts, reservations, sales, tradeIns, users, vehicleMakes, vehicleModels, vehicles } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { CustomersService } from '../customers/customers.service';
import { ApprovalsService } from '../finance/approvals.service';
import { LeadsService } from '../leads/leads.service';
import { ACCOUNTS } from '../ledger/chart';
import { PostingService } from '../ledger/posting.service';
import { NumberingService } from '../numbering/numbering.service';
import { CostsService } from '../purchasing/costs.service';
import { ReservationsService } from '../reservations/reservations.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { CommissionsService } from './commissions.service';
import { SaleDocumentsService } from './documents.service';
import { InstallmentsService } from './installments.service';
import { SaleMoneyService, SaleRow } from './sale-money.service';

registerUniqueConstraint('sales_vehicle_active_uq', 'vehicle_already_sold', 'This vehicle already has an active sale');
registerUniqueConstraint('sales_number_uq', 'sale_number_taken', 'Sale number already exists');

type VehicleRow = typeof vehicles.$inferSelect;
type Pricing = {
  askingPrice: string | null;
  floorPrice: string | null;
  agreedPrice: string;
  discountAmount: string;
  discountPct: string;
  taxMode: string;
  taxRatePct: string;
  pricesIncludeTax: boolean;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  downPayment: string | null;
  financedAmount: string | null;
  approvalPermission: 'sales.approve_discount' | 'sales.approve_below_floor' | null;
};

const PRE_CONFIRM = ['draft', 'pending_approval', 'approved'];

/**
 * The sales workflow (B-011..B-013): draft → (price approval) → confirmed → delivered, with
 * cancellation and returns. Prices are evaluated against the vehicle's asking and floor prices
 * and the seller's discount limit; tax follows the company settings and is frozen at
 * confirmation. Money is handled by SaleMoneyService, schedules by InstallmentsService.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly dbs: DbService,
    private readonly money: SaleMoneyService,
    private readonly installments: InstallmentsService,
    private readonly commissions: CommissionsService,
    private readonly documents: SaleDocumentsService,
    private readonly vehicles: VehiclesService,
    private readonly costs: CostsService,
    private readonly reservations: ReservationsService,
    private readonly customersService: CustomersService,
    private readonly leadsService: LeadsService,
    private readonly approvals: ApprovalsService,
    private readonly posting: PostingService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  // ── Access ────────────────────────────────────────────────────────────────────────────

  /** Sales reps (no leads.assign and no customers.read_all) see only the sales they sell. */
  private ownOnly(ctx: TenantContext): boolean {
    return !hasPermission(ctx, 'leads.assign') && !hasPermission(ctx, 'customers.read_all');
  }

  private scope(ctx: TenantContext): SQL[] {
    const conds: SQL[] = [];
    if (!ctx.allBranches) conds.push(ctx.branchIds.length ? inArray(sales.branchId, ctx.branchIds) : sql`false`);
    if (this.ownOnly(ctx)) conds.push(eq(sales.salespersonId, ctx.userId));
    return conds;
  }

  private async find(ctx: TenantContext, id: string, lock = false): Promise<SaleRow> {
    const s = await this.money.find(id, lock).catch(() => null);
    if (!s || (this.ownOnly(ctx) && s.salespersonId !== ctx.userId)) throw notFound('Sale');
    assertBranchAccess(ctx, s.branchId);
    return s;
  }

  private checkVersion(s: SaleRow, version: number | undefined): void {
    if (version !== undefined && version !== s.version) {
      throw conflict('version_conflict', 'This sale was changed by someone else. Reload and try again.', { currentVersion: s.version });
    }
  }

  private assertStatus(s: SaleRow, allowed: string[]): void {
    if (!allowed.includes(s.status)) throw conflict('invalid_sale_status', `This sale is ${s.status.replace('_', ' ')}`, { status: s.status, allowed });
  }

  // ── Pricing ───────────────────────────────────────────────────────────────────────────

  private async vehicleCost(vehicleId: string): Promise<string> {
    return d(await this.posting.balance(ACCOUNTS.INVENTORY, { vehicleId })).toFixed(2);
  }

  /** Price, discount and tax for an agreed price on a vehicle under the company's settings. */
  private async price(
    ctx: TenantContext,
    v: VehicleRow,
    input: { agreedPrice: string; paymentType: string; downPayment?: string | null; installmentTerms?: InstallmentTermsInput | null },
  ): Promise<Pricing> {
    const cur = ctx.tenant.baseCurrency;
    const tax = ctx.tenant.settings.tax;
    const agreed = money(input.agreedPrice, cur);
    const ev = evaluateSalePrice({ askingPrice: v.askingPrice, floorPrice: v.minPrice, agreedPrice: agreed, maxDiscountPct: ctx.maxDiscountPct ?? '0', currency: cur });
    const t = computeTax({
      amount: agreed,
      amountIncludesTax: tax.pricesIncludeTax,
      mode: tax.mode,
      ratePct: tax.ratePct,
      cost: tax.mode === 'margin' ? await this.vehicleCost(v.id) : undefined,
      currency: cur,
      rounding: ctx.tenant.settings.rounding,
    });
    let downPayment: string | null = null;
    let financedAmount: string | null = null;
    if (input.paymentType === 'installments') {
      if (!ctx.tenant.settings.installments.enabled) throw unprocessable('installments_disabled', 'Installment sales are not enabled for this company');
      downPayment = money(input.downPayment ?? '0', cur);
      const financed = d(t.gross).minus(downPayment);
      if (financed.lte(0)) throw unprocessable('nothing_financed', 'The down payment covers the whole price; sell for cash instead', { field: 'downPayment' });
      financedAmount = financed.toFixed(2);
      this.installments.previewSchedule(ctx, financedAmount, input.installmentTerms!);
    }
    return {
      askingPrice: v.askingPrice,
      floorPrice: v.minPrice,
      agreedPrice: agreed,
      discountAmount: ev.discountAmount,
      discountPct: ev.discountPct,
      taxMode: tax.mode,
      taxRatePct: tax.ratePct,
      pricesIncludeTax: tax.pricesIncludeTax,
      netAmount: t.net,
      taxAmount: t.tax,
      grossAmount: t.gross,
      downPayment,
      financedAmount,
      approvalPermission: ev.approvalPermission,
    };
  }

  /** Money the customer brings that must fit within what is due up front. */
  private assertCreditFits(p: Pricing, credit: string): void {
    const due = p.downPayment ?? p.grossAmount;
    if (d(credit).gt(due)) {
      throw unprocessable('credit_exceeds_due', 'Trade-in value and deposit exceed what is due before delivery', { due, credit: d(credit).toFixed(2) });
    }
  }

  async preview(ctx: TenantContext, input: SalePreviewInput) {
    const v = await this.vehicles.get(input.vehicleId);
    assertBranchAccess(ctx, v.branchId);
    const p = await this.price(ctx, v, input);
    const schedule = input.paymentType === 'installments' ? this.installments.previewSchedule(ctx, p.financedAmount!, input.installmentTerms!) : null;
    const credit = d(input.tradeInTotal ?? '0');
    return {
      ...p,
      requiresApproval: !!p.approvalPermission,
      dueBeforeDelivery: d(p.downPayment ?? p.grossAmount).minus(credit).toFixed(2),
      schedule,
    };
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────────────────

  private async vehicleSnapshot(vehicleId: string) {
    const [r] = await this.dbs.db
      .select({
        id: vehicles.id,
        stockNumber: vehicles.stockNumber,
        vin: vehicles.vin,
        plateNumber: vehicles.plateNumber,
        modelYear: vehicles.modelYear,
        trim: vehicles.trim,
        exteriorColor: vehicles.exteriorColor,
        bodyType: vehicles.bodyType,
        fuelType: vehicles.fuelType,
        transmission: vehicles.transmission,
        condition: vehicles.condition,
        odometerValue: vehicles.odometerValue,
        odometerUnit: vehicles.odometerUnit,
        makeEn: vehicleMakes.nameEn,
        makeAr: vehicleMakes.nameAr,
        modelEn: vehicleModels.nameEn,
        modelAr: vehicleModels.nameAr,
      })
      .from(vehicles)
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .where(eq(vehicles.id, vehicleId));
    return r!;
  }

  private async customerSnapshot(customerId: string) {
    const [c] = await this.dbs.db.select().from(customers).where(eq(customers.id, customerId));
    return {
      id: c!.id,
      type: c!.type,
      fullName: c!.fullName,
      phone: c!.phone,
      email: c!.email,
      city: c!.city,
      address: c!.address,
      nationalIdLast4: c!.nationalIdLast4,
      commercialRegistration: c!.commercialRegistration,
      taxNumber: c!.taxNumber,
    };
  }

  // ── Draft ─────────────────────────────────────────────────────────────────────────────

  async create(ctx: TenantContext, input: SaleCreateInput) {
    const v = await this.vehicles.lock(input.vehicleId);
    assertBranchAccess(ctx, v.branchId);
    const c = await this.customersService.assertVisible(ctx, input.customerId);
    if (!c.isActive) throw unprocessable('customer_inactive', 'This customer is inactive');

    let reservationId: string | null = null;
    if (v.status === 'reserved') {
      const [r] = await this.dbs.db
        .select({ id: reservations.id, customerId: reservations.customerId })
        .from(reservations)
        .where(and(eq(reservations.vehicleId, v.id), eq(reservations.status, 'active')));
      if (!r || r.customerId !== c.id) throw conflict('vehicle_reserved', 'This vehicle is reserved for another customer');
      reservationId = r.id;
    } else if (v.status !== 'available') {
      throw conflict('vehicle_not_available', 'Only available vehicles (or ones reserved for this customer) can be sold', { vehicleStatus: v.status });
    }

    if (input.leadId) {
      const [l] = await this.dbs.db.select({ customerId: leads.customerId, status: leads.status }).from(leads).where(eq(leads.id, input.leadId));
      if (!l) throw notFound('Lead');
      if (l.customerId !== c.id) throw unprocessable('lead_customer_mismatch', 'This lead belongs to a different customer', { field: 'leadId' });
    }
    const salespersonId = input.salespersonId ?? ctx.userId;
    if (salespersonId !== ctx.userId) {
      assertPermission(ctx, 'leads.assign');
      await assertWorkingMember(this.dbs, ctx, salespersonId, v.branchId, 'sales.create');
    }

    const p = await this.price(ctx, v, input);
    const tradeInTotal = sum(input.tradeIns.map((t) => t.agreedValue));
    let depositHeld = d(0);
    if (reservationId) {
      const [r] = await this.dbs.db.select().from(reservations).where(eq(reservations.id, reservationId));
      depositHeld = d(await this.reservations.availableDepositBase(r!));
    }
    this.assertCreditFits(p, tradeInTotal.plus(depositHeld).toFixed(2));

    await this.vehicles.transition(ctx, v.id, 'sale_pending', { system: true, source: 'sale', reason: 'Sale draft created' });
    const number = await this.numbering.next('sale');
    const status = p.approvalPermission ? 'pending_approval' : 'draft';
    const [s] = await this.dbs.db
      .insert(sales)
      .values({
        tenantId: ctx.tenant.id,
        number,
        branchId: v.branchId,
        customerId: c.id,
        leadId: input.leadId ?? null,
        reservationId,
        vehicleId: v.id,
        salespersonId,
        status,
        paymentType: input.paymentType,
        saleDate: input.saleDate ?? todayInZone(ctx.tenant.settings.timezone),
        vehiclePriorStatus: v.status,
        ...p,
        installmentTerms: input.paymentType === 'installments' ? input.installmentTerms : null,
        externalFinance: input.paymentType === 'external_finance' ? { ...input.externalFinance, status: 'pending' } : null,
        vehicleSnapshot: await this.vehicleSnapshot(v.id),
        customerSnapshot: await this.customerSnapshot(c.id),
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    for (const t of input.tradeIns) await this.insertTradeIn(ctx, s!, t);
    if (p.approvalPermission) await this.openApproval(ctx, s!);
    await this.audit.record({ action: 'sale.created', entityType: 'sale', entityId: s!.id, summary: `${number}: ${p.grossAmount}`, after: s });
    return this.get(ctx, s!.id);
  }

  private async insertTradeIn(ctx: TenantContext, s: SaleRow, t: TradeInInput) {
    await this.dbs.db.insert(tradeIns).values({
      tenantId: ctx.tenant.id,
      saleId: s.id,
      customerId: s.customerId,
      agreedValue: money(t.agreedValue, ctx.tenant.baseCurrency),
      vehicleInput: t.vehicle,
      notes: t.notes ?? null,
      createdBy: ctx.userId,
    });
  }

  private async openApproval(ctx: TenantContext, s: SaleRow): Promise<void> {
    await this.approvals.open(ctx, {
      type: s.approvalPermission === 'sales.approve_below_floor' ? 'sale_below_floor' : 'sale_discount',
      entityType: 'sale',
      entityId: s.id,
      requiredPermission: s.approvalPermission!,
      summary: `${s.number}: ${s.agreedPrice} (−${s.discountPct}%)`,
      payload: { agreedPrice: s.agreedPrice, askingPrice: s.askingPrice, floorPrice: s.floorPrice, discountPct: s.discountPct },
      branchId: s.branchId,
    });
  }

  private async cancelApproval(ctx: TenantContext, s: SaleRow, note: string): Promise<void> {
    for (const type of ['sale_discount', 'sale_below_floor'] as const) {
      await this.approvals.resolve(ctx, { type, entityType: 'sale', entityId: s.id, status: 'cancelled', note });
    }
  }

  async update(ctx: TenantContext, id: string, input: SaleUpdateInput) {
    const before = await this.find(ctx, id, true);
    this.checkVersion(before, input.version);
    this.assertStatus(before, PRE_CONFIRM);
    const v = await this.vehicles.lock(before.vehicleId);
    const paymentType = input.paymentType ?? before.paymentType;
    const terms = input.installmentTerms === undefined ? (before.installmentTerms as InstallmentTermsInput | null) : input.installmentTerms;
    const p = await this.price(ctx, v, {
      agreedPrice: input.agreedPrice ?? before.agreedPrice,
      paymentType,
      downPayment: input.downPayment === undefined ? before.downPayment : input.downPayment,
      installmentTerms: paymentType === 'installments' ? terms : null,
    });
    if (paymentType === 'installments' && !terms) throw unprocessable('required_for_installments', 'Installment terms are required', { field: 'installmentTerms' });
    const tradeInTotal = await this.pendingTradeInTotal(before.id);
    this.assertCreditFits(p, tradeInTotal);
    if (input.salespersonId && input.salespersonId !== before.salespersonId) {
      assertPermission(ctx, 'leads.assign');
      await assertWorkingMember(this.dbs, ctx, input.salespersonId, before.branchId, 'sales.create');
    }
    // A changed price needs a fresh decision; an unchanged one keeps an earlier approval.
    const priceChanged = p.agreedPrice !== before.agreedPrice;
    const status = p.approvalPermission ? (before.status === 'approved' && !priceChanged ? 'approved' : 'pending_approval') : 'draft';
    const [after] = await this.dbs.db
      .update(sales)
      .set({
        ...p,
        paymentType,
        installmentTerms: paymentType === 'installments' ? terms : null,
        externalFinance:
          paymentType === 'external_finance' ? (input.externalFinance ? { ...input.externalFinance, status: 'pending' } : before.externalFinance) : null,
        salespersonId: input.salespersonId ?? before.salespersonId,
        leadId: input.leadId === undefined ? before.leadId : input.leadId,
        saleDate: input.saleDate ?? before.saleDate,
        notes: input.notes === undefined ? before.notes : input.notes,
        status,
        approvedBy: status === 'approved' ? before.approvedBy : null,
        approvedAt: status === 'approved' ? before.approvedAt : null,
        version: before.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(sales.id, id), eq(sales.version, before.version)))
      .returning();
    if (!after) throw conflict('version_conflict', 'This sale was changed by someone else. Reload and try again.');
    if (before.status === 'pending_approval' || status !== before.status || priceChanged) {
      await this.cancelApproval(ctx, before, 'Sale edited');
      if (status === 'pending_approval') await this.openApproval(ctx, after);
    }
    await this.audit.record({ action: 'sale.updated', entityType: 'sale', entityId: id, ...diff(before, after) });
    return this.get(ctx, id);
  }

  private async pendingTradeInTotal(saleId: string): Promise<string> {
    const rows = await this.dbs.db.select({ v: tradeIns.agreedValue }).from(tradeIns).where(and(eq(tradeIns.saleId, saleId), inArray(tradeIns.status, ['pending', 'received'])));
    return sum(rows.map((r) => r.v)).toFixed(2);
  }

  async addTradeIn(ctx: TenantContext, id: string, input: TradeInInput & { version: number }) {
    const s = await this.find(ctx, id, true);
    this.checkVersion(s, input.version);
    this.assertStatus(s, PRE_CONFIRM);
    const total = d(await this.pendingTradeInTotal(s.id)).plus(input.agreedValue);
    this.assertCreditFits(s as unknown as Pricing, total.toFixed(2));
    await this.insertTradeIn(ctx, s, input);
    await this.dbs.db.update(sales).set({ version: s.version + 1, updatedAt: new Date() }).where(eq(sales.id, id));
    await this.audit.record({ action: 'sale.updated', entityType: 'sale', entityId: id, summary: `Trade-in added: ${input.agreedValue}` });
    return this.get(ctx, id);
  }

  async removeTradeIn(ctx: TenantContext, id: string, tradeInId: string, version: number) {
    const s = await this.find(ctx, id, true);
    this.checkVersion(s, version);
    this.assertStatus(s, PRE_CONFIRM);
    const [t] = await this.dbs.db.select().from(tradeIns).where(and(eq(tradeIns.id, tradeInId), eq(tradeIns.saleId, id)));
    if (!t || t.status !== 'pending') throw notFound('Trade-in');
    await this.dbs.db.update(tradeIns).set({ status: 'cancelled' }).where(eq(tradeIns.id, tradeInId));
    await this.dbs.db.update(sales).set({ version: s.version + 1, updatedAt: new Date() }).where(eq(sales.id, id));
    await this.audit.record({ action: 'sale.updated', entityType: 'sale', entityId: id, summary: `Trade-in removed: ${t.agreedValue}` });
    return this.get(ctx, id);
  }

  // ── Price approval (B-011) ────────────────────────────────────────────────────────────

  async approve(ctx: TenantContext, id: string, input: { note?: string | null; version?: number }) {
    const s = await this.find(ctx, id, true);
    this.checkVersion(s, input.version);
    this.assertStatus(s, ['pending_approval']);
    assertPermission(ctx, s.approvalPermission as 'sales.approve_discount');
    await this.approvals.assertNotSelfApproval(ctx, {
      type: s.approvalPermission === 'sales.approve_below_floor' ? 'sale_below_floor' : 'sale_discount',
      entityType: 'sale',
      entityId: s.id,
      makers: [s.createdBy, s.salespersonId],
    });
    await this.dbs.db
      .update(sales)
      .set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date(), version: s.version + 1, updatedAt: new Date() })
      .where(eq(sales.id, id));
    for (const type of ['sale_discount', 'sale_below_floor'] as const) {
      await this.approvals.resolve(ctx, { type, entityType: 'sale', entityId: s.id, status: 'approved', note: input.note });
    }
    await this.audit.record({ action: 'sale.price_approved', entityType: 'sale', entityId: id, before: { status: s.status }, after: { status: 'approved', note: input.note ?? null } });
    return this.get(ctx, id);
  }

  async reject(ctx: TenantContext, id: string, input: { reason: string; version?: number }) {
    const s = await this.find(ctx, id, true);
    this.checkVersion(s, input.version);
    this.assertStatus(s, ['pending_approval']);
    assertPermission(ctx, s.approvalPermission as 'sales.approve_discount');
    // Back to draft: the seller can change the price (which re-opens the approval) or cancel.
    await this.dbs.db.update(sales).set({ status: 'draft', version: s.version + 1, updatedAt: new Date() }).where(eq(sales.id, id));
    for (const type of ['sale_discount', 'sale_below_floor'] as const) {
      await this.approvals.resolve(ctx, { type, entityType: 'sale', entityId: s.id, status: 'rejected', note: input.reason });
    }
    await this.audit.record({ action: 'sale.price_rejected', entityType: 'sale', entityId: id, before: { status: s.status }, after: { status: 'draft', reason: input.reason } });
    return this.get(ctx, id);
  }

  // ── Confirmation ──────────────────────────────────────────────────────────────────────

  async confirm(ctx: TenantContext, id: string, input: { version: number }) {
    assertPermission(ctx, 'sales.confirm');
    const s = await this.find(ctx, id, true);
    this.checkVersion(s, input.version);
    this.assertStatus(s, ['draft', 'approved']);
    if (s.status === 'draft' && s.approvalPermission) throw conflict('approval_required', 'The price needs approval before the sale can be confirmed');
    const v = await this.vehicles.lock(s.vehicleId);
    if (v.status !== 'sale_pending') throw conflict('vehicle_not_available', 'The vehicle is no longer held for this sale', { vehicleStatus: v.status });

    // Terms are frozen now: tax is recomputed on the current cost (margin scheme) and fixed.
    const p = await this.price(ctx, v, {
      agreedPrice: s.agreedPrice,
      paymentType: s.paymentType,
      downPayment: s.downPayment,
      installmentTerms: s.installmentTerms as InstallmentTermsInput | null,
    });
    const costAtConfirmation = await this.vehicleCost(v.id);
    const today = todayInZone(ctx.tenant.settings.timezone);

    let depositTransferred = d(0);
    if (s.reservationId) {
      const [r] = await this.dbs.db.select().from(reservations).where(eq(reservations.id, s.reservationId)).for('update');
      if (r && r.status === 'active') {
        depositTransferred = d(await this.reservations.availableDepositBase(r));
        await this.reservations.markConverted(ctx, r.id, s.id);
      }
    }

    // Trade-ins enter stock now, capitalised at the agreed value and credited to the customer.
    const pending = await this.dbs.db.select().from(tradeIns).where(and(eq(tradeIns.saleId, s.id), eq(tradeIns.status, 'pending'))).orderBy(asc(tradeIns.createdAt));
    const tradeInTotal = sum(pending.map((t) => t.agreedValue));
    const heldReceipts = d(await this.dbs.db
      .select({ v: sql<string>`coalesce(sum(${receiptAllocations.amountBase}), 0)::text` })
      .from(receiptAllocations)
      .innerJoin(receipts, eq(receipts.id, receiptAllocations.receiptId))
      .where(and(eq(receiptAllocations.targetType, 'sale'), eq(receiptAllocations.targetId, s.id), eq(receipts.status, 'posted')))
      .then((r) => r[0]?.v ?? '0'));
    this.assertCreditFits(p, tradeInTotal.plus(depositTransferred).plus(heldReceipts).toFixed(2));
    if (pending.length) {
      const purchase = await this.costs.categoryByCode('purchase');
      for (const t of pending) {
        const tv = await this.vehicles.create(
          ctx,
          { ...(t.vehicleInput as Record<string, unknown>), branchId: s.branchId, initialStatus: 'incoming', featureIds: [] } as never,
          { source: 'sale' },
        );
        const cost = await this.costs.create(
          ctx,
          {
            vehicleId: tv.id,
            categoryId: purchase.id,
            description: `Trade-in on sale ${s.number}`,
            amount: t.agreedValue,
            currency: ctx.tenant.baseCurrency,
            exchangeRate: '1',
            costDate: today,
            supplierId: null,
            notes: t.notes,
          } as never,
          { sourceType: 'trade_in', sourceId: t.id, forceStatus: 'posted', skipPayNow: true, creditOverride: { account: '2100', customerId: s.customerId, saleId: s.id } },
        );
        await this.dbs.db.update(tradeIns).set({ status: 'received', vehicleId: tv.id, costId: cost.id }).where(eq(tradeIns.id, t.id));
      }
    }

    await this.vehicles.transition(ctx, v.id, 'sold', { system: true, source: 'sale', sourceId: s.id, reason: `Sale ${s.number} confirmed` });
    const [confirmed] = await this.dbs.db
      .update(sales)
      .set({
        ...p,
        approvalPermission: s.approvalPermission,
        status: 'confirmed',
        tradeInCredit: tradeInTotal.toFixed(2),
        depositTransferred: depositTransferred.toFixed(2),
        costAtConfirmation,
        vehicleSnapshot: await this.vehicleSnapshot(v.id),
        customerSnapshot: await this.customerSnapshot(s.customerId),
        confirmedAt: new Date(),
        confirmedBy: ctx.userId,
        version: s.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(sales.id, id))
      .returning();
    let sale = confirmed!;
    if (sale.paymentType === 'installments') await this.installments.createScheduled(ctx, sale, sale.installmentTerms as InstallmentTermsInput);
    await this.commissions.createExpected(ctx, sale, costAtConfirmation);
    if (sale.leadId) await this.leadsService.markWonBySale(ctx, sale.leadId, sale.id);
    await this.audit.record({
      action: 'sale.confirmed',
      entityType: 'sale',
      entityId: id,
      summary: `${s.number}: ${sale.grossAmount}`,
      before: { status: s.status },
      after: { status: 'confirmed', gross: sale.grossAmount, tradeInCredit: sale.tradeInCredit, depositTransferred: sale.depositTransferred, costAtConfirmation },
    });
    if (ctx.tenant.settings.revenueRecognition === 'on_confirmation') {
      sale = await this.money.recognize(ctx, sale);
      await this.commissions.checkEarned(ctx, sale, await this.money.fullyPaid(sale));
    }
    return this.get(ctx, id);
  }

  async decideExternalFinance(ctx: TenantContext, id: string, input: { status: 'approved' | 'rejected'; reference?: string | null; note?: string | null }) {
    assertPermission(ctx, 'sales.confirm');
    const s = await this.find(ctx, id, true);
    if (s.paymentType !== 'external_finance') throw conflict('not_external_finance', 'This sale is not financed externally');
    this.assertStatus(s, [...PRE_CONFIRM, 'confirmed']);
    const ef = { ...(s.externalFinance as Record<string, unknown>), status: input.status, reference: input.reference ?? (s.externalFinance as { reference?: string })?.reference ?? null, decidedAt: new Date().toISOString(), decidedBy: ctx.userId, note: input.note ?? null };
    await this.dbs.db.update(sales).set({ externalFinance: ef, version: s.version + 1, updatedAt: new Date() }).where(eq(sales.id, id));
    await this.audit.record({ action: `sale.external_finance_${input.status}`, entityType: 'sale', entityId: id, before: { externalFinance: s.externalFinance }, after: { externalFinance: ef } });
    return this.get(ctx, id);
  }

  // ── Delivery (B-012) ──────────────────────────────────────────────────────────────────

  /** What still blocks delivery (empty = can deliver). */
  private async deliveryBlockers(s: SaleRow): Promise<Array<{ code: string; amount?: string }>> {
    const out: Array<{ code: string; amount?: string }> = [];
    if (!(await this.documents.liveDocument(s.id, 'invoice'))) out.push({ code: 'invoice_required' });
    const held = d(await this.money.held(s));
    if (s.paymentType === 'cash') {
      if (held.lt(s.grossAmount)) out.push({ code: 'balance_due', amount: d(s.grossAmount).minus(held).toFixed(2) });
    } else if (s.paymentType === 'installments') {
      if (held.lt(s.downPayment!)) out.push({ code: 'down_payment_due', amount: d(s.downPayment!).minus(held).toFixed(2) });
    } else {
      const ef = s.externalFinance as { status?: string; amount?: string } | null;
      if (ef?.status !== 'approved') out.push({ code: 'finance_not_approved' });
      const covered = held.plus(ef?.status === 'approved' ? (ef.amount ?? '0') : '0');
      if (covered.lt(s.grossAmount)) out.push({ code: 'balance_due', amount: d(s.grossAmount).minus(covered).toFixed(2) });
    }
    return out;
  }

  async deliver(ctx: TenantContext, id: string, input: { version: number; overrideReason?: string; odometer?: number }) {
    assertPermission(ctx, 'sales.deliver');
    const s = await this.find(ctx, id, true);
    this.checkVersion(s, input.version);
    this.assertStatus(s, ['confirmed']);
    const blockers = await this.deliveryBlockers(s);
    if (blockers.some((b) => b.code === 'invoice_required')) throw conflict('invoice_required', 'Issue the invoice before delivering the vehicle');
    if (blockers.length) {
      if (!input.overrideReason) throw conflict('delivery_blocked', 'The sale is not paid as required for delivery', { blockers });
      assertPermission(ctx, 'sales.deliver_with_balance');
    }
    const v = await this.vehicles.lock(s.vehicleId);
    if (input.odometer !== undefined) {
      await this.vehicles.addOdometer(ctx, v.id, { value: input.odometer, unit: v.odometerUnit as 'km' | 'mi', source: 'delivery', notes: null });
    }
    await this.vehicles.transition(ctx, v.id, 'delivered', { system: true, source: 'delivery', sourceId: s.id, reason: `Sale ${s.number} delivered` });
    const [delivered] = await this.dbs.db
      .update(sales)
      .set({
        status: 'delivered',
        deliveredAt: new Date(),
        deliveredBy: ctx.userId,
        deliveryOverrideReason: blockers.length ? input.overrideReason! : null,
        version: s.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(sales.id, id))
      .returning();
    let sale = delivered!;
    sale = await this.money.recognize(ctx, sale);
    await this.documents.issueInternal(ctx, sale, 'delivery_note', input.odometer !== undefined ? { deliveryOdometer: { value: input.odometer, unit: v.odometerUnit } } : {});
    await this.commissions.checkEarned(ctx, sale, await this.money.fullyPaid(sale));
    await this.audit.record({
      action: blockers.length ? 'sale.delivered_with_balance' : 'sale.delivered',
      entityType: 'sale',
      entityId: id,
      summary: s.number,
      before: { status: 'confirmed' },
      after: { status: 'delivered', blockers, overrideReason: blockers.length ? input.overrideReason : null },
    });
    return this.get(ctx, id);
  }

  // ── Cancellation & return (B-013) ─────────────────────────────────────────────────────

  async cancel(ctx: TenantContext, id: string, input: { reason: string; version: number }) {
    const s = await this.find(ctx, id, true);
    this.checkVersion(s, input.version);
    if (s.status === 'delivered') throw conflict('use_return', 'A delivered sale is returned, not cancelled');
    this.assertStatus(s, [...PRE_CONFIRM, 'confirmed']);
    assertPermission(ctx, s.status === 'confirmed' ? 'sales.cancel_confirmed' : 'sales.cancel');
    const v = await this.vehicles.lock(s.vehicleId);
    if (s.status === 'confirmed') {
      await this.money.unwind(ctx, s, input.reason);
      const plan = await this.installments.forSale(s.id, true);
      if (plan && plan.status === 'scheduled') await this.installments.unwind(ctx, plan, s, todayInZone(ctx.tenant.settings.timezone));
      await this.commissions.reverseForSale(ctx, s, input.reason);
      await this.documents.closeOut(ctx, s, input.reason);
      await this.vehicles.transition(ctx, v.id, 'available', { system: true, source: 'sale', sourceId: s.id, reason: `Sale ${s.number} cancelled: ${input.reason}` });
    } else {
      await this.cancelApproval(ctx, s, 'Sale cancelled');
      await this.dbs.db.update(tradeIns).set({ status: 'cancelled' }).where(and(eq(tradeIns.saleId, s.id), eq(tradeIns.status, 'pending')));
      // Back to where it was: reserved again if its reservation is still active, else available.
      const [r] = s.reservationId
        ? await this.dbs.db.select({ status: reservations.status }).from(reservations).where(eq(reservations.id, s.reservationId))
        : [];
      const to = r?.status === 'active' ? 'reserved' : 'available';
      await this.vehicles.transition(ctx, v.id, to, { system: true, source: 'sale', sourceId: s.id, reason: `Sale ${s.number} cancelled: ${input.reason}` });
    }
    await this.dbs.db
      .update(sales)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: ctx.userId, cancelReason: input.reason, version: s.version + 1, updatedAt: new Date() })
      .where(eq(sales.id, id));
    await this.audit.record({ action: 'sale.cancelled', entityType: 'sale', entityId: id, summary: s.number, before: { status: s.status }, after: { status: 'cancelled', reason: input.reason } });
    return this.get(ctx, id);
  }

  async returnSale(ctx: TenantContext, id: string, input: { reason: string; version: number }) {
    assertPermission(ctx, 'sales.return');
    const s = await this.find(ctx, id, true);
    this.checkVersion(s, input.version);
    this.assertStatus(s, ['delivered']);
    await this.vehicles.lock(s.vehicleId);
    await this.money.unwind(ctx, s, input.reason);
    await this.commissions.reverseForSale(ctx, s, input.reason);
    await this.documents.closeOut(ctx, s, input.reason);
    await this.vehicles.transition(ctx, s.vehicleId, 'returned', { system: true, source: 'return', sourceId: s.id, reason: `Sale ${s.number} returned: ${input.reason}` });
    await this.dbs.db
      .update(sales)
      .set({ status: 'returned', returnedAt: new Date(), returnedBy: ctx.userId, returnReason: input.reason, version: s.version + 1, updatedAt: new Date() })
      .where(eq(sales.id, id));
    await this.audit.record({ action: 'sale.returned', entityType: 'sale', entityId: id, summary: s.number, before: { status: 'delivered' }, after: { status: 'returned', reason: input.reason } });
    return this.get(ctx, id);
  }

  // ── Queries ───────────────────────────────────────────────────────────────────────────

  async list(ctx: TenantContext, q: SaleListQuery) {
    const conds: SQL[] = this.scope(ctx);
    if (q.status) conds.push(eq(sales.status, q.status));
    if (q.customerId) conds.push(eq(sales.customerId, q.customerId));
    if (q.vehicleId) conds.push(eq(sales.vehicleId, q.vehicleId));
    if (q.salespersonId) conds.push(eq(sales.salespersonId, q.salespersonId));
    if (q.mine === 'true') conds.push(eq(sales.salespersonId, ctx.userId));
    if (q.branchId) conds.push(eq(sales.branchId, q.branchId));
    if (q.paymentType) conds.push(eq(sales.paymentType, q.paymentType));
    if (q.from) conds.push(sql`${sales.saleDate} >= ${q.from}`);
    if (q.to) conds.push(sql`${sales.saleDate} <= ${q.to}`);
    if (q.q) {
      const like = `%${q.q.replace(/[%_]/g, '')}%`;
      conds.push(or(ilike(sales.number, like), ilike(customers.fullName, like), ilike(vehicles.stockNumber, like), ilike(vehicles.vin, like))!);
    }
    const where = conds.length ? and(...conds) : undefined;
    const held = sql<string>`(coalesce((SELECT sum(ra.amount_base) FROM receipt_allocations ra JOIN receipts r ON r.id = ra.receipt_id WHERE ra.target_type = 'sale' AND ra.target_id = sales.id AND r.status = 'posted'), 0) + sales.trade_in_credit + sales.deposit_transferred)::numeric(18,2)::text`;
    const [items, [total]] = await Promise.all([
      this.dbs.db
        .select({
          id: sales.id,
          number: sales.number,
          status: sales.status,
          paymentType: sales.paymentType,
          saleDate: sales.saleDate,
          grossAmount: sales.grossAmount,
          held,
          customerId: sales.customerId,
          customerName: customers.fullName,
          vehicleId: sales.vehicleId,
          stockNumber: vehicles.stockNumber,
          vehicle: sales.vehicleSnapshot,
          salespersonId: sales.salespersonId,
          salespersonName: users.fullName,
          branchId: sales.branchId,
          createdAt: sales.createdAt,
          version: sales.version,
        })
        .from(sales)
        .innerJoin(customers, eq(customers.id, sales.customerId))
        .innerJoin(vehicles, eq(vehicles.id, sales.vehicleId))
        .leftJoin(users, eq(users.id, sales.salespersonId))
        .where(where)
        .orderBy(desc(sales.createdAt), desc(sales.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.dbs.db
        .select({ n: sql<number>`count(*)::int` })
        .from(sales)
        .innerJoin(customers, eq(customers.id, sales.customerId))
        .innerJoin(vehicles, eq(vehicles.id, sales.vehicleId))
        .where(where),
    ]);
    return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(ctx: TenantContext, id: string) {
    const s = await this.find(ctx, id);
    const held = await this.money.held(s);
    const due = this.money.dueUpfront(s);
    const payments = await this.dbs.db
      .select({ receiptId: receipts.id, number: receipts.number, receivedAt: receipts.receivedAt, method: receipts.method, status: receipts.status, amountBase: receiptAllocations.amountBase })
      .from(receiptAllocations)
      .innerJoin(receipts, eq(receipts.id, receiptAllocations.receiptId))
      .where(and(eq(receiptAllocations.targetType, 'sale'), eq(receiptAllocations.targetId, s.id)))
      .orderBy(asc(receipts.receivedAt), asc(receipts.number));
    const trades = await this.dbs.db.select().from(tradeIns).where(eq(tradeIns.saleId, s.id)).orderBy(asc(tradeIns.createdAt));
    const plan = await this.installments.forSale(s.id);
    const canSeeProfit = hasPermission(ctx, 'vehicles.view_cost');
    const commission = hasPermission(ctx, 'commissions.read') || s.salespersonId === ctx.userId ? await this.commissions.forSaleRead(s.id) : null;
    const [salesperson] = await this.dbs.db.select({ fullName: users.fullName }).from(users).where(eq(users.id, s.salespersonId));
    const blockers = s.status === 'confirmed' ? await this.deliveryBlockers(s) : [];
    return {
      ...s,
      costAtConfirmation: canSeeProfit ? s.costAtConfirmation : null,
      cogsAmount: canSeeProfit ? s.cogsAmount : null,
      grossProfit: canSeeProfit && s.cogsAmount ? d(s.netAmount).minus(s.cogsAmount).toFixed(2) : null,
      salespersonName: salesperson?.fullName ?? null,
      money: {
        held,
        dueBeforeDelivery: due,
        outstandingBeforeDelivery: d(due).minus(held).isNegative() ? '0.00' : d(due).minus(held).toFixed(2),
        refundable: await this.money.refundableBase(s),
        receivable: s.recognizedAt ? await this.money.receivableBalance(s.id) : null,
      },
      payments,
      tradeIns: trades,
      installmentPlan: plan ? { id: plan.id, status: plan.status, totalAmount: plan.totalAmount, count: plan.count, method: plan.method } : null,
      commission,
      documents: await this.documents.forSale(s.id),
      deliveryBlockers: blockers,
    };
  }
}
