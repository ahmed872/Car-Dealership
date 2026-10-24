import fs from 'node:fs';
import { d } from '@autohub/shared';
import { uniq } from '../support/api';
import { availableVehicle, createCashAccount, createCustomer, sellVehicle } from '../support/fixtures';
import { reEscape } from '../support/i18n';
import { zipEntries } from '../support/xlsx';
import { expect, test } from '../support/test';

interface Dashboard {
  sales: { netRevenue: string; units: number };
  inventory: { onHand: number };
}

test.describe('dashboard and reports', () => {
  test('the dashboard shows the real figures after a sale is delivered', async ({ page, owner, tr, fmt }) => {
    const before = await owner.json<Dashboard>('/dashboard');
    const vehicle = await availableVehicle(owner, '64400.00');
    const customer = await createCustomer(owner, { fullName: uniq('Dashboard buyer ') });
    const box = await createCashAccount(owner, { name: uniq('Dash box ') });
    const sale = await sellVehicle(owner, {
      vehicleId: vehicle.id,
      customerId: customer.id,
      cashAccountId: box.id,
      agreedPrice: '64400.00',
    });
    // 64,400 including 15% VAT → 56,000 net revenue.
    expect(sale.netAmount).toBe('56000.00');
    const after = await owner.json<Dashboard>('/dashboard');
    expect(after.sales.units).toBe(before.sales.units + 1);
    const expectedRevenue = d(before.sales.netRevenue).plus(sale.netAmount).toFixed(2);
    expect(after.sales.netRevenue).toBe(expectedRevenue);

    await page.goto('/app');
    const sales = page.getByRole('region', { name: tr('reports.dashboard.sections.sales') });
    const card = (label: string) => sales.getByRole('button', { name: new RegExp(`^${reEscape(label)}`) });
    await expect(card(tr('reports.dashboard.sales.netRevenue'))).toContainText(fmt(expectedRevenue));
    await expect(card(tr('reports.dashboard.sales.units'))).toContainText(String(after.sales.units));

    // The KPI drills down to the report behind it.
    await card(tr('reports.dashboard.sales.netRevenue')).click();
    await expect(page).toHaveURL(/\/app\/reports\/sales$/);
    await expect(
      page.getByRole('heading', { level: 1, name: tr('reports.catalog.sales.title') }),
    ).toBeVisible();
  });

  test('a report exports to a non-empty Excel workbook', async ({ page, owner, tr }) => {
    // At least one delivered sale this month, so the export has rows.
    const vehicle = await availableVehicle(owner, '50000.00');
    const customer = await createCustomer(owner, { fullName: uniq('Export buyer ') });
    const box = await createCashAccount(owner, { name: uniq('Export box ') });
    await sellVehicle(owner, {
      vehicleId: vehicle.id,
      customerId: customer.id,
      cashAccountId: box.id,
      agreedPrice: '50000.00',
    });

    await page.goto('/app/reports');
    await page.getByRole('link', { name: new RegExp(reEscape(tr('reports.catalog.sales.title'))) }).click();
    await expect(page).toHaveURL(/\/app\/reports\/sales$/);
    await expect(
      page.getByRole('heading', { level: 1, name: tr('reports.catalog.sales.title') }),
    ).toBeVisible();
    await expect(page.getByRole('table').first()).toContainText(customer.fullName);

    const exportGroup = page.getByRole('group', { name: tr('reports.export.label') });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportGroup.getByRole('link', { name: tr('reports.export.excel') }).click(),
    ]);
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    const file = await download.path();
    const bytes = fs.readFileSync(file);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK'); // an OOXML (zip) workbook
    // A real workbook with a worksheet, and the sale is in it (the customer's name appears).
    const parts = zipEntries(bytes);
    expect([...parts.keys()].some((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))).toBe(true);
    expect([...parts.values()].some((xml) => xml.includes(customer.fullName))).toBe(true);
  });
});
