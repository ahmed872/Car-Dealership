import { writeFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAcquisition, createCashAccount, createCustomer, createSupplier, makeAvailable, secondApprover, sellVehicle } from './fixtures';
import { Client, closeApp, createPlatformAdmin, createTenant, getApp, TestTenant } from './helpers';

/**
 * Performance smoke test (Phase 8). Opt-in: `PERF_SMOKE=1 npx vitest run test/perf-smoke.spec.ts`.
 * Seeds one company through the real API (every record goes through the same services, postings
 * and audit as in production), then times the heaviest read endpoints in-process (no network).
 * The volumes below are a busy single showroom, not a benchmark; the numbers are recorded in
 * docs/TEST_REPORT.md. Thresholds are generous smoke limits that catch pathological queries.
 */
const VOLUME = {
  customers: Number(process.env.PERF_CUSTOMERS ?? 1500),
  leads: Number(process.env.PERF_LEADS ?? 1000),
  stock: Number(process.env.PERF_STOCK ?? 250),
  sales: Number(process.env.PERF_SALES ?? 120),
};

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

describe.skipIf(process.env.PERF_SMOKE !== '1')('performance smoke', () => {
  let app: INestApplication;
  let t: TestTenant;
  let owner: Client;
  const timings: Array<{ route: string; p50: number; p95: number; max: number }> = [];
  let seedSeconds = 0;

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    owner = t.owner;
    const checker = await secondApprover(owner);
    const supplier = await createSupplier(owner);
    const cash = await createCashAccount(owner, { name: 'Main safe', openingBalance: '50000000.00' });
    const started = Date.now();
    const customers: string[] = [];
    for (let i = 0; i < VOLUME.customers; i++) customers.push((await createCustomer(owner, { fullName: `Perf customer ${i}` })).id);
    const sources = ['walk_in', 'phone', 'whatsapp', 'website', 'referral'] as const;
    for (let i = 0; i < VOLUME.leads; i++) {
      const res = await owner.post('/leads', { customerId: customers[i % customers.length], branchId: t.branchId, source: sources[i % sources.length], budgetMax: '150000.00' });
      if (res.status !== 201) throw new Error(`lead failed ${res.status} ${JSON.stringify(res.body)}`);
    }
    const vehicles: string[] = [];
    for (let i = 0; i < VOLUME.stock; i++) {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '80000.00', approver: checker });
      await makeAvailable(owner, acq.vehicleId, '120000.00', '110000.00');
      vehicles.push(acq.vehicleId);
    }
    for (let i = 0; i < VOLUME.sales; i++) {
      await sellVehicle(owner, { vehicleId: vehicles[i]!, customerId: customers[i]!, cashAccountId: cash.id, agreedPrice: '115000.00' });
    }
    seedSeconds = Math.round((Date.now() - started) / 1000);
  }, 3_600_000);

  afterAll(async () => {
    // The app logs nothing in tests; PERF_OUT=<file> keeps the numbers for the test report.
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify({ volume: VOLUME, seedSeconds, timings }, null, 2));
    await closeApp();
  });

  async function time(route: string, runs = 15, limitMs = 1500) {
    const ms: number[] = [];
    for (let i = 0; i < runs; i++) {
      const s = performance.now();
      const res = await owner.get(route);
      ms.push(performance.now() - s);
      expect(res.status, `${route}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    }
    ms.sort((a, b) => a - b);
    const row = { route, p50: Math.round(percentile(ms, 50)), p95: Math.round(percentile(ms, 95)), max: Math.round(ms.at(-1)!) };
    timings.push(row);
    expect(row.p95, route).toBeLessThan(limitMs);
  }

  it('lists and searches stay fast at volume', async () => {
    await time('/vehicles?page=1&pageSize=25');
    await time('/vehicles?q=Camry&status=available&page=1&pageSize=25');
    await time('/customers?page=1&pageSize=25');
    await time('/customers?q=Perf%20customer%2012');
    await time('/leads?page=1&pageSize=25');
    await time('/sales?page=1&pageSize=25');
    await time('/approvals');
    await time('/notifications');
  }, 600_000);

  it('dashboard, reports and ledger views stay within smoke limits', async () => {
    await time('/dashboard', 10, 3000);
    await time('/reports/inventory', 5, 5000);
    await time('/reports/sales', 5, 5000);
    await time('/reports/receivables', 5, 5000);
    await time('/reports/cash-flow', 5, 5000);
    await time('/ledger/trial-balance', 5, 5000);
    await time('/reports/sales/export?format=xlsx', 3, 10000);
  }, 600_000);
});
