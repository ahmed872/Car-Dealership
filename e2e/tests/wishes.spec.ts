import { uniq } from '../support/api';
import { catalogIds, createCustomer, createVehicle, mainBranchId, makeAvailable } from '../support/fixtures';
import { reEscape } from '../support/i18n';
import { apiCall, byLabel, expect, test } from '../support/test';

test.describe('customer wishes', () => {
  test('a wish entered in the form matches stock, shows on the vehicle’s interested customers, and is dismissed/fulfilled', async ({
    page,
    owner,
    tr,
    lang,
  }) => {
    // Two available cars in a colour no other test uses, so the wish matches exactly these two.
    const colour = `Sky${uniq('')}`;
    const branchId = await mainBranchId(owner);
    const { make, model } = await catalogIds(owner);
    const car = async (shade: string) => {
      const v = await createVehicle(owner, branchId, { exteriorColor: `${shade} ${colour}` });
      await makeAvailable(owner, v.id, '99000.00', '95000.00');
      return v;
    };
    const first = await car('Sky blue');
    const second = await car('Deep sky');
    // A realistic long name: the chosen-customer card must still fit a phone screen.
    const customer = await createCustomer(owner, {
      fullName: uniq('Abdulrahman bin Mohammed Al-Qahtani '),
    });
    const optionLabel = (x: { nameAr: string; nameEn: string }) =>
      lang === 'en' ? x.nameEn : `${x.nameAr} · ${x.nameEn}`;

    // ── The wish form ──────────────────────────────────────────────────────────────────
    await page.goto('/app/wishes/new');
    await expect(page.getByRole('heading', { level: 1, name: tr('wishes.newTitle') })).toBeVisible();
    await byLabel(page, tr('wishes.fields.customer')).fill(customer.fullName);
    await page
      .getByRole('listbox', { name: tr('wishes.fields.customer') })
      .getByRole('option', { name: new RegExp(reEscape(customer.fullName)) })
      .click();
    await expect(page.getByRole('button', { name: tr('wishes.fields.changeCustomer') })).toBeVisible();
    await expect(page.getByText(customer.fullName)).toBeVisible();
    // No sideways scrolling (on a phone the browser would zoom the whole form out).
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth, 'the new-wish form scrolls sideways').toBeLessThanOrEqual(page.viewportSize()!.width);
    await byLabel(page, tr('wishes.fields.make')).selectOption({ label: optionLabel(make) });
    await byLabel(page, tr('wishes.fields.model')).selectOption({ label: optionLabel(model) });
    await byLabel(page, tr('wishes.fields.maxPrice')).fill('100000.00');
    await byLabel(page, tr('wishes.fields.color')).fill(colour);
    const created = await apiCall(page, 'POST', /\/api\/v1\/wishes$/, () =>
      page.getByRole('button', { name: tr('common.save') }).click(),
    );
    const wish = (await created.json()) as { id: string; matches: Array<{ vehicleId: string }> };
    expect(wish.matches.map((m) => m.vehicleId).sort()).toEqual([first.id, second.id].sort());
    await expect(page).toHaveURL(new RegExp(`/app/wishes/${wish.id}$`));
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(customer.fullName);
    await expect(heading).toContainText(tr('wishes.statuses.active'));

    // Both cars are listed as matches on sale.
    const matchRow = (stock: string) => page.getByRole('row').filter({ hasText: stock });
    for (const v of [first, second]) {
      await expect(matchRow(v.stockNumber)).toContainText(tr('wishes.matches.onSale'));
    }

    // ── The vehicle page lists the customer as interested ──────────────────────────────
    await page.goto(`/app/vehicles/${second.id}`);
    await page.getByRole('tab', { name: tr('wishes.vehicleTab.tab') }).click();
    await expect(page.getByRole('row').filter({ hasText: customer.fullName })).toBeVisible();

    // ── Dismiss the first car ──────────────────────────────────────────────────────────
    await page.goto(`/app/wishes/${wish.id}`);
    await matchRow(first.stockNumber)
      .getByRole('button', { name: tr('wishes.matches.dismiss') })
      .click();
    const dismiss = page.getByRole('dialog').filter({ hasText: tr('wishes.matches.dismissTitle') });
    await expect(dismiss).toContainText(first.stockNumber);
    await apiCall(page, 'POST', new RegExp(`/api/v1/wishes/${wish.id}/matches/${first.id}/dismiss$`), () =>
      dismiss.getByRole('button', { name: tr('wishes.matches.dismiss') }).click(),
    );
    await expect(dismiss).toBeHidden();
    await expect(matchRow(first.stockNumber)).toHaveCount(0);
    await expect(matchRow(second.stockNumber)).toBeVisible();
    await page.getByRole('button', { name: tr('wishes.matches.showDismissed', { count: 1 }) }).click();
    await expect(matchRow(first.stockNumber)).toContainText(tr('wishes.matches.dismissed'));

    // ── Fulfil with the second car ─────────────────────────────────────────────────────
    await page.getByRole('button', { name: tr('wishes.detail.fulfil') }).click();
    const fulfil = page.getByRole('dialog').filter({ hasText: tr('wishes.close.fulfilHint') });
    await byLabel(fulfil, tr('wishes.close.vehicle')).selectOption(second.id);
    await byLabel(fulfil, tr('wishes.close.note')).fill('Bought the deep sky one');
    await apiCall(page, 'POST', new RegExp(`/api/v1/wishes/${wish.id}/fulfil$`), () =>
      fulfil.getByRole('button', { name: tr('wishes.close.confirmFulfil') }).click(),
    );
    await expect(fulfil).toBeHidden();
    await expect(heading).toContainText(tr('wishes.statuses.fulfilled'));
    await expect(
      page.getByText(tr('wishes.detail.closedNotice', { status: tr('wishes.statuses.fulfilled') })),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: tr('wishes.detail.fulfil') })).toHaveCount(0);
    const stored = await owner.json<{ status: string }>(`/wishes/${wish.id}`);
    expect(stored.status).toBe('fulfilled');

    // A closed wish no longer makes the customer "interested" in the car.
    await page.goto(`/app/vehicles/${second.id}`);
    await page.getByRole('tab', { name: tr('wishes.vehicleTab.tab') }).click();
    await expect(page.getByText(tr('wishes.vehicleTab.empty'))).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: customer.fullName })).toHaveCount(0);
  });
});
