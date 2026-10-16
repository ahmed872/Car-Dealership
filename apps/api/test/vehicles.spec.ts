import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogIds, createVehicle, JPEG, passInspection, PDF } from './fixtures';
import { addMember, closeApp, createPlatformAdmin, createTenant, getApp, TestTenant } from './helpers';

describe('vehicles & inventory', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    other = await createTenant(app, admin);
  });
  afterAll(closeApp);

  it('creates a vehicle with stock number, history, odometer and audit', async () => {
    const v = await createVehicle(t.owner, t.branchId, { vin: '1HGCM82633A004352', specRegion: 'american' });
    expect(v.stockNumber).toMatch(/^STK-\d{4}-\d{6}$/);
    expect(v.status).toBe('incoming');
    const d = await t.owner.get(`/vehicles/${v.id}`);
    expect(d.status).toBe(200);
    expect(d.body.statusHistory[0]).toMatchObject({ fromStatus: null, toStatus: 'incoming' });
    expect(d.body.odometer[0]).toMatchObject({ value: 45000, unit: 'km' });
    const audit = await t.owner.get(`/audit-logs?entityType=vehicle&entityId=${v.id}`);
    expect(audit.body.items.map((i: { action: string }) => i.action)).toContain('vehicle.created');
  });

  it('applies VIN rules per market spec and blocks duplicate VINs in stock', async () => {
    const bad = await t.owner.post('/vehicles', { branchId: t.branchId, ...(await catalogIds(t.owner)), modelYear: 2020, odometerValue: 1, vin: 'ABC' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_vin');
    // Wrong check digit: rejected for American spec, warning only for GCC spec.
    const us = await t.owner.post('/vehicles', { branchId: t.branchId, ...(await catalogIds(t.owner)), modelYear: 2020, odometerValue: 1, vin: '1HGCM82633A004353', specRegion: 'american' });
    expect(us.status).toBe(422);
    const gcc = await createVehicle(t.owner, t.branchId, { vin: 'JTDKN3DU0A0123456', specRegion: 'gcc' });
    expect((gcc as unknown as { warnings: string[] }).warnings).toContain('check_digit');
    const dup = await t.owner.post('/vehicles', { branchId: t.branchId, ...(await catalogIds(t.owner)), modelYear: 2020, odometerValue: 1, vin: 'JTDKN3DU0A0123456' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('vin_in_stock');
    // Non-standard chassis number for an older/local vehicle.
    const local = await createVehicle(t.owner, t.branchId, { vin: 'ABC12345', vinNonStandard: true, modelYear: 1995 });
    expect(local.id).toBeTruthy();
  });

  it('enforces the lifecycle: system-only states, price and inspection before listing', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    const reserve = await t.owner.post(`/vehicles/${v.id}/status`, { to: 'reserved' });
    expect(reserve.status).toBe(409);
    // Not even a valid transition from "incoming".
    expect(reserve.body.error).toMatchObject({ code: 'invalid_transition', details: { reason: 'not_allowed' } });
    const sold = await t.owner.post(`/vehicles/${v.id}/status`, { to: 'sold' });
    expect(sold.status).toBe(409);
    expect((await t.owner.post(`/vehicles/${v.id}/status`, { to: 'available' })).body.error.code).toBe('price_required');
    await t.owner.put(`/vehicles/${v.id}/pricing`, { askingPrice: '99000.00', minPrice: '95000.00' });
    expect((await t.owner.post(`/vehicles/${v.id}/status`, { to: 'available' })).body.error.code).toBe('inspection_required');
    await passInspection(t.owner, v.id);
    const ok = await t.owner.post(`/vehicles/${v.id}/status`, { to: 'available' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('available');
    // From "available", reserving is a valid transition but only the reservation workflow may do it.
    const manualReserve = await t.owner.post(`/vehicles/${v.id}/status`, { to: 'reserved' });
    expect(manualReserve.body.error).toMatchObject({ code: 'invalid_transition', details: { reason: 'system_only' } });
    const removeNoReason = await t.owner.post(`/vehicles/${v.id}/status`, { to: 'removed' });
    expect(removeNoReason.body.error.code).toBe('reason_required');
  });

  it('inspections: required items, immutability after completion (API and DB)', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    const start = await t.owner.post(`/vehicles/${v.id}/inspections`, { type: 'acquisition' });
    expect(start.status).toBe(201);
    expect((await t.owner.get(`/vehicles/${v.id}`)).body.vehicle.status).toBe('in_inspection');
    const again = await t.owner.post(`/vehicles/${v.id}/inspections`, {});
    expect(again.body.error.code).toBe('inspection_in_progress');
    const insp = (await t.owner.get(`/inspections/${start.body.id}`)).body;
    expect(insp.panels).toHaveLength(13);
    const incomplete = await t.owner.post(`/inspections/${start.body.id}/complete`);
    expect(incomplete.body.error.code).toBe('inspection_incomplete');
    const items = insp.items.map((i: { sectionKey: string; itemKey: string }) => ({
      sectionKey: i.sectionKey,
      itemKey: i.itemKey,
      result: i.itemKey === 'front_pads' ? 'attention' : 'ok',
      severity: i.itemKey === 'front_pads' ? 'medium' : 'none',
      ...(i.itemKey === 'battery_voltage' ? { measuredValue: '12.6', isMeasured: true } : {}),
    }));
    const saved = await t.owner.put(`/inspections/${start.body.id}`, {
      items,
      panels: [{ panelCode: 'hood', condition: 'repainted', paintThicknessMicrons: 240 }],
      overallResult: 'pass_with_notes',
      odometerValue: 45120,
      odometerUnit: 'km',
    });
    expect(saved.status).toBe(200);
    const battery = saved.body.items.find((i: { itemKey: string }) => i.itemKey === 'battery_voltage');
    expect(battery).toMatchObject({ measuredValue: '12.600', isMeasured: true });
    expect((await t.owner.post(`/inspections/${start.body.id}/complete`)).status).toBe(200);
    const after = await t.owner.put(`/inspections/${start.body.id}`, { summary: 'changed' });
    expect(after.body.error.code).toBe('inspection_closed');
    // Even a direct SQL update by the application role is refused.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [t.tenantId]);
      await expect(c.query(`UPDATE inspection_panels SET condition = 'original' WHERE inspection_id = $1`, [start.body.id])).rejects.toThrow(/immutable_record/);
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await pool.end();
    }
    // A new inspection gets the next version and history is preserved.
    const second = await t.owner.post(`/vehicles/${v.id}/inspections`, { type: 'periodic' });
    expect(second.body.versionNo).toBe(2);
    const detail = await t.owner.get(`/vehicles/${v.id}`);
    expect(detail.body.inspections).toHaveLength(2);
    expect(detail.body.odometer[0]).toMatchObject({ value: 45120, source: 'inspection' });
  });

  it('pricing permissions: reps cannot price, floor needs pricing.set_floor, history kept', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    const rep = await addMember(app, t, 'sales_rep');
    expect((await rep.client.put(`/vehicles/${v.id}/pricing`, { askingPrice: '1.00', minPrice: null })).status).toBe(403);
    const inv = await addMember(app, t, 'inventory_manager');
    expect((await inv.client.put(`/vehicles/${v.id}/pricing`, { askingPrice: '150000.00', minPrice: null })).status).toBe(200);
    const floor = await inv.client.put(`/vehicles/${v.id}/pricing`, { askingPrice: '150000.00', minPrice: '140000.00' });
    expect(floor.status).toBe(403);
    expect((await t.owner.put(`/vehicles/${v.id}/pricing`, { askingPrice: '150000.00', minPrice: '140000.00', reason: 'approved' })).status).toBe(200);
    const bad = await t.owner.put(`/vehicles/${v.id}/pricing`, { askingPrice: '100.00', minPrice: '200.00' });
    expect(bad.status).toBe(422);
    const d = await t.owner.get(`/vehicles/${v.id}`);
    expect(d.body.priceHistory.map((p: { field: string }) => p.field).sort()).toEqual(['asking_price', 'min_price']);
    // The rep sees the asking price but not the floor or internal notes.
    const repView = await rep.client.get(`/vehicles/${v.id}`);
    expect(repView.body.vehicle.askingPrice).toBe('150000.00');
    expect(repView.body.vehicle.minPrice).toBeNull();
    expect(repView.body.priceHistory.every((p: { field: string }) => p.field === 'asking_price')).toBe(true);
  });

  it('optimistic locking rejects stale updates', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    const a = await t.owner.patch(`/vehicles/${v.id}`, { version: v.version, exteriorColor: 'Black' });
    expect(a.status).toBe(200);
    const b = await t.owner.patch(`/vehicles/${v.id}`, { version: v.version, exteriorColor: 'Red' });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('version_conflict');
  });

  it('media: real type sniffing, primary photo, authorised download, cross-tenant denial', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    const fake = await t.owner.upload(`/vehicles/${v.id}/media`, { buffer: Buffer.from('<script>alert(1)</script>'), name: 'x.jpg' });
    expect(fake.status).toBe(415);
    const up = await t.owner.upload(`/vehicles/${v.id}/media`, { buffer: JPEG, name: 'front.jpg' }, { caption: 'Front' });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ kind: 'photo', isPrimary: true, isPublic: true });
    const dmg = await t.owner.upload(`/vehicles/${v.id}/media`, { buffer: JPEG, name: 'scratch.jpg' }, { category: 'damage' });
    expect(dmg.body).toMatchObject({ isPrimary: false, isPublic: false });
    const file = await t.owner.get(`/files/${up.body.fileId}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect((await other.owner.get(`/files/${up.body.fileId}`)).status).toBe(404);
    const list = await t.owner.get(`/vehicles?q=${encodeURIComponent(v.stockNumber)}`);
    expect(list.body.items[0].primaryPhotoId).toBe(up.body.fileId);
    expect((await t.owner.delete(`/vehicles/${v.id}/media/${dmg.body.id}`)).status).toBe(200);
  });

  it('documents: sensitive files and numbers hidden without permission', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    const doc = await t.owner.upload(
      `/vehicles/${v.id}/documents`,
      { buffer: PDF, name: 'ownership.pdf' },
      { docType: 'ownership', docNumber: 'OWN-778899', isSensitive: 'true', expiresAt: '2027-01-31' },
    );
    expect(doc.status).toBe(201);
    const rep = await addMember(app, t, 'sales_rep');
    const repView = await rep.client.get(`/vehicles/${v.id}`);
    expect(repView.body.documents[0]).toMatchObject({ restricted: true, docNumber: null, fileId: null });
    expect((await rep.client.get(`/files/${doc.body.fileId}`)).status).toBe(403);
    const ownerView = await t.owner.get(`/vehicles/${v.id}`);
    expect(ownerView.body.documents[0].docNumber).toBe('OWN-778899');
    expect((await t.owner.get(`/files/${doc.body.fileId}`)).status).toBe(200);
  });

  it('transfers block manual changes while in transit; destination branch receives', async () => {
    const b2 = await t.owner.post('/branches', { name: 'Jeddah', code: `J${Date.now() % 10000}` });
    const v = await createVehicle(t.owner, t.branchId);
    const tr = await t.owner.post(`/vehicles/${v.id}/transfers`, { toBranchId: b2.body.id });
    expect(tr.status).toBe(201);
    expect(tr.body.number).toMatch(/^TRF-/);
    expect((await t.owner.post(`/vehicles/${v.id}/transfers`, { toBranchId: b2.body.id })).body.error.code).toBe('vehicle_in_transit');
    const blocked = await t.owner.post(`/vehicles/${v.id}/status`, { to: 'in_preparation' });
    expect(blocked.body.error.code).toBe('vehicle_in_transit');
    // A user scoped only to the origin branch cannot receive at the destination.
    const origin = await addMember(app, t, 'inventory_manager', { allBranches: false, branchIds: [t.branchId] });
    expect((await origin.client.post(`/inventory/transfers/${tr.body.id}/receive`)).status).toBe(403);
    expect((await t.owner.post(`/inventory/transfers/${tr.body.id}/receive`)).status).toBe(200);
    expect((await t.owner.get(`/vehicles/${v.id}`)).body.vehicle.branchId).toBe(b2.body.id);
    // Branch scoping: the origin-only user no longer sees the vehicle.
    expect((await origin.client.get(`/vehicles/${v.id}`)).status).toBe(403);
    const list = await origin.client.get('/vehicles?scope=all&pageSize=200');
    expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(v.id);
  });

  it('stock count: scan, submit, reconcile with write-off permission', async () => {
    const t2 = await createTenant(app, await createPlatformAdmin(app));
    const v1 = await createVehicle(t2.owner, t2.branchId);
    const v2 = await createVehicle(t2.owner, t2.branchId);
    const open = await t2.owner.post('/inventory/stock-counts', { branchId: t2.branchId });
    expect(open.status).toBe(201);
    expect(open.body.expectedCount).toBe(2);
    expect((await t2.owner.post(`/inventory/stock-counts/${open.body.id}/scan`, { code: v1.stockNumber })).body.result).toBe('matched');
    expect((await t2.owner.post(`/inventory/stock-counts/${open.body.id}/scan`, { code: 'UNKNOWN999' })).body.result).toBe('unknown');
    const sum = await t2.owner.post(`/inventory/stock-counts/${open.body.id}/submit`);
    expect(sum.body).toMatchObject({ expected: 2, found: 1, missing: 1, unexpected: 1 });
    const count = await t2.owner.get(`/inventory/stock-counts/${open.body.id}`);
    const missing = count.body.lines.find((l: { vehicleId: string }) => l.vehicleId === v2.id);
    const unexpected = count.body.lines.find((l: { expected: boolean }) => !l.expected);
    const inv = await addMember(app, t2, 'accountant');
    expect((await inv.client.post(`/inventory/stock-counts/${open.body.id}/reconcile`, { lines: [] })).status).toBe(403);
    const rec = await t2.owner.post(`/inventory/stock-counts/${open.body.id}/reconcile`, {
      lines: [
        { lineId: missing.id, resolution: 'written_off', notes: 'Stolen — police report 123' },
        { lineId: unexpected.id, resolution: 'unexpected_noted', notes: 'customer car in for service' },
      ],
    });
    expect(rec.body).toMatchObject({ status: 'reconciled', remaining: 0 });
    expect((await t2.owner.get(`/vehicles/${v2.id}`)).body.vehicle.status).toBe('removed');
  });

  it('search and filters', async () => {
    const t3 = await createTenant(app, await createPlatformAdmin(app));
    const feats = await t3.owner.get('/catalog/features');
    const sunroof = feats.body.find((f: { code: string }) => f.code === 'sunroof');
    const a = await createVehicle(t3.owner, t3.branchId, { vin: 'JN1AZ4EH7DM430111', featureIds: [sunroof.id], fuelType: 'petrol' });
    const b = await createVehicle(t3.owner, t3.branchId, { fuelType: 'diesel', modelYear: 2018 });
    const byVin = await t3.owner.get('/vehicles?q=430111');
    expect(byVin.body.items.map((x: { id: string }) => x.id)).toEqual([a.id]);
    const byFeature = await t3.owner.get(`/vehicles?featureIds=${sunroof.id}`);
    expect(byFeature.body.total).toBe(1);
    const byFuel = await t3.owner.get('/vehicles?fuelType=diesel');
    expect(byFuel.body.items[0].id).toBe(b.id);
    const byYear = await t3.owner.get('/vehicles?yearFrom=2020');
    expect(byYear.body.items.map((x: { id: string }) => x.id)).toEqual([a.id]);
    const arabic = await t3.owner.get(`/vehicles?q=${encodeURIComponent('كامري')}`);
    expect(arabic.body.total).toBe(2);
    expect((await t3.owner.get('/vehicles?status=bogus')).status).toBe(422);
  });

  it('tenant isolation for vehicles', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    expect((await other.owner.get(`/vehicles/${v.id}`)).status).toBe(404);
    expect((await other.owner.patch(`/vehicles/${v.id}`, { version: 1, trim: 'X' })).status).toBe(404);
    expect((await other.owner.post(`/vehicles/${v.id}/status`, { to: 'in_preparation' })).status).toBe(404);
    const list = await other.owner.get('/vehicles?scope=all');
    expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(v.id);
    // A tenant-added make is invisible to other tenants; platform makes are shared.
    const mk = await t.owner.post('/catalog/makes', { nameEn: `Custom${Date.now()}`, nameAr: 'خاص' });
    expect(mk.status).toBe(201);
    const otherMakes = await other.owner.get('/catalog/makes');
    expect(otherMakes.body.map((m: { id: string }) => m.id)).not.toContain(mk.body.id);
    expect(otherMakes.body.length).toBeGreaterThan(30);
  });
});
