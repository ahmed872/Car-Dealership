import { ApiClient, expectStatus, uniq } from '../support/api';
import { ADMIN_EMAIL, PASSWORD } from '../support/env';
import {
  createCashAccount,
  createCustomer,
  createVehicle,
  mainBranchId,
  makeAvailable,
  provisionCompany,
} from '../support/fixtures';
import { expect, test } from '../support/test';

test.describe('tenant isolation', () => {
  test("another company's records answer 404 in the UI and the API, without leaking data", async ({
    page,
    owner,
    tr,
  }) => {
    // Company B, provisioned by the platform admin, with its own records.
    const admin = await ApiClient.login(ADMIN_EMAIL, PASSWORD);
    const other = await provisionCompany(admin);
    await admin.dispose();
    const b = other.owner;
    const secret = uniq('Other company customer ');
    const customer = await createCustomer(b, { fullName: secret });
    const vehicle = await createVehicle(b, await mainBranchId(b), { exteriorColor: 'Midnight blue' });
    await makeAvailable(b, vehicle.id, '77000.00', '70000.00');
    const box = await createCashAccount(b, { name: uniq('Other box '), openingBalance: '1234.56' });
    const sale = await expectStatus<{ id: string; number: string }>(
      await b.post('/sales', { vehicleId: vehicle.id, customerId: customer.id, agreedPrice: '77000.00' }),
      201,
      'draft sale in company B',
    );

    const targets = [
      { ui: `/app/customers/${customer.id}`, api: `/customers/${customer.id}` },
      { ui: `/app/vehicles/${vehicle.id}`, api: `/vehicles/${vehicle.id}` },
      { ui: `/app/sales/${sale.id}`, api: `/sales/${sale.id}` },
      { ui: `/app/cash/accounts/${box.id}`, api: `/cash-accounts/${box.id}` },
    ];
    for (const target of targets) {
      // Company A's owner (all permissions) cannot see B's record: 404, never 403.
      expect((await owner.get(target.api)).status(), target.api).toBe(404);
      const res = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1${target.api}`);
      await page.goto(target.ui);
      expect((await res).status(), target.ui).toBe(404);
      await expect(page.getByText(tr('errors.not_found')).first(), target.ui).toBeVisible();
    }
    // Nothing of B shows up in A's lists or searches either.
    await page.goto(`/app/customers?q=${encodeURIComponent(secret)}`);
    await expect(page.getByRole('heading', { level: 1, name: tr('customers.title') })).toBeVisible();
    await expect(page.getByText(secret)).toHaveCount(0);
    await expect(page.getByText(sale.number)).toHaveCount(0);

    // Sanity: B's owner does see them (the ids are real).
    expect((await b.get(`/customers/${customer.id}`)).status()).toBe(200);
    expect((await b.get(`/sales/${sale.id}`)).status()).toBe(200);
    await b.dispose();
  });
});
