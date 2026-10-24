import { expect, type Locator, type Page } from '@playwright/test';
import { type Lang, WEB_URL } from './env';
import { reEscape, type Translate } from './i18n';

/** A cookie-less storage state that only selects the UI language. */
export function emptyState(lang: Lang) {
  return { cookies: [], origins: [{ origin: WEB_URL, localStorage: [{ name: 'ah.lang', value: lang }] }] };
}

/** Fills and submits the login form (the page must be on /login). */
export async function signInOnPage(page: Page, tr: Translate, email: string, password: string) {
  await page.getByLabel(tr('auth.email')).fill(email);
  await page.getByLabel(tr('auth.password')).fill(password);
  await page.getByRole('button', { name: tr('auth.signIn') }).click();
}

/**
 * The main navigation. Below the lg breakpoint the sidebar lives in a drawer behind the menu
 * button, so it is opened first.
 */
export async function mainNav(page: Page): Promise<Locator> {
  const menu = page.getByRole('button', { name: 'menu' });
  const sidebar = page.getByRole('navigation', { name: 'main' });
  // Wait for the app shell (one of the two is visible once it has rendered).
  await expect(menu.or(sidebar).first()).toBeVisible();
  if (await menu.isVisible()) {
    await menu.click();
    return page.getByRole('dialog').getByRole('navigation', { name: 'main' });
  }
  return sidebar;
}

/** The value cell (<dd>) of a label/value row (<dt>/<dd>) inside `scope`. */
export function rowValue(scope: Locator | Page, label: string): Locator {
  return scope
    .locator('dt')
    .filter({ hasText: new RegExp(`^\\s*${reEscape(label)}\\s*$`) })
    .locator('xpath=following-sibling::dd[1]');
}

/** Waits for the API response of a UI action and returns it (fails on an unexpected status). */
export async function apiCall(
  page: Page,
  method: string,
  path: RegExp,
  action: () => Promise<unknown>,
  status = [200, 201],
) {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === method && path.test(new URL(r.url()).pathname)),
    action(),
  ]);
  expect(status, `${method} ${res.url()} → ${res.status()} ${await res.text().catch(() => '')}`).toContain(
    res.status(),
  );
  return res;
}

/**
 * A form control by the exact text of its label. Required fields append an aria-hidden "*", and
 * some labels are prefixes of others ("Model" / "Model year"), so a plain substring match is ambiguous.
 */
export function byLabel(scope: Locator | Page, text: string): Locator {
  return scope.getByLabel(new RegExp(`^\\s*${reEscape(text)}\\s*\\*?\\s*$`));
}

/** Picks an option of a searchable combobox (supplier / customer / vehicle pickers) by typing. */
export async function pickFromCombobox(combobox: Locator, search: string, option: string | RegExp) {
  await combobox.click();
  await combobox.fill(search);
  const page = combobox.page();
  const listbox = page.getByRole('listbox');
  await listbox.getByRole('option', { name: option }).first().click();
  await expect(listbox).toBeHidden();
}
