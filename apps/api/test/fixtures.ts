import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { expect } from 'vitest';
import { Client, getApp, idem, PASSWORD, TestTenant, uniq } from './helpers';

export const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

export async function catalogIds(c: Client, make = 'Toyota', model = 'Camry') {
  const makes = await c.get('/catalog/makes');
  const mk = makes.body.find((m: { nameEn: string }) => m.nameEn === make);
  const models = await c.get(`/catalog/models?makeId=${mk.id}`);
  const md = models.body.find((m: { nameEn: string }) => m.nameEn === model);
  return { makeId: mk.id as string, modelId: md.id as string };
}

export async function createVehicle(c: Client, branchId: string, overrides: Record<string, unknown> = {}) {
  const ids = await catalogIds(c);
  const res = await c.post('/vehicles', {
    branchId,
    ...ids,
    modelYear: 2022,
    odometerValue: 45000,
    odometerUnit: 'km',
    specRegion: 'gcc',
    exteriorColor: 'White',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`create vehicle failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; stockNumber: string; status: string; version: number };
}

/** Starts and completes a passing inspection on a vehicle. */
export async function passInspection(c: Client, vehicleId: string) {
  const start = await c.post(`/vehicles/${vehicleId}/inspections`, { type: 'acquisition' });
  if (start.status !== 201) throw new Error(`start inspection failed ${JSON.stringify(start.body)}`);
  const insp = (await c.get(`/inspections/${start.body.id}`)).body;
  const items = insp.items.map((i: { sectionKey: string; itemKey: string }) => ({ sectionKey: i.sectionKey, itemKey: i.itemKey, result: 'ok' }));
  const save = await c.put(`/inspections/${start.body.id}`, { items, overallResult: 'pass', odometerValue: 45100, odometerUnit: 'km' });
  if (save.status !== 200) throw new Error(`save inspection failed ${JSON.stringify(save.body)}`);
  const done = await c.post(`/inspections/${start.body.id}/complete`);
  if (done.status !== 200) throw new Error(`complete inspection failed ${JSON.stringify(done.body)}`);
  return start.body.id as string;
}

/** Brings a vehicle to "available" (inspection + price). */
export async function makeAvailable(c: Client, vehicleId: string, asking = '120000.00', min = '110000.00') {
  await passInspection(c, vehicleId);
  const p = await c.put(`/vehicles/${vehicleId}/pricing`, { askingPrice: asking, minPrice: min });
  if (p.status !== 200) throw new Error(`pricing failed ${JSON.stringify(p.body)}`);
  const s = await c.post(`/vehicles/${vehicleId}/status`, { to: 'available' });
  if (s.status !== 200) throw new Error(`available failed ${JSON.stringify(s.body)}`);
}

// ── Purchasing / finance fixtures ───────────────────────────────────────────────────────────

export async function createSupplier(c: Client, overrides: Record<string, unknown> = {}) {
  const res = await c.post('/suppliers', { type: 'company', name: `Supplier ${Math.random().toString(36).slice(2, 8)}`, ...overrides });
  if (res.status !== 201) throw new Error(`create supplier failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string };
}

export async function createCashAccount(
  c: Client,
  overrides: { type?: 'cashbox' | 'bank'; currency?: string; openingBalance?: string; exchangeRate?: string; branchId?: string | null; name?: string } = {},
) {
  const res = await c.post(
    '/cash-accounts',
    { type: 'cashbox', name: `Cash ${Math.random().toString(36).slice(2, 8)}`, currency: 'SAR', ...overrides },
    idem(),
  );
  if (res.status !== 201) throw new Error(`create cash account failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; balance: string; balanceBase: string; currency: string };
}

export async function costCategory(c: Client, code: string) {
  const res = await c.get('/cost-categories');
  const cat = (res.body as Array<{ id: string; code: string }>).find((x) => x.code === code);
  if (!cat) throw new Error(`category ${code} not found`);
  return cat.id;
}

const approvers = new WeakMap<Client, Promise<Client>>();

/**
 * A second company owner for `c`'s tenant. Maker-checker (B-016) forbids approving your own
 * request, so flows that create AND approve need a different approver. Memoised per client.
 */
export function secondApprover(c: Client): Promise<Client> {
  let p = approvers.get(c);
  if (!p) {
    p = (async () => {
      const roles = await c.get('/roles');
      const owner = (roles.body as Array<{ id: string; key: string | null }>).find((r) => r.key === 'owner');
      if (!owner) throw new Error('owner role not found');
      const email = `${uniq('approver')}@autohub.test`;
      const res = await c.post('/users', { email, fullName: 'Second approver', password: PASSWORD, roleId: owner.id, allBranches: true, branchIds: [] });
      if (res.status !== 201) throw new Error(`create approver failed ${res.status} ${JSON.stringify(res.body)}`);
      return Client.login(await getApp(), email);
    })();
    approvers.set(c, p);
  }
  return p;
}

/** Creates (and by default approves, via a second approver) a vehicle purchase. */
export async function createAcquisition(
  c: Client,
  branchId: string,
  supplierId: string,
  opts: { price?: string; currency?: string; exchangeRate?: string; approve?: boolean; submit?: boolean; vehicle?: Record<string, unknown>; approver?: Client } = {},
) {
  const ids = await catalogIds(c);
  const res = await c.post(
    '/acquisitions',
    {
      branchId,
      supplierId,
      sourceType: 'company',
      purchaseDate: '2026-01-15',
      purchasePrice: opts.price ?? '80000.00',
      currency: opts.currency ?? 'SAR',
      ...(opts.exchangeRate ? { exchangeRate: opts.exchangeRate } : {}),
      submit: opts.submit ?? true,
      vehicle: { ...ids, modelYear: 2022, odometerValue: 40000, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'White', ...(opts.vehicle ?? {}) },
    },
    idem(),
  );
  if (res.status !== 201) throw new Error(`create acquisition failed ${res.status} ${JSON.stringify(res.body)}`);
  const acq = res.body as { id: string; number: string; status: string; vehicleId: string; vehicle: { id: string; stockNumber: string } };
  if (opts.approve ?? true) {
    const approver = opts.approver ?? (await secondApprover(c));
    const ap = await approver.post(`/acquisitions/${acq.id}/approve`, {}, idem());
    if (ap.status !== 200) throw new Error(`approve acquisition failed ${ap.status} ${JSON.stringify(ap.body)}`);
    acq.status = 'approved';
  }
  return acq;
}

// ── Ledger integrity & custom-role helpers ──────────────────────────────────────────────────

type GlDim = { col: 'vehicle_id' | 'supplier_id' | 'cash_account_id' | 'customer_id'; id: string };

/** GL balance (debit − credit) of one account for a tenant, optionally filtered by a dimension. */
export async function glBalance(pool: Pool, tenantId: string, account: string, dim?: GlDim): Promise<string> {
  const r = await pool.query(
    `SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines
      WHERE tenant_id = $1 AND account_code = $2 ${dim ? `AND ${dim.col} = $3` : ''}`,
    dim ? [tenantId, account, dim.id] : [tenantId, account],
  );
  return r.rows[0].b as string;
}

/** Cash-book balance of one account (own currency and base currency). */
export async function cashBookBalance(pool: Pool, cashAccountId: string): Promise<{ amount: string; amountBase: string }> {
  const r = await pool.query(
    `SELECT coalesce(sum(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0)::numeric(18,2)::text AS amount,
            coalesce(sum(CASE WHEN direction = 'in' THEN amount_base ELSE -amount_base END), 0)::numeric(18,2)::text AS "amountBase"
       FROM cash_transactions WHERE cash_account_id = $1`,
    [cashAccountId],
  );
  return r.rows[0] as { amount: string; amountBase: string };
}

/**
 * Whole-tenant books check (owner connection, bypasses RLS):
 *  - every journal entry balances and the trial balance balances;
 *  - the cash book equals GL 1100 for every cash account (no 1100 line without a cash account);
 *  - every cash-book row points at a journal entry;
 *  - AP sub-ledger: per supplier, −GL 2000 = approved acquisitions + posted payable costs/expenses
 *    − allocations of posted supplier payments;
 *  - inventory sub-ledger: per vehicle, GL 1300 = posted pre-sale costs (0 once removed), never negative.
 */
export async function assertLedgerIntegrity(pool: Pool, tenantId: string): Promise<void> {
  const tb = await pool.query(
    `SELECT coalesce(sum(debit), 0)::numeric(18,2)::text AS dr, coalesce(sum(credit), 0)::numeric(18,2)::text AS cr FROM journal_lines WHERE tenant_id = $1`,
    [tenantId],
  );
  expect(tb.rows[0].dr, 'trial balance').toBe(tb.rows[0].cr);
  const unbalanced = await pool.query(
    `SELECT entry_id FROM journal_lines WHERE tenant_id = $1 GROUP BY entry_id HAVING sum(debit) <> sum(credit)`,
    [tenantId],
  );
  expect(unbalanced.rows, 'unbalanced journal entries').toEqual([]);

  const cash = await pool.query(
    `WITH book AS (
        SELECT cash_account_id AS id, sum(CASE WHEN direction = 'in' THEN amount_base ELSE -amount_base END) AS b
          FROM cash_transactions WHERE tenant_id = $1 GROUP BY 1),
      gl AS (
        SELECT cash_account_id AS id, sum(debit - credit) AS b
          FROM journal_lines WHERE tenant_id = $1 AND account_code = '1100' GROUP BY 1)
     SELECT coalesce(book.id, gl.id) AS id, coalesce(book.b, 0)::numeric(18,2)::text AS book, coalesce(gl.b, 0)::numeric(18,2)::text AS gl
       FROM book FULL JOIN gl ON gl.id = book.id
      WHERE coalesce(book.b, 0) <> coalesce(gl.b, 0)`,
    [tenantId],
  );
  expect(cash.rows, 'cash book vs GL 1100 per account').toEqual([]);
  const untagged = await pool.query(`SELECT id FROM journal_lines WHERE tenant_id = $1 AND account_code = '1100' AND cash_account_id IS NULL`, [tenantId]);
  expect(untagged.rows, 'GL 1100 lines without a cash account').toEqual([]);
  const orphan = await pool.query(
    `SELECT ct.id FROM cash_transactions ct LEFT JOIN journal_entries je ON je.id = ct.journal_entry_id
      WHERE ct.tenant_id = $1 AND je.id IS NULL`,
    [tenantId],
  );
  expect(orphan.rows, 'cash rows without a journal entry').toEqual([]);

  const ap = await pool.query(
    `WITH docs AS (
        SELECT supplier_id AS s, purchase_price_base AS amt FROM acquisitions WHERE tenant_id = $1 AND status = 'approved'
        UNION ALL
        SELECT supplier_id, amount_base FROM vehicle_costs
         WHERE tenant_id = $1 AND status = 'posted' AND source_type NOT IN ('acquisition', 'trade_in')
        UNION ALL
        SELECT supplier_id, amount_base FROM expenses WHERE tenant_id = $1 AND status = 'posted'
        UNION ALL
        SELECT sp.supplier_id, -spa.amount_base FROM supplier_payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
         WHERE sp.tenant_id = $1 AND sp.status = 'posted'),
      sub AS (SELECT s, sum(amt) AS b FROM docs GROUP BY s),
      gl AS (SELECT supplier_id AS s, -sum(debit - credit) AS b FROM journal_lines WHERE tenant_id = $1 AND account_code = '2000' GROUP BY 1)
     SELECT coalesce(sub.s, gl.s) AS supplier, coalesce(sub.b, 0)::numeric(18,2)::text AS subledger, coalesce(gl.b, 0)::numeric(18,2)::text AS gl
       FROM sub FULL JOIN gl ON coalesce(gl.s, '00000000-0000-0000-0000-000000000000') = coalesce(sub.s, '00000000-0000-0000-0000-000000000000')
      WHERE coalesce(sub.b, 0) <> coalesce(gl.b, 0)`,
    [tenantId],
  );
  expect(ap.rows, 'AP sub-ledger vs GL 2000 per supplier').toEqual([]);

  const inv = await pool.query(
    `WITH costs AS (
        SELECT vehicle_id AS v, sum(amount_base) AS b FROM vehicle_costs
         WHERE tenant_id = $1 AND status = 'posted' AND NOT post_sale GROUP BY 1),
      gl AS (SELECT vehicle_id AS v, sum(debit - credit) AS b FROM journal_lines WHERE tenant_id = $1 AND account_code = '1300' GROUP BY 1)
     SELECT v.id, v.status, coalesce(costs.b, 0)::numeric(18,2)::text AS costs, coalesce(gl.b, 0)::numeric(18,2)::text AS gl
       FROM vehicles v LEFT JOIN costs ON costs.v = v.id LEFT JOIN gl ON gl.v = v.id
      WHERE v.tenant_id = $1
        AND (coalesce(gl.b, 0) < 0
          OR (v.status = 'removed' AND coalesce(gl.b, 0) <> 0)
          OR (v.status <> 'removed' AND v.cost_locked_at IS NULL AND coalesce(gl.b, 0) <> coalesce(costs.b, 0)))`,
    [tenantId],
  );
  expect(inv.rows, 'inventory sub-ledger vs GL 1300 per vehicle').toEqual([]);
}

/** Adds a member holding a custom role with exactly the given permissions. */
export async function addMemberWithPermissions(
  app: INestApplication,
  t: TestTenant,
  permissions: string[],
  opts: { allBranches?: boolean; branchIds?: string[] } = {},
): Promise<{ client: Client; userId: string; roleId: string }> {
  const role = await t.owner.post('/roles', { name: uniq('Role '), permissions, maxDiscountPct: '0' });
  if (role.status !== 201) throw new Error(`create role failed ${role.status} ${JSON.stringify(role.body)}`);
  const email = `${uniq('custom')}@autohub.test`;
  const res = await t.owner.post('/users', {
    email,
    fullName: 'Custom role user',
    password: PASSWORD,
    roleId: role.body.id,
    allBranches: opts.allBranches ?? true,
    branchIds: opts.branchIds ?? [],
  });
  if (res.status !== 201) throw new Error(`add member failed ${res.status} ${JSON.stringify(res.body)}`);
  return { client: await Client.login(app, email), userId: res.body.userId as string, roleId: role.body.id as string };
}

export async function createBranch(c: Client, name = 'Jeddah') {
  const res = await c.post('/branches', { name, code: `B${randomUUID().slice(0, 8).toUpperCase()}` });
  if (res.status !== 201) throw new Error(`create branch failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string };
}
