import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, or, SQL, sql } from 'drizzle-orm';
import {
  CustomerAssignInput,
  CustomerCreateInput,
  CustomerDuplicate,
  CustomerDuplicateCheckInput,
  CustomerDuplicateResult,
  CustomerMatchField,
  CustomerPatchInput,
  CustomerSearchQuery,
  InteractionCreateInput,
  InteractionListQuery,
  maskNationalId,
  normalizeCustomerPhone,
  normalizeEmail,
  normalizeNationalId,
  todayInZone,
  toLatinDigits,
} from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { decryptSecret, encryptSecret, hmacHex } from '../../common/crypto';
import { conflict, forbidden, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { ownEntry } from '../../common/lookup';
import { DbService } from '../../db/db.service';
import {
  appointments,
  branches,
  customerInteractions,
  customers,
  customerWishes,
  leads,
  membershipBranches,
  memberships,
  pipelineStages,
  users,
  vehicleMakes,
  vehicleModels,
  vehicles,
} from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { ReceiptsService } from '../finance/receipts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReservationsService } from '../reservations/reservations.service';
import { SYSTEM_USER_ID } from '../jobs/system-context';

registerUniqueConstraint('customers_national_id_uq', 'customer_national_id_taken', 'A customer with this national ID already exists');

export type CustomerRow = typeof customers.$inferSelect;
type CustomerInsert = typeof customers.$inferInsert;

/** What the API exposes: the encrypted national ID and its hash never leave the server. */
export type CustomerView = Omit<CustomerRow, 'nationalIdEnc' | 'nationalIdHash' | 'nationalIdLast4'> & {
  nationalIdMasked: string | null;
  hasNationalId: boolean;
};

export function presentCustomer(row: CustomerRow): CustomerView {
  const { nationalIdEnc: _enc, nationalIdHash: _hash, nationalIdLast4, ...rest } = row;
  return { ...rest, nationalIdMasked: maskNationalId(nationalIdLast4), hasNationalId: !!nationalIdLast4 };
}

const PHONE_FIELDS = ['phone', 'phoneAlt', 'whatsapp'] as const;
const SORTS = { fullName: customers.fullName, createdAt: customers.createdAt, updatedAt: customers.updatedAt } as const;

interface MatchInput {
  phones: string[];
  email: string | null;
  nationalIdHash: string | null;
  commercialRegistration: string | null;
  taxNumber: string | null;
  excludeId?: string | null;
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
const upperTrim = (v: string | null | undefined) => (v && v.trim() ? v.trim().toUpperCase() : null);

/**
 * Customers (CRM master data) and their interaction timeline.
 *
 * Visibility (applied to the list, the 360 view and every sub-resource; hidden customers are 404):
 *  - customers.read_all: every customer whose branch is in the caller's scope (or has no branch);
 *  - everyone: customers assigned to them, customers with a lead assigned to them, and customers
 *    they created (the last one only within their branch scope).
 * Phone numbers are stored canonically (digits with country code); national IDs only encrypted,
 * with a keyed hash for exact-match dedupe and the last 4 characters for display.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly reservations: ReservationsService,
    private readonly receipts: ReceiptsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Visibility ──────────────────────────────────────────────────────────────────────────

  /**
   * SQL condition for the customers the caller may see; undefined = unrestricted. The query must
   * have the `customers` table in FROM without an alias (the lead check is a correlated subquery).
   */
  visibleWhere(ctx: TenantContext): SQL | undefined {
    const branchOk = ctx.allBranches
      ? undefined
      : ctx.branchIds.length
        ? or(isNull(customers.branchId), inArray(customers.branchId, ctx.branchIds))!
        : isNull(customers.branchId);
    const readAll = hasPermission(ctx, 'customers.read_all');
    if (readAll && !branchOk) return undefined;
    const own = or(
      eq(customers.assignedUserId, ctx.userId),
      sql`EXISTS (SELECT 1 FROM leads l WHERE l.customer_id = customers.id AND l.assigned_user_id = ${ctx.userId})`,
      branchOk ? and(eq(customers.createdBy, ctx.userId), branchOk)! : eq(customers.createdBy, ctx.userId),
    )!;
    return readAll ? or(branchOk!, own)! : own;
  }

  /** Loads a customer the caller may see (404 otherwise, also across tenants). */
  async assertVisible(ctx: TenantContext, id: string, lock = false): Promise<CustomerRow> {
    const q = this.dbs.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), this.visibleWhere(ctx)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw notFound('Customer');
    return row;
  }

  // ── Normalisation & validation helpers ──────────────────────────────────────────────────

  /** Canonical phone/email/national-ID column values for the fields present in `input`. */
  private contactValues(
    ctx: TenantContext,
    input: { phone?: string | null; phoneAlt?: string | null; whatsapp?: string | null; email?: string | null; nationalId?: string | null },
  ): Partial<CustomerInsert> {
    const out: Partial<CustomerInsert> = {};
    for (const f of PHONE_FIELDS) {
      const v = input[f];
      if (v === undefined) continue;
      if (v === null || !v.trim()) {
        out[f] = null;
        continue;
      }
      const n = normalizeCustomerPhone(v, ctx.tenant.market);
      if (!n) throw unprocessable('invalid_phone', 'This phone number is not valid', { field: f });
      out[f] = n;
    }
    if (input.email !== undefined) out.email = normalizeEmail(input.email);
    if (input.nationalId !== undefined) {
      if (!input.nationalId) {
        out.nationalIdEnc = null;
        out.nationalIdHash = null;
        out.nationalIdLast4 = null;
      } else {
        const nid = normalizeNationalId(input.nationalId);
        if (!nid) throw unprocessable('invalid_national_id', 'The national ID / Iqama number is not valid', { field: 'nationalId' });
        out.nationalIdEnc = encryptSecret(nid);
        out.nationalIdHash = hmacHex(nid);
        out.nationalIdLast4 = nid.slice(-4);
      }
    }
    return out;
  }

  private assertDateOfBirth(ctx: TenantContext, dob: string | null | undefined) {
    if (dob && dob > todayInZone(ctx.tenant.settings.timezone)) {
      throw unprocessable('invalid_date_of_birth', 'The date of birth cannot be in the future', { field: 'dateOfBirth' });
    }
  }

  private async assertBranch(ctx: TenantContext, branchId: string) {
    const [b] = await this.dbs.db.select({ id: branches.id, isActive: branches.isActive }).from(branches).where(eq(branches.id, branchId));
    if (!b) throw notFound('Branch');
    if (!b.isActive) throw unprocessable('branch_inactive', 'This branch is inactive');
    assertBranchAccess(ctx, branchId);
  }

  /** Assigning a customer to someone else (or reassigning/unassigning) is a manager action. */
  private assertCanAssign(ctx: TenantContext) {
    if (!hasPermission(ctx, 'leads.assign') && !hasPermission(ctx, 'customers.read_all')) {
      throw forbidden('You do not have permission to assign customers', { permission: ['leads.assign', 'customers.read_all'] });
    }
  }

  /** The assignee must be an active member of THIS company with access to the customer's branch. */
  private async assertAssignee(ctx: TenantContext, userId: string, branchId: string | null) {
    const [m] = await this.dbs.db
      .select({ id: memberships.id, allBranches: memberships.allBranches })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          // Explicit tenant filter: the own-membership policy also exposes the caller's other companies.
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          eq(users.status, 'active'),
        ),
      );
    if (!m) throw unprocessable('assignee_not_member', 'The assigned user is not an active member of this company');
    if (m.allBranches || !branchId) return;
    const [b] = await this.dbs.db
      .select({ branchId: membershipBranches.branchId })
      .from(membershipBranches)
      .where(and(eq(membershipBranches.membershipId, m.id), eq(membershipBranches.branchId, branchId)));
    if (!b) throw unprocessable('assignee_no_branch_access', "The assigned user has no access to the customer's branch");
  }

  /**
   * Serialises creates/edits that use the same phone or national ID, so two concurrent requests
   * cannot both pass the duplicate check (transaction-scoped advisory locks, taken in sorted order).
   */
  private async lockIdentities(ctx: TenantContext, keys: string[]) {
    for (const k of [...new Set(keys)].sort()) {
      await this.dbs.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`customer-identity:${ctx.tenant.id}:${k}`]);
    }
  }

  private async notifyAssignee(ctx: TenantContext, c: CustomerRow) {
    if (!c.assignedUserId || c.assignedUserId === ctx.userId) return;
    await this.notifications.notify(ctx, {
      userIds: [c.assignedUserId],
      type: 'customer.assigned',
      titleAr: `تم إسناد العميل ${c.fullName} إليك`,
      titleEn: `Customer ${c.fullName} was assigned to you`,
      link: `/app/customers/${c.id}`,
      entityType: 'customer',
      entityId: c.id,
      dedupeKey: `customer.assigned:${c.id}:${c.version}`,
    });
  }

  // ── Duplicates ──────────────────────────────────────────────────────────────────────────

  /** Customers matching any identifier (tenant-wide, regardless of visibility; minimal fields only). */
  private async matches(ctx: TenantContext, m: MatchInput): Promise<CustomerDuplicate[]> {
    const no = sql`false`;
    const mPhone = m.phones.length ? or(inArray(customers.phone, m.phones), inArray(customers.whatsapp, m.phones), inArray(customers.phoneAlt, m.phones))! : no;
    const mEmail = m.email ? sql`lower(${customers.email}) = ${m.email}` : no;
    const mNid = m.nationalIdHash ? eq(customers.nationalIdHash, m.nationalIdHash) : no;
    const mCr = m.commercialRegistration ? sql`upper(btrim(${customers.commercialRegistration})) = ${m.commercialRegistration}` : no;
    const mTax = m.taxNumber ? sql`upper(btrim(${customers.taxNumber})) = ${m.taxNumber}` : no;
    if ([mPhone, mEmail, mNid, mCr, mTax].every((x) => x === no)) return [];
    const vis = this.visibleWhere(ctx);
    const rows = await this.dbs.db
      .select({
        id: customers.id,
        type: customers.type,
        fullName: customers.fullName,
        companyName: customers.companyName,
        isActive: customers.isActive,
        branchId: customers.branchId,
        assignedUserId: customers.assignedUserId,
        assignedUserName: users.fullName,
        mPhone: sql<boolean>`coalesce(${mPhone}, false)`,
        mEmail: sql<boolean>`coalesce(${mEmail}, false)`,
        mNid: sql<boolean>`coalesce(${mNid}, false)`,
        mCr: sql<boolean>`coalesce(${mCr}, false)`,
        mTax: sql<boolean>`coalesce(${mTax}, false)`,
        canView: vis ? sql<boolean>`coalesce(${vis}, false)` : sql<boolean>`true`,
      })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.assignedUserId))
      .where(and(or(mPhone, mEmail, mNid, mCr, mTax), m.excludeId ? sql`${customers.id} <> ${m.excludeId}` : undefined))
      .orderBy(sql`coalesce(${mNid}, false) DESC`, sql`coalesce(${mPhone}, false) DESC`, asc(customers.fullName))
      .limit(20);
    return rows.map((r) => {
      const matchedOn: CustomerMatchField[] = [];
      if (r.mNid) matchedOn.push('nationalId');
      if (r.mPhone) matchedOn.push('phone');
      if (r.mEmail) matchedOn.push('email');
      if (r.mCr) matchedOn.push('commercialRegistration');
      if (r.mTax) matchedOn.push('taxNumber');
      return {
        id: r.id,
        type: r.type as CustomerDuplicate['type'],
        // A customer the caller may not open is identified only by initials (no full name leak).
        fullName: r.canView ? r.fullName : r.fullName.split(/\s+/).map((w) => `${w.charAt(0)}.`).join(' '),
        companyName: r.companyName,
        isActive: r.isActive,
        branchId: r.branchId,
        assignedUserId: r.assignedUserId,
        assignedUserName: r.assignedUserName,
        matchedOn,
        canView: r.canView,
      };
    });
  }

  private static blockingOf(candidates: CustomerDuplicate[]) {
    const nid = candidates.filter((c) => c.matchedOn.includes('nationalId'));
    const phone = candidates.filter((c) => c.matchedOn.includes('phone'));
    return { nid, phone };
  }

  /**
   * Possible duplicates for the create/edit form. Invalid values are ignored (the form validates
   * them separately). Identifier values are never echoed back, only which field matched.
   */
  async checkDuplicates(ctx: TenantContext, q: CustomerDuplicateCheckInput): Promise<CustomerDuplicateResult> {
    const phones = [q.phone, q.phoneAlt, q.whatsapp].map((p) => normalizeCustomerPhone(p, ctx.tenant.market)).filter((p): p is string => !!p);
    const nid = normalizeNationalId(q.nationalId);
    const candidates = await this.matches(ctx, {
      phones: [...new Set(phones)],
      email: normalizeEmail(q.email),
      nationalIdHash: nid ? hmacHex(nid) : null,
      commercialRegistration: upperTrim(q.commercialRegistration),
      taxNumber: upperTrim(q.taxNumber),
      excludeId: q.excludeId ?? null,
    });
    const { nid: byNid, phone } = CustomersService.blockingOf(candidates);
    return { candidates, blocking: byNid.length > 0 || phone.length > 0, forceAllowed: byNid.length === 0 && phone.length > 0 && hasPermission(ctx, 'customers.manage') };
  }

  /**
   * Refuses exact duplicates: a national-ID match always (409, unforceable — one customer per ID),
   * a phone match unless `force` (needs customers.manage). Returns the ids a forced create duplicates.
   */
  private refuseDuplicates(ctx: TenantContext, candidates: CustomerDuplicate[], force: boolean | undefined): string[] {
    const { nid, phone } = CustomersService.blockingOf(candidates);
    const brief = (list: CustomerDuplicate[]) => list.map((c) => ({ id: c.id, fullName: c.fullName, matchedOn: c.matchedOn, canView: c.canView }));
    if (nid.length) {
      throw conflict('customer_duplicate', 'A customer with this national ID already exists', { matchedOn: 'nationalId', candidates: brief(nid), forceAllowed: false });
    }
    if (!phone.length) return [];
    if (!force) {
      throw conflict('customer_duplicate', 'A customer with this phone number already exists', {
        matchedOn: 'phone',
        candidates: brief(phone),
        forceAllowed: hasPermission(ctx, 'customers.manage'),
      });
    }
    assertPermission(ctx, 'customers.manage');
    return phone.map((c) => c.id);
  }

  // ── Queries ─────────────────────────────────────────────────────────────────────────────

  async list(ctx: TenantContext, q: CustomerSearchQuery) {
    const conds: Array<SQL | undefined> = [this.visibleWhere(ctx)];
    if (q.type) conds.push(eq(customers.type, q.type));
    if (q.assignedUserId) conds.push(eq(customers.assignedUserId, q.assignedUserId));
    if (q.mine === 'true') conds.push(eq(customers.assignedUserId, ctx.userId));
    if (q.tag) conds.push(sql`${q.tag} = ANY(${customers.tags})`);
    if (q.branchId) conds.push(eq(customers.branchId, q.branchId));
    const active = q.active ?? 'true';
    if (active !== 'all') conds.push(eq(customers.isActive, active === 'true'));
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      const search: SQL[] = [
        sql`${customers.fullName} ILIKE ${like}`,
        sql`${customers.companyName} ILIKE ${like}`,
        sql`${customers.email} ILIKE ${like}`,
        sql`${customers.commercialRegistration} ILIKE ${like}`,
        sql`${customers.taxNumber} ILIKE ${like}`,
      ];
      // Phone search on the canonical digits; a leading trunk "0" / "+" / "00" is ignored.
      const digits = toLatinDigits(q.q).replace(/[^\d]/g, '').replace(/^0+/, '');
      if (digits.length >= 4 && /^[\d\s+()\-.٠-٩۰-۹]+$/.test(q.q)) {
        const dl = `%${digits}%`;
        search.push(sql`${customers.phone} LIKE ${dl}`, sql`${customers.whatsapp} LIKE ${dl}`, sql`${customers.phoneAlt} LIKE ${dl}`);
      }
      // An exact national ID finds its customer through the keyed hash (never by partial match).
      const nid = normalizeNationalId(q.q);
      if (nid && nid.length >= 6) search.push(eq(customers.nationalIdHash, hmacHex(nid)));
      conds.push(or(...search));
    }
    const where = and(...conds);
    let order: SQL[] = [desc(customers.createdAt), desc(customers.id)];
    if (q.sort) {
      const col = ownEntry(SORTS, q.sort.replace(/^-/, ''));
      if (col) order = [q.sort.startsWith('-') ? desc(col) : asc(col), asc(customers.id)];
    }
    const items = await this.dbs.db
      .select({
        id: customers.id,
        type: customers.type,
        fullName: customers.fullName,
        companyName: customers.companyName,
        phone: customers.phone,
        whatsapp: customers.whatsapp,
        email: customers.email,
        nationalIdLast4: customers.nationalIdLast4,
        city: customers.city,
        source: customers.source,
        tags: customers.tags,
        isActive: customers.isActive,
        preferredLanguage: customers.preferredLanguage,
        branchId: customers.branchId,
        branchName: branches.name,
        assignedUserId: customers.assignedUserId,
        assignedUserName: users.fullName,
        openLeads: sql<number>`(SELECT count(*)::int FROM leads l WHERE l.customer_id = customers.id AND l.status = 'open')`,
        lastInteractionAt: sql<string | null>`(SELECT max(ci.occurred_at) FROM customer_interactions ci WHERE ci.customer_id = customers.id)`,
        createdAt: customers.createdAt,
        updatedAt: customers.updatedAt,
        version: customers.version,
      })
      .from(customers)
      .leftJoin(branches, eq(branches.id, customers.branchId))
      .leftJoin(users, eq(users.id, customers.assignedUserId))
      .where(where)
      .orderBy(...order)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [c] = await this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(customers).where(where);
    return {
      items: items.map(({ nationalIdLast4, ...r }) => ({ ...r, nationalIdMasked: maskNationalId(nationalIdLast4) })),
      total: c?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /**
   * Customer 360: profile, counts and the most recent leads, reservations, receipts (with the
   * advance balance), appointments, wishes and interactions. Each section is included only when
   * the caller holds its read permission (otherwise null); lead/appointment/reservation sections
   * follow the caller's branch scope, and leads also the reps' own-leads rule of GET /leads.
   */
  async get(ctx: TenantContext, id: string) {
    const c = await this.assertVisible(ctx, id);
    const db = this.dbs.db;
    const scope = ctx.allBranches ? null : ctx.branchIds;
    const canLeads = hasPermission(ctx, 'leads.read');
    const canAppts = hasPermission(ctx, 'appointments.read');
    const canRes = hasPermission(ctx, 'reservations.read');
    const canPay = hasPermission(ctx, 'payments.read');
    // Same rule as GET /leads: sales reps (no leads.assign, no customers.read_all) see only their own leads.
    const ownLeadsOf = !hasPermission(ctx, 'leads.assign') && !hasPermission(ctx, 'customers.read_all') ? ctx.userId : null;

    const [names] = await this.dbs.query<{ branch_name: string | null; assigned_user_name: string | null; created_by_name: string | null }>(
      `SELECT (SELECT name FROM branches WHERE id = $1) AS branch_name,
              (SELECT full_name FROM users WHERE id = $2) AS assigned_user_name,
              (SELECT full_name FROM users WHERE id = $3) AS created_by_name`,
      [c.branchId, c.assignedUserId, c.createdBy],
    );
    const [cnt] = await this.dbs.query<Record<string, number | string | null>>(
      `SELECT
         (SELECT count(*)::int FROM leads WHERE customer_id = $1 AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[]))
             AND ($3::uuid IS NULL OR assigned_user_id = $3)) AS leads,
         (SELECT count(*)::int FROM leads WHERE customer_id = $1 AND status = 'open' AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[]))
             AND ($3::uuid IS NULL OR assigned_user_id = $3)) AS open_leads,
         (SELECT count(*)::int FROM reservations WHERE customer_id = $1 AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[]))) AS reservations,
         (SELECT count(*)::int FROM reservations WHERE customer_id = $1 AND status = 'active' AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[]))) AS active_reservations,
         (SELECT count(*)::int FROM appointments WHERE customer_id = $1 AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[]))) AS appointments,
         (SELECT count(*)::int FROM appointments WHERE customer_id = $1 AND starts_at >= now() AND status IN ('scheduled', 'confirmed')
             AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[]))) AS upcoming_appointments,
         (SELECT count(*)::int FROM customer_wishes WHERE customer_id = $1) AS wishes,
         (SELECT count(*)::int FROM customer_wishes WHERE customer_id = $1 AND status = 'active') AS active_wishes,
         (SELECT count(*)::int FROM customer_interactions WHERE customer_id = $1) AS interactions,
         (SELECT max(occurred_at) FROM customer_interactions WHERE customer_id = $1) AS last_interaction_at`,
      [c.id, scope, ownLeadsOf],
    );
    const scoped = <T extends { branchId: unknown }>(col: T['branchId']) => (scope ? inArray(col as typeof leads.branchId, scope.length ? scope : ['00000000-0000-0000-0000-000000000000']) : undefined);

    const recentLeads = canLeads
      ? await db
          .select({
            id: leads.id,
            number: leads.number,
            status: leads.status,
            source: leads.source,
            branchId: leads.branchId,
            stageId: leads.stageId,
            stageCode: pipelineStages.code,
            stageNameEn: pipelineStages.nameEn,
            stageNameAr: pipelineStages.nameAr,
            assignedUserId: leads.assignedUserId,
            assignedUserName: users.fullName,
            vehicleId: leads.vehicleId,
            vehicleStockNumber: vehicles.stockNumber,
            budgetMin: leads.budgetMin,
            budgetMax: leads.budgetMax,
            expectedCloseDate: leads.expectedCloseDate,
            lastActivityAt: leads.lastActivityAt,
            nextFollowUpAt: leads.nextFollowUpAt,
            createdAt: leads.createdAt,
          })
          .from(leads)
          .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
          .leftJoin(users, eq(users.id, leads.assignedUserId))
          .leftJoin(vehicles, eq(vehicles.id, leads.vehicleId))
          .where(
            and(
              eq(leads.customerId, c.id),
              scoped<{ branchId: typeof leads.branchId }>(leads.branchId),
              ownLeadsOf ? eq(leads.assignedUserId, ownLeadsOf) : undefined,
            ),
          )
          .orderBy(desc(leads.createdAt))
          .limit(5)
      : null;

    const recentAppointments = canAppts
      ? await db
          .select({
            id: appointments.id,
            type: appointments.type,
            status: appointments.status,
            branchId: appointments.branchId,
            startsAt: appointments.startsAt,
            endsAt: appointments.endsAt,
            title: appointments.title,
            leadId: appointments.leadId,
            vehicleId: appointments.vehicleId,
            vehicleStockNumber: vehicles.stockNumber,
            assignedUserId: appointments.assignedUserId,
            assignedUserName: users.fullName,
          })
          .from(appointments)
          .leftJoin(vehicles, eq(vehicles.id, appointments.vehicleId))
          .leftJoin(users, eq(users.id, appointments.assignedUserId))
          .where(and(eq(appointments.customerId, c.id), scoped<{ branchId: typeof appointments.branchId }>(appointments.branchId)))
          .orderBy(desc(appointments.startsAt))
          .limit(5)
      : null;

    const recentWishes = await db
      .select({
        id: customerWishes.id,
        status: customerWishes.status,
        leadId: customerWishes.leadId,
        makeId: customerWishes.makeId,
        makeEn: vehicleMakes.nameEn,
        makeAr: vehicleMakes.nameAr,
        modelId: customerWishes.modelId,
        modelEn: vehicleModels.nameEn,
        modelAr: vehicleModels.nameAr,
        yearFrom: customerWishes.yearFrom,
        yearTo: customerWishes.yearTo,
        maxPrice: customerWishes.maxPrice,
        expiresAt: customerWishes.expiresAt,
        createdAt: customerWishes.createdAt,
      })
      .from(customerWishes)
      .leftJoin(vehicleMakes, eq(vehicleMakes.id, customerWishes.makeId))
      .leftJoin(vehicleModels, eq(vehicleModels.id, customerWishes.modelId))
      .where(eq(customerWishes.customerId, c.id))
      .orderBy(desc(customerWishes.createdAt))
      .limit(5);

    const reservationPage = canRes ? await this.reservations.list(ctx, { customerId: c.id, page: 1, pageSize: 5 }) : null;
    const receiptPage = canPay ? await this.receipts.list(ctx, { customerId: c.id, page: 1, pageSize: 5 }) : null;
    const advanceBalance = canPay ? await this.receipts.customerAdvanceBalance(c.id) : null;
    const interactionPage = await this.interactionPage(c.id, { page: 1, pageSize: 5 });

    return {
      customer: {
        ...presentCustomer(c),
        branchName: names?.branch_name ?? null,
        assignedUserName: names?.assigned_user_name ?? null,
        createdByName: names?.created_by_name ?? null,
      },
      counts: {
        leads: canLeads ? Number(cnt?.leads ?? 0) : null,
        openLeads: canLeads ? Number(cnt?.open_leads ?? 0) : null,
        reservations: canRes ? Number(cnt?.reservations ?? 0) : null,
        activeReservations: canRes ? Number(cnt?.active_reservations ?? 0) : null,
        receipts: receiptPage ? receiptPage.total : null,
        appointments: canAppts ? Number(cnt?.appointments ?? 0) : null,
        upcomingAppointments: canAppts ? Number(cnt?.upcoming_appointments ?? 0) : null,
        wishes: Number(cnt?.wishes ?? 0),
        activeWishes: Number(cnt?.active_wishes ?? 0),
        interactions: Number(cnt?.interactions ?? 0),
      },
      lastInteractionAt: cnt?.last_interaction_at ?? null,
      advanceBalance,
      leads: recentLeads,
      reservations: reservationPage?.items ?? null,
      receipts: receiptPage?.items ?? null,
      appointments: recentAppointments,
      wishes: recentWishes,
      interactions: interactionPage.items,
    };
  }

  /** Full national ID (customers.view_sensitive). Every read is recorded in the audit log. */
  async sensitive(ctx: TenantContext, id: string) {
    assertPermission(ctx, 'customers.view_sensitive');
    const c = await this.assertVisible(ctx, id);
    const nationalId = c.nationalIdEnc ? decryptSecret(c.nationalIdEnc) : null;
    await this.audit.record({
      action: 'customer.sensitive_viewed',
      entityType: 'customer',
      entityId: c.id,
      summary: `National ID of ${c.fullName} viewed`,
      metadata: { fields: ['nationalId'] },
    });
    return { id: c.id, nationalId, nationalIdMasked: maskNationalId(c.nationalIdLast4) };
  }

  // ── Mutations ───────────────────────────────────────────────────────────────────────────

  async create(ctx: TenantContext, input: CustomerCreateInput) {
    const contact = this.contactValues(ctx, input);
    this.assertDateOfBirth(ctx, input.dateOfBirth);
    // A user limited to exactly one branch creates customers in that branch by default.
    const branchId = input.branchId ?? (!ctx.allBranches && ctx.branchIds.length === 1 ? ctx.branchIds[0]! : null);
    if (branchId) await this.assertBranch(ctx, branchId);
    // The creator owns the customer unless told otherwise; assigning to someone else is a manager action.
    // Customers created by the system (e.g. online showroom inquiries) start unassigned.
    const assignedUserId = input.assignedUserId === undefined ? (ctx.userId === SYSTEM_USER_ID ? null : ctx.userId) : input.assignedUserId;
    if (assignedUserId && assignedUserId !== ctx.userId) this.assertCanAssign(ctx);
    if (assignedUserId) await this.assertAssignee(ctx, assignedUserId, branchId);

    const phones = [...new Set([contact.phone, contact.phoneAlt, contact.whatsapp].filter((p): p is string => !!p))];
    await this.lockIdentities(ctx, [...phones.map((p) => `phone:${p}`), ...(contact.nationalIdHash ? [`nid:${contact.nationalIdHash}`] : [])]);
    const candidates = await this.matches(ctx, {
      phones,
      email: null,
      nationalIdHash: contact.nationalIdHash ?? null,
      commercialRegistration: null,
      taxNumber: null,
    });
    const forcedOver = this.refuseDuplicates(ctx, candidates, input.force);

    const { force: _force, nationalId: _nid, ...fields } = input;
    const [row] = await this.dbs.db
      .insert(customers)
      .values({ ...fields, ...contact, branchId, assignedUserId, tenantId: ctx.tenant.id, createdBy: ctx.userId })
      .returning();
    const c = row!;
    await this.audit.record({
      action: 'customer.created',
      entityType: 'customer',
      entityId: c.id,
      summary: forcedOver.length ? `${c.fullName} (created despite a duplicate phone)` : c.fullName,
      after: c,
      metadata: forcedOver.length ? { forcedDuplicateOf: forcedOver } : undefined,
    });
    await this.notifyAssignee(ctx, c);
    return presentCustomer(c);
  }

  async update(ctx: TenantContext, id: string, input: CustomerPatchInput) {
    const before = await this.assertVisible(ctx, id, true);
    if (before.version !== input.version) {
      throw conflict('version_conflict', 'This customer was changed by someone else. Reload and try again.', { currentVersion: before.version });
    }
    const contact = this.contactValues(ctx, input);
    this.assertDateOfBirth(ctx, input.dateOfBirth);

    const branchId = input.branchId !== undefined ? input.branchId : before.branchId;
    if (input.branchId && input.branchId !== before.branchId) await this.assertBranch(ctx, input.branchId);
    const assignChanged = input.assignedUserId !== undefined && input.assignedUserId !== before.assignedUserId;
    if (assignChanged) this.assertCanAssign(ctx);
    const assignedUserId = input.assignedUserId !== undefined ? input.assignedUserId : before.assignedUserId;
    if (assignedUserId && (assignChanged || branchId !== before.branchId)) await this.assertAssignee(ctx, assignedUserId, branchId);

    // Only identifiers that change are checked, so a legacy duplicate does not block unrelated edits.
    const oldPhones = new Set([before.phone, before.phoneAlt, before.whatsapp].filter(Boolean));
    const newPhones = [...new Set(PHONE_FIELDS.map((f) => contact[f]).filter((p): p is string => !!p && !oldPhones.has(p)))];
    const newNidHash = contact.nationalIdHash && contact.nationalIdHash !== before.nationalIdHash ? contact.nationalIdHash : null;
    if (newPhones.length || newNidHash) {
      await this.lockIdentities(ctx, [...newPhones.map((p) => `phone:${p}`), ...(newNidHash ? [`nid:${newNidHash}`] : [])]);
      const candidates = await this.matches(ctx, { phones: newPhones, email: null, nationalIdHash: newNidHash, commercialRegistration: null, taxNumber: null, excludeId: id });
      this.refuseDuplicates(ctx, candidates, input.force);
    }
    if (input.isActive === false && before.isActive) await this.assertCanDeactivate(id);

    const { version: _v, force: _f, nationalId: _nid, ...fields } = input;
    const [after] = await this.dbs.db
      .update(customers)
      .set({ ...fields, ...contact, version: before.version + 1, updatedAt: new Date() })
      .where(and(eq(customers.id, id), eq(customers.version, before.version)))
      .returning();
    if (!after) throw conflict('version_conflict', 'This customer was changed by someone else. Reload and try again.');
    const action =
      input.isActive === false && before.isActive ? 'customer.deactivated' : input.isActive === true && !before.isActive ? 'customer.reactivated' : 'customer.updated';
    await this.audit.record({ action, entityType: 'customer', entityId: id, summary: after.fullName, ...diff(before, after) });
    if (assignChanged) await this.notifyAssignee(ctx, after);
    return presentCustomer(after);
  }

  /** Assign, reassign or unassign (null) the responsible salesperson. */
  async assign(ctx: TenantContext, id: string, input: CustomerAssignInput) {
    this.assertCanAssign(ctx);
    const before = await this.assertVisible(ctx, id, true);
    if (input.version !== undefined && before.version !== input.version) {
      throw conflict('version_conflict', 'This customer was changed by someone else. Reload and try again.', { currentVersion: before.version });
    }
    if (input.assignedUserId === before.assignedUserId) return presentCustomer(before);
    if (input.assignedUserId) await this.assertAssignee(ctx, input.assignedUserId, before.branchId);
    const [after] = await this.dbs.db
      .update(customers)
      .set({ assignedUserId: input.assignedUserId, version: before.version + 1, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    await this.audit.record({
      action: input.assignedUserId ? 'customer.assigned' : 'customer.unassigned',
      entityType: 'customer',
      entityId: id,
      summary: after!.fullName,
      before: { assignedUserId: before.assignedUserId },
      after: { assignedUserId: after!.assignedUserId },
    });
    await this.notifyAssignee(ctx, after!);
    return presentCustomer(after!);
  }

  /** A customer holding an active reservation (vehicle + deposit) cannot be deactivated. */
  private async assertCanDeactivate(id: string) {
    const [r] = await this.dbs.query<{ n: number }>(`SELECT count(*)::int AS n FROM reservations WHERE customer_id = $1 AND status = 'active'`, [id]);
    if ((r?.n ?? 0) > 0) {
      throw conflict('customer_has_active_reservation', 'This customer has an active reservation; cancel or convert it first');
    }
  }

  /** Soft delete: customers are never hard-deleted (DELETE is revoked at the database). */
  async deactivate(ctx: TenantContext, id: string, input: { reason: string; version: number }) {
    const before = await this.assertVisible(ctx, id, true);
    if (before.version !== input.version) {
      throw conflict('version_conflict', 'This customer was changed by someone else. Reload and try again.', { currentVersion: before.version });
    }
    if (!before.isActive) throw conflict('customer_inactive', 'This customer is already inactive');
    await this.assertCanDeactivate(id);
    const [after] = await this.dbs.db
      .update(customers)
      .set({ isActive: false, version: before.version + 1, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    await this.audit.record({
      action: 'customer.deactivated',
      entityType: 'customer',
      entityId: id,
      summary: `${after!.fullName}: ${input.reason}`,
      before: { isActive: true },
      after: { isActive: false, reason: input.reason },
    });
    return presentCustomer(after!);
  }

  async reactivate(ctx: TenantContext, id: string, input: { version: number }) {
    const before = await this.assertVisible(ctx, id, true);
    if (before.version !== input.version) {
      throw conflict('version_conflict', 'This customer was changed by someone else. Reload and try again.', { currentVersion: before.version });
    }
    if (before.isActive) throw conflict('customer_active', 'This customer is already active');
    const [after] = await this.dbs.db
      .update(customers)
      .set({ isActive: true, version: before.version + 1, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    await this.audit.record({
      action: 'customer.reactivated',
      entityType: 'customer',
      entityId: id,
      summary: after!.fullName,
      before: { isActive: false },
      after: { isActive: true },
    });
    return presentCustomer(after!);
  }

  // ── Interactions ────────────────────────────────────────────────────────────────────────

  private async interactionPage(customerId: string, q: { page: number; pageSize: number; type?: string; leadId?: string }) {
    const where = and(
      eq(customerInteractions.customerId, customerId),
      q.type ? eq(customerInteractions.type, q.type) : undefined,
      q.leadId ? eq(customerInteractions.leadId, q.leadId) : undefined,
    );
    const items = await this.dbs.db
      .select({
        id: customerInteractions.id,
        customerId: customerInteractions.customerId,
        leadId: customerInteractions.leadId,
        leadNumber: leads.number,
        vehicleId: customerInteractions.vehicleId,
        vehicleStockNumber: vehicles.stockNumber,
        type: customerInteractions.type,
        direction: customerInteractions.direction,
        summary: customerInteractions.summary,
        outcome: customerInteractions.outcome,
        occurredAt: customerInteractions.occurredAt,
        nextFollowUpAt: customerInteractions.nextFollowUpAt,
        userId: customerInteractions.userId,
        userName: users.fullName,
        createdAt: customerInteractions.createdAt,
      })
      .from(customerInteractions)
      .leftJoin(leads, eq(leads.id, customerInteractions.leadId))
      .leftJoin(vehicles, eq(vehicles.id, customerInteractions.vehicleId))
      .leftJoin(users, eq(users.id, customerInteractions.userId))
      .where(where)
      .orderBy(desc(customerInteractions.occurredAt), desc(customerInteractions.createdAt), desc(customerInteractions.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [c] = await this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(customerInteractions).where(where);
    return { items, total: c?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  /** Timeline of a customer, newest first. */
  async interactions(ctx: TenantContext, customerId: string, q: InteractionListQuery) {
    await this.assertVisible(ctx, customerId);
    return this.interactionPage(customerId, q);
  }

  /**
   * Logs a call/visit/message… on a visible, active customer. With a lead, the lead's
   * last_activity_at moves forward and (for open leads) next_follow_up_at takes the value given.
   */
  async logInteraction(ctx: TenantContext, input: InteractionCreateInput) {
    if (!hasPermission(ctx, 'customers.manage') && !hasPermission(ctx, 'leads.manage')) {
      throw forbidden('You do not have permission to log customer interactions', { permission: ['customers.manage', 'leads.manage'] });
    }
    const c = await this.assertVisible(ctx, input.customerId);
    if (!c.isActive) throw unprocessable('customer_inactive', 'This customer is inactive');
    const now = Date.now();
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date(now);
    if (occurredAt.getTime() > now + 5 * 60_000) throw unprocessable('occurred_in_future', 'An interaction cannot be logged in the future', { field: 'occurredAt' });
    const nextFollowUpAt = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null;
    if (nextFollowUpAt && nextFollowUpAt.getTime() <= occurredAt.getTime()) {
      throw unprocessable('invalid_follow_up', 'The next follow-up must be after the interaction', { field: 'nextFollowUpAt' });
    }
    const db = this.dbs.db;

    let lead: { id: string; customerId: string; branchId: string; status: string; lastActivityAt: Date | null; nextFollowUpAt: Date | null; version: number } | undefined;
    if (input.leadId) {
      [lead] = await db
        .select({
          id: leads.id,
          customerId: leads.customerId,
          branchId: leads.branchId,
          status: leads.status,
          lastActivityAt: leads.lastActivityAt,
          nextFollowUpAt: leads.nextFollowUpAt,
          version: leads.version,
        })
        .from(leads)
        .where(eq(leads.id, input.leadId))
        .for('update');
      if (!lead) throw notFound('Lead');
      if (lead.customerId !== c.id) throw unprocessable('lead_customer_mismatch', 'This lead belongs to a different customer', { field: 'leadId' });
      assertBranchAccess(ctx, lead.branchId);
    }
    if (input.vehicleId) {
      const [v] = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.id, input.vehicleId));
      if (!v) throw notFound('Vehicle');
    }

    const [row] = await db
      .insert(customerInteractions)
      .values({
        tenantId: ctx.tenant.id,
        customerId: c.id,
        leadId: lead?.id ?? null,
        vehicleId: input.vehicleId ?? null,
        type: input.type,
        direction: input.direction ?? null,
        summary: input.summary,
        outcome: input.outcome ?? null,
        occurredAt,
        userId: ctx.userId,
        nextFollowUpAt,
      })
      .returning();

    let leadUpdate: Record<string, unknown> | null = null;
    if (lead) {
      const set: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
      if (!lead.lastActivityAt || lead.lastActivityAt.getTime() < occurredAt.getTime()) set.lastActivityAt = occurredAt;
      // nextFollowUpAt is a user-editable lead field: changing it bumps the lead version.
      if (input.nextFollowUpAt !== undefined && lead.status === 'open' && (lead.nextFollowUpAt?.getTime() ?? null) !== (nextFollowUpAt?.getTime() ?? null)) {
        set.nextFollowUpAt = nextFollowUpAt;
        set.version = lead.version + 1;
      }
      await db.update(leads).set(set).where(eq(leads.id, lead.id));
      leadUpdate = { leadId: lead.id, lastActivityAt: set.lastActivityAt ?? lead.lastActivityAt, nextFollowUpAt: 'nextFollowUpAt' in set ? set.nextFollowUpAt : lead.nextFollowUpAt };
    }
    await this.audit.record({
      action: 'customer.interaction_logged',
      entityType: 'customer_interaction',
      entityId: row!.id,
      summary: `${input.type} with ${c.fullName}`,
      after: row,
      metadata: { customerId: c.id, ...(leadUpdate ? { lead: leadUpdate } : {}) },
    });
    return row!;
  }

  /**
   * Records an interaction produced by another workflow (a completed appointment or test drive)
   * on the customer's timeline. The caller has already authorised the underlying action, so no
   * visibility check is repeated here; inactive customers are skipped (history stays intact).
   */
  async appendInteraction(
    ctx: TenantContext,
    input: { customerId: string; leadId: string | null; vehicleId: string | null; type: InteractionCreateInput['type']; summary: string; outcome?: string | null },
  ): Promise<void> {
    const [c] = await this.dbs.db.select({ id: customers.id, isActive: customers.isActive }).from(customers).where(eq(customers.id, input.customerId));
    if (!c?.isActive) return;
    const occurredAt = new Date();
    const [row] = await this.dbs.db
      .insert(customerInteractions)
      .values({
        tenantId: ctx.tenant.id,
        customerId: c.id,
        leadId: input.leadId,
        vehicleId: input.vehicleId,
        type: input.type,
        direction: null,
        summary: input.summary.slice(0, 1000),
        outcome: input.outcome ?? null,
        occurredAt,
        userId: ctx.userId,
        nextFollowUpAt: null,
      })
      .returning({ id: customerInteractions.id });
    if (input.leadId) {
      await this.dbs.db
        .update(leads)
        .set({ lastActivityAt: occurredAt, updatedAt: occurredAt })
        .where(and(eq(leads.id, input.leadId), or(isNull(leads.lastActivityAt), lt(leads.lastActivityAt, occurredAt))));
    }
    await this.audit.record({
      action: 'customer.interaction_logged',
      entityType: 'customer_interaction',
      entityId: row!.id,
      summary: input.summary,
      metadata: { customerId: c.id, leadId: input.leadId, automatic: true },
    });
  }
}
