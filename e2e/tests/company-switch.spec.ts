import { ApiClient, expectStatus, uniq } from '../support/api';
import { ADMIN_EMAIL, PASSWORD } from '../support/env';
import { addMember, createCustomer, me, provisionCompany } from '../support/fixtures';
import { expect, mainNav, test } from '../support/test';
import { emptyState, signInOnPage } from '../support/ui';

test.describe('company invitations and switching', () => {
  test('a member accepts another company’s invitation in the UI and switches between the two', async ({
    browser,
    lang,
    owner,
    tr,
  }) => {
    // A member of the e2e company (A)…
    const member = await addMember(owner, 'sales_rep');
    const companyA = (await me(owner)).tenant!.name;
    // …is invited by company B, which already holds a record only B can see.
    const admin = await ApiClient.login(ADMIN_EMAIL, PASSWORD);
    const other = await provisionCompany(admin);
    await admin.dispose();
    const b = other.owner;
    const companyB = `Other ${other.slug}`;
    const roles = await b.json<Array<{ id: string; key: string | null }>>('/roles');
    const invited = await expectStatus<{ status: string }>(
      await b.post('/users', {
        email: member.email,
        fullName: 'ignored for an existing account',
        password: 'Ignored-Passw0rd!',
        roleId: roles.find((r) => r.key === 'sales_manager')!.id,
        allBranches: true,
        branchIds: [],
      }),
      201,
      'invite an existing account',
    );
    expect(invited.status).toBe('invited');
    const onlyInB = uniq('B-only customer ');
    await createCustomer(b, { fullName: onlyInB });
    await b.dispose();

    // The invitation alone gives nothing: the member signs in straight into company A.
    const context = await browser.newContext({ storageState: emptyState(lang) });
    const page = await context.newPage();
    await page.goto('/login');
    await signInOnPage(page, tr, member.email, PASSWORD);
    await expect(page).toHaveURL(/\/app$/);
    await expect((await mainNav(page)).getByText(companyA, { exact: true })).toBeVisible();

    // Accept it on the company page; company B joins the list.
    await page.goto('/select-company');
    await expect(page.getByText(companyB)).toBeVisible();
    await page.getByRole('button', { name: tr('auth.accept') }).click();
    const companyList = page.getByRole('list');
    await expect(companyList.getByRole('button', { name: new RegExp(companyB) })).toBeVisible();

    // Switching to B updates the whole app (company shown, data), not just the server session.
    await companyList.getByRole('button', { name: new RegExp(companyB) }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect((await mainNav(page)).getByText(companyB, { exact: true })).toBeVisible();
    await page.goto(`/app/customers?q=${encodeURIComponent(onlyInB)}`);
    await expect(page.getByText(onlyInB)).toBeVisible();

    // And back to A: B's record disappears again.
    await page.goto('/select-company');
    await page.getByRole('list').getByRole('button', { name: new RegExp(companyA) }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect((await mainNav(page)).getByText(companyA, { exact: true })).toBeVisible();
    await page.goto(`/app/customers?q=${encodeURIComponent(onlyInB)}`);
    await expect(page.getByRole('heading', { level: 1, name: tr('customers.title') })).toBeVisible();
    await expect(page.getByText(onlyInB)).toHaveCount(0);
    await context.close();
  });
});
