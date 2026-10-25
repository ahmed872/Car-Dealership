// Browser helpers shared by the capture scripts: signed-in contexts (Arabic, light theme),
// screenshot + callout boxes.
import { createRequire } from 'node:module';
import { WEB, PASSWORD } from './client.mjs';
const require = createRequire(import.meta.url);
export const { chromium } = require('/home/user/Car-Dealership/e2e/node_modules/@playwright/test');
export const CHROME = process.env.GUIDE_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export async function launch() {
  return chromium.launch({ executablePath: CHROME });
}

/** A browser context signed in as `email` (or anonymous when email is null). */
export async function contextFor(browser, email, { width = 1440, height = 900, mobile = false } = {}) {
  const ctx = await browser.newContext({
    baseURL: WEB,
    viewport: { width, height },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'ar-SA',
    timezoneId: 'Asia/Riyadh',
    colorScheme: 'light',
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('ah.lang', 'ar');
      localStorage.setItem('ah.theme', 'light');
    } catch {}
  });
  if (email) {
    const res = await ctx.request.post('/api/v1/auth/login', {
      data: { email, password: PASSWORD },
      headers: { Origin: WEB },
    });
    if (res.status() !== 200) throw new Error(`login ${email}: ${res.status()} ${await res.text()}`);
  }
  return ctx;
}

/** Waits until the SPA has no spinners/skeletons and the network is quiet. */
export async function settle(page, ms = 400) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  for (let i = 0; i < 40; i++) {
    const busy = await page.locator('[aria-busy="true"], .animate-pulse, .animate-spin').count();
    if (!busy) break;
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(ms);
}
