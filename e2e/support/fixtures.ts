import { randomInt } from 'node:crypto';
import { computeVinCheckDigit, type Permission } from '@autohub/shared';
import { ApiClient, expectStatus, idem, uniq } from './api';
import { PASSWORD } from './env';

/**
 * Preconditions created through the API (fast, no UI): the same payloads as the API integration
 * fixtures (apps/api/test/fixtures.ts), so a failure here points at the API, not at the browser.
 * Every record gets a unique name so specs never depend on each other's data.
 */

export async function mainBranchId(c: ApiClient): Promise<string> {
  const branches = await c.json<Array<{ id: string; isActive: boolean }>>('/branches');
  const b = branches.find((x) => x.isActive);
  if (!b) throw new Error('no active branch');
  return b.id;
}

export async function catalogIds(c: ApiClient, make = 'Toyota', model = 'Camry') {
  const makes = await c.json<Array<{ id: string; nameEn: string; nameAr: string }>>('/catalog/makes');
  const mk = makes.find((m) => m.nameEn === make);
  if (!mk) throw new Error(`make ${make} not found`);
  const models = await c.json<Array<{ id: string; nameEn: string; nameAr: string }>>('/catalog/models', { makeId: mk.id });
  const md = models.find((m) => m.nameEn === model);
  if (!md) throw new Error(`model ${model} not found`);
  return { makeId: mk.id, modelId: md.id, make: mk, model: md };
}

const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
/** A unique 17-character VIN with a valid ISO 3779 check digit (so the form shows no warning). */
export function newVin(): string {
  const body = Array.from({ length: 17 }, () => VIN_CHARS[randomInt(VIN_CHARS.length)]!);
  body[9] = 'N'; // model-year code for 2022
  body[8] = '0';
  body[8] = computeVinCheckDigit(body.join('')) ?? '0';
  return body.join('');
}

export async function createVehicle(c: ApiClient, branchId: string, overrides: Record<string, unknown> = {}) {
  const { makeId, modelId } = await catalogIds(c);
  return expectStatus<{ id: string; stockNumber: string; status: string; version: number }>(
    await c.post('/vehicles', {
      branchId,
      makeId,
      modelId,
      modelYear: 2022,
      odometerValue: 45000,
      odometerUnit: 'km',
      specRegion: 'gcc',
      exteriorColor: 'White',
      vin: newVin(),
      ...overrides,
    }),
    201,
    'create vehicle',
  );
}

/** Starts and completes a passing inspection. */
export async function passInspection(c: ApiClient, vehicleId: string) {
  const start = await expectStatus<{ id: string }>(
    await c.post(`/vehicles/${vehicleId}/inspections`, { type: 'acquisition' }),
    201,
    'start inspection',
  );
  const insp = await c.json<{ items: Array<{ sectionKey: string; itemKey: string }> }>(`/inspections/${start.id}`);
  const items = insp.items.map((i) => ({ sectionKey: i.sectionKey, itemKey: i.itemKey, result: 'ok' }));
  await expectStatus(
    await c.put(`/inspections/${start.id}`, { items, overallResult: 'pass', odometerValue: 45100, odometerUnit: 'km' }),
    200,
    'save inspection',
  );
  await expectStatus(await c.post(`/inspections/${start.id}/complete`), 200, 'complete inspection');
}

/** Brings a vehicle to "available" (inspection + price + status). */
export async function makeAvailable(c: ApiClient, vehicleId: string, asking = '120000.00', min = '110000.00') {
  await passInspection(c, vehicleId);
  await expectStatus(await c.put(`/vehicles/${vehicleId}/pricing`, { askingPrice: asking, minPrice: min }), 200, 'pricing');
  await expectStatus(await c.post(`/vehicles/${vehicleId}/status`, { to: 'available' }), 200, 'make available');
}

/** An available vehicle with a unique VIN; returns its id, stock number and VIN. */
export async function availableVehicle(c: ApiClient, asking = '120000.00') {
  const branchId = await mainBranchId(c);
  const vin = newVin();
  const v = await createVehicle(c, branchId, { vin });
  await makeAvailable(c, v.id, asking, '110000.00');
  return { ...v, vin, askingPrice: asking };
}

export async function createSupplier(c: ApiClient, overrides: Record<string, unknown> = {}) {
  return expectStatus<{ id: string; name: string }>(
    await c.post('/suppliers', { type: 'company', name: uniq('Supplier '), ...overrides }),
    201,
    'create supplier',
  );
}

export interface CashAccount {
  id: string;
  name: string;
  balance: string;
  balanceBase: string;
  currency: string;
  type: 'cashbox' | 'bank';
}

export async function createCashAccount(
  c: ApiClient,
  overrides: { type?: 'cashbox' | 'bank'; currency?: string; openingBalance?: string; name?: string; openingDate?: string } = {},
) {
  // Fund accounts at the start of the year (cash boxes may not go negative on any date).
  const opening = overrides.openingBalance && !('openingDate' in overrides) ? { openingDate: '2026-01-01' } : {};
  return expectStatus<CashAccount>(
    await c.post('/cash-accounts', { type: 'cashbox', name: uniq('Cash '), currency: 'SAR', ...opening, ...overrides }, idem()),
    201,
    'create cash account',
  );
}

export const cashAccount = (c: ApiClient, id: string) => c.json<CashAccount>(`/cash-accounts/${id}`);

/** Creates a customer (random Saudi mobile number). */
export async function createCustomer(c: ApiClient, overrides: Record<string, unknown> = {}) {
  const phone = `+9665${String(randomInt(1e8)).padStart(8, '0')}`;
  return expectStatus<{ id: string; fullName: string; phone: string }>(
    await c.post('/customers', { fullName: uniq('Customer '), phone, ...overrides }),
    201,
    'create customer',
  );
}

export interface Member {
  email: string;
  password: string;
  userId: string;
  fullName: string;
}

/** Adds a member holding one of the system roles (owner, branch_manager, sales_rep, …). */
export async function addMember(owner: ApiClient, roleKey: string, fullName = `${roleKey} ${uniq('')}`): Promise<Member> {
  const roles = await owner.json<Array<{ id: string; key: string | null }>>('/roles');
  const role = roles.find((r) => r.key === roleKey);
  if (!role) throw new Error(`role ${roleKey} not found`);
  return createUser(owner, role.id, fullName);
}

/** Adds a member holding a custom role with exactly these permissions. */
export async function addMemberWithPermissions(owner: ApiClient, permissions: Permission[], fullName = uniq('Custom ')) {
  const role = await expectStatus<{ id: string }>(
    await owner.post('/roles', { name: uniq('Role '), permissions, maxDiscountPct: '0' }),
    201,
    'create role',
  );
  return createUser(owner, role.id, fullName);
}

async function createUser(owner: ApiClient, roleId: string, fullName: string): Promise<Member> {
  const email = `${uniq('user')}@e2e.test`;
  const res = await expectStatus<{ userId: string }>(
    await owner.post('/users', { email, fullName, password: PASSWORD, roleId, allBranches: true, branchIds: [] }),
    201,
    'add member',
  );
  return { email, password: PASSWORD, userId: res.userId, fullName };
}
