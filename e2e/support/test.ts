import { type BrowserContext, type Page, test as base, expect } from '@playwright/test';
import { ApiClient } from './api';
import { type Lang, ownerState } from './env';
import type { Member } from './fixtures';
import { money, type Translate, translator } from './i18n';
import { emptyState, signInOnPage } from './ui';

export interface TestOptions {
  /** UI language of the project (the app reads it from localStorage `ah.lang`, not navigator.language). */
  lang: Lang;
}

interface Fixtures {
  tr: Translate;
  /** Money formatted like the UI in the project language. */
  fmt: (value: string) => string;
  /** API client on the owner's session, for setting up preconditions. */
  owner: ApiClient;
  /** Opens a separate browser context (same device settings) and signs in through the login page. */
  signIn: (who: Pick<Member, 'email' | 'password'>) => Promise<{ context: BrowserContext; page: Page }>;
}

export const test = base.extend<TestOptions & Fixtures>({
  lang: ['ar', { option: true }],
  tr: async ({ lang }, use) => use(translator(lang)),
  fmt: async ({ lang }, use) => use((v: string) => money(v, lang)),
  owner: async ({ lang }, use) => {
    const c = await ApiClient.fromStorageState(ownerState(lang));
    await use(c);
    await c.dispose();
  },
  signIn: async ({ browser, lang, tr }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (who) => {
      // Inherits the project's viewport/touch/locale; only the session and the language are replaced.
      const context = await browser.newContext({ storageState: emptyState(lang) });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto('/login');
      await signInOnPage(page, tr, who.email, who.password);
      await expect(page).toHaveURL(/\/app$/);
      return { context, page };
    });
    for (const c of contexts) await c.close();
  },
});

export { expect };
export * from './ui';

