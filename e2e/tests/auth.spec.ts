import { addMember } from '../support/fixtures';
import { emptyState, expect, signInOnPage, test } from '../support/test';

// Every test here starts signed out (no cookies), with the project's UI language preselected.
test.use({ storageState: async ({ lang }, use) => use(emptyState(lang)) });

test.describe('authentication', () => {
  test('signs in through the login form and signs out from the user menu', async ({ page, owner, tr, lang }) => {
    const member = await addMember(owner, 'sales_manager');

    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    await expect(page.getByRole('heading', { level: 1, name: tr('auth.signInTitle') })).toBeVisible();

    await signInOnPage(page, tr, member.email, member.password);
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { level: 1, name: tr('dashboard.welcome', { name: member.fullName }) })).toBeVisible();
    const me = await page.request.get('/api/v1/auth/me');
    expect(me.status()).toBe(200);
    expect((await me.json()).user.email).toBe(member.email);

    // The account menu in the top bar (on phones the trigger shows only the avatar initial).
    await page.getByRole('banner').locator('button[aria-haspopup="menu"]').click();
    await expect(page.getByRole('menu')).toContainText(member.email);
    const logout = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/logout') && r.request().method() === 'POST');
    await page.getByRole('menuitem', { name: tr('auth.signOut') }).click();
    expect((await logout).status()).toBe(200);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: tr('auth.signInTitle') })).toBeVisible();

    // The session is gone on the server too: the app sends the user back to sign in.
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a wrong password shows the error and keeps the user on the login page', async ({ page, owner, tr }) => {
    const member = await addMember(owner, 'sales_rep');
    await page.goto('/login');

    const failed = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login'));
    await signInOnPage(page, tr, member.email, `${member.password}-wrong`);
    expect((await failed).status()).toBe(401);
    await expect(page.getByRole('alert')).toHaveText(tr('errors.invalid_credentials'));
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);

    // One failure does not lock the account: the right password still works.
    await page.getByLabel(tr('auth.password')).fill(member.password);
    await page.getByRole('button', { name: tr('auth.signIn') }).click();
    await expect(page.getByRole('heading', { level: 1, name: tr('dashboard.welcome', { name: member.fullName }) })).toBeVisible();
  });

  test('an unauthenticated deep link goes to sign-in and back to the page afterwards', async ({ page, owner, tr }) => {
    const member = await addMember(owner, 'accountant');

    await page.goto('/app/cash/transfers?from=deep-link');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: tr('auth.signInTitle') })).toBeVisible();

    await signInOnPage(page, tr, member.email, member.password);
    await expect(page).toHaveURL(/\/app\/cash\/transfers\?from=deep-link$/);
    await expect(page.getByRole('heading', { level: 1, name: tr('cash.transfers.title') })).toBeVisible();
  });
});
