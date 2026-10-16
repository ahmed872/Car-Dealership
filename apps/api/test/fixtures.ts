import { Client, idem } from './helpers';

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

/** Creates (and by default approves) a vehicle purchase. */
export async function createAcquisition(
  c: Client,
  branchId: string,
  supplierId: string,
  opts: { price?: string; currency?: string; exchangeRate?: string; approve?: boolean; submit?: boolean; vehicle?: Record<string, unknown> } = {},
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
    const ap = await c.post(`/acquisitions/${acq.id}/approve`, {}, idem());
    if (ap.status !== 200) throw new Error(`approve acquisition failed ${ap.status} ${JSON.stringify(ap.body)}`);
    acq.status = 'approved';
  }
  return acq;
}
