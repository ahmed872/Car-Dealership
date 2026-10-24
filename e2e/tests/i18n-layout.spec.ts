import { expectStatus } from '../support/api';
import { availableVehicle, createCustomer } from '../support/fixtures';
import { ARABIC, translator } from '../support/i18n';
import { expect, mainNav, test } from '../support/test';

test.describe('language and direction', () => {
  test('the language toggle switches html lang/dir, the texts and the sidebar side, and is remembered', async ({
    page,
    lang,
    tr,
    isMobile,
  }) => {
    const other = lang === 'ar' ? 'en' : 'ar';
    const trOther = translator(other);
    await page.goto('/app');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', lang);
    await expect(html).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    await expect(
      page.getByRole('heading', { level: 1, name: tr('dashboard.welcome', { name: 'Owner E2E' }) }),
    ).toBeVisible();

    // The toggle names the other language in that language.
    await page.getByRole('button', { name: lang === 'ar' ? 'English' : 'العربية' }).click();
    await expect(html).toHaveAttribute('lang', other);
    await expect(html).toHaveAttribute('dir', other === 'ar' ? 'rtl' : 'ltr');
    const welcome = page.getByRole('heading', {
      level: 1,
      name: trOther('dashboard.welcome', { name: 'Owner E2E' }),
    });
    await expect(welcome).toBeVisible();
    expect(ARABIC.test(trOther('dashboard.subtitle'))).toBe(other === 'ar');
    await expect(page.getByText(trOther('dashboard.subtitle'), { exact: true })).toBeVisible();

    if (!isMobile) {
      // True RTL/LTR: the sidebar sits at the inline start — the right edge in Arabic, the left in English.
      const nav = await mainNav(page);
      await expect(nav.getByRole('link', { name: trOther('nav.dashboard') })).toBeVisible();
      const box = (await nav.boundingBox())!;
      const width = page.viewportSize()!.width;
      if (other === 'ar') expect(box.x + box.width).toBeGreaterThan(width - 2);
      else expect(box.x).toBeLessThan(2);
    }

    // The choice survives a reload (localStorage), then switch back.
    await page.reload();
    await expect(html).toHaveAttribute('lang', other);
    await expect(welcome).toBeVisible();
    await page.getByRole('button', { name: other === 'ar' ? 'English' : 'العربية' }).click();
    await expect(html).toHaveAttribute('lang', lang);
    await expect(
      page.getByRole('heading', { level: 1, name: tr('dashboard.welcome', { name: 'Owner E2E' }) }),
    ).toBeVisible();
  });

  test('main pages have no horizontal page scroll at 390px', async ({ page, owner, tr }) => {
    // Something on every list, so tables and cards render rows (long names stress the layout).
    const customer = await createCustomer(owner, {
      fullName: `Customer with a rather long name ${Date.now()}`,
    });
    const vehicle = await availableVehicle(owner);
    await expectStatus(
      await owner.post('/sales', {
        vehicleId: vehicle.id,
        customerId: customer.id,
        agreedPrice: vehicle.askingPrice,
      }),
      201,
      'draft sale',
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const pages: Array<{ path: string; heading: string; ready: () => Promise<void> }> = [
      {
        path: '/app',
        heading: tr('dashboard.welcome', { name: 'Owner E2E' }),
        ready: () =>
          expect(
            page.getByRole('heading', { level: 2, name: tr('reports.dashboard.sections.sales') }),
          ).toBeVisible(),
      },
      {
        path: '/app/vehicles',
        heading: tr('vehicles.title'),
        ready: () => expect(page.getByText(vehicle.stockNumber).first()).toBeVisible(),
      },
      {
        path: '/app/sales',
        heading: tr('sales.title'),
        ready: () => expect(page.getByText(customer.fullName).first()).toBeVisible(),
      },
      {
        path: '/app/customers',
        heading: tr('customers.title'),
        ready: () => expect(page.getByText(customer.fullName).first()).toBeVisible(),
      },
      {
        path: '/app/reservations',
        heading: tr('reservations.title'),
        ready: () => expect(page.getByRole('table').first()).toBeVisible(),
      },
      {
        path: '/app/cash/accounts',
        heading: tr('cash.accounts.title'),
        ready: () => expect(page.getByRole('table').first()).toBeVisible(),
      },
      {
        path: '/app/receipts',
        heading: tr('receivables.receipts.title'),
        ready: () => expect(page.getByRole('table').first()).toBeVisible(),
      },
      {
        path: '/app/appointments',
        heading: tr('appointments.title'),
        ready: () =>
          expect(page.getByRole('status').filter({ hasText: tr('common.loading') })).toHaveCount(0),
      },
    ];
    for (const p of pages) {
      await page.goto(p.path);
      await expect(page.getByRole('heading', { level: 1, name: p.heading })).toBeVisible();
      await p.ready();
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return {
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          bodyWidth: document.body.scrollWidth,
        };
      });
      expect(
        overflow.scrollWidth,
        `${p.path} scrolls sideways (${JSON.stringify(overflow)})`,
      ).toBeLessThanOrEqual(overflow.clientWidth);
      expect(overflow.bodyWidth, `${p.path} body is wider than the screen`).toBeLessThanOrEqual(
        overflow.clientWidth,
      );
    }
  });
});
