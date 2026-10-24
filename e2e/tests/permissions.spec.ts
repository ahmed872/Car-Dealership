import { addMember, addMemberWithPermissions } from '../support/fixtures';
import { expect, mainNav, test } from '../support/test';

test.describe('permissions in the UI', () => {
  test('a sales rep sees no accounting navigation and gets the forbidden page on finance URLs', async ({
    owner,
    tr,
    signIn,
  }) => {
    const rep = await addMember(owner, 'sales_rep');
    const { page } = await signIn(rep);

    const nav = await mainNav(page);
    await expect(nav.getByRole('link', { name: tr('nav.salesOrders') })).toBeVisible();
    await expect(nav.getByRole('link', { name: tr('nav.customers') })).toBeVisible();
    for (const key of [
      'nav.ledger',
      'nav.cash',
      'nav.expenses',
      'nav.reports',
      'cash.nav.transfers',
      'cashClosing.nav',
      'nav.acquisitions',
      'nav.users',
    ]) {
      await expect(nav.getByRole('link', { name: tr(key) }), key).toHaveCount(0);
    }
    // Receipts and refunds stay (payments.read); the accounting side is gone.
    await expect(nav.getByRole('link', { name: tr('nav.payments') })).toBeVisible();

    for (const path of [
      '/app/accounting',
      '/app/cash/accounts',
      '/app/expenses',
      '/app/purchasing/acquisitions/new',
      '/app/settings/users',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: tr('errors.forbidden') }), path).toBeVisible();
    }
    // The server enforces the same rule (the UI gate is only a convenience).
    expect((await page.request.get('/api/v1/ledger/trial-balance')).status()).toBe(403);
    expect((await page.request.get('/api/v1/cash-accounts')).status()).toBe(403);
  });

  test('a custom role sees exactly what it was granted', async ({ owner, tr, signIn }) => {
    const viewer = await addMemberWithPermissions(owner, ['dashboard.view', 'cash.read']);
    const { page } = await signIn(viewer);

    const nav = await mainNav(page);
    await expect(nav.getByRole('link', { name: tr('nav.cash') })).toBeVisible();
    await expect(nav.getByRole('link', { name: tr('nav.ledger') })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: tr('nav.salesOrders') })).toHaveCount(0);

    await page.goto('/app/cash/accounts');
    await expect(page.getByRole('heading', { level: 1, name: tr('cash.accounts.title') })).toBeVisible();
    // Read-only: no transfer or new-account actions without cash.transfer / cash.manage_accounts.
    await expect(page.getByRole('button', { name: tr('cash.transfers.add') })).toHaveCount(0);
    await expect(page.getByRole('button', { name: tr('cash.accounts.add') })).toHaveCount(0);

    await page.goto('/app/accounting');
    await expect(page.getByRole('heading', { name: tr('errors.forbidden') })).toBeVisible();
    await page.goto('/app/sales');
    await expect(page.getByRole('heading', { name: tr('errors.forbidden') })).toBeVisible();
    expect((await page.request.get('/api/v1/sales')).status()).toBe(403);
  });
});
