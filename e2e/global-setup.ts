import fs from 'node:fs';
import { chromium, expect, type FullConfig } from '@playwright/test';
import { AUTH_DIR, type Lang, OWNER_EMAIL, ownerState, PASSWORD, WEB_URL } from './support/env';
import { translator } from './support/i18n';
import { emptyState, signInOnPage } from './support/ui';

/**
 * Runs after the webServers are up (Playwright starts webServer plugins before globalSetup; the
 * API start script has already reset the database and provisioned the company). Signs the owner
 * in through the real login page once per UI language and saves the session + language
 * (localStorage `ah.lang`) for the projects to reuse.
 */
export default async function globalSetup(_config: FullConfig) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const lang of ['ar', 'en'] as Lang[]) {
      const tr = translator(lang);
      const context = await browser.newContext({ baseURL: WEB_URL, storageState: emptyState('ar') });
      const page = await context.newPage();
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: translator('ar')('auth.signInTitle') })).toBeVisible();
      if (lang === 'en') {
        // Switch the language the way a user does, on the login page.
        await page.getByRole('button', { name: 'English' }).click();
        await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      }
      await signInOnPage(page, tr, OWNER_EMAIL, PASSWORD);
      await expect(page).toHaveURL(/\/app$/);
      await expect(
        page.getByRole('heading', { name: tr('dashboard.welcome', { name: 'Owner E2E' }) }),
      ).toBeVisible();
      await context.storageState({ path: ownerState(lang) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
