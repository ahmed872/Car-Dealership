import { VEHICLE_STATUS_LABELS } from '@autohub/shared';
import { addMember, catalogIds, createSupplier, newVin } from '../support/fixtures';
import { reEscape } from '../support/i18n';
import { apiCall, byLabel, expect, pickFromCombobox, test } from '../support/test';

test.describe('purchasing → stock', () => {
  test('an acquisition entered in the form is approved by a second approver and the car shows in inventory', async ({
    page,
    owner,
    tr,
    lang,
    signIn,
  }) => {
    const supplier = await createSupplier(owner);
    const { make, model } = await catalogIds(owner);
    const approverMember = await addMember(owner, 'branch_manager');
    const vin = newVin();
    const optionLabel = (x: { nameAr: string; nameEn: string }) =>
      lang === 'en' ? x.nameEn : `${x.nameAr} · ${x.nameEn}`;

    // ── The buyer enters the purchase ─────────────────────────────────────────────────────
    await page.goto('/app/purchasing/acquisitions');
    await page
      .getByRole('button', { name: tr('purchasing.acquisitions.add') })
      .first()
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: tr('purchasing.acquisitions.add') }),
    ).toBeVisible();

    await pickFromCombobox(
      page.getByRole('combobox', {
        name: new RegExp(`^${reEscape(tr('purchasing.acquisitions.supplier'))}`),
      }),
      supplier.name,
      new RegExp(reEscape(supplier.name)),
    );
    await byLabel(page, tr('purchasing.acquisitions.price')).fill('85000.00');
    await byLabel(page, tr('purchasing.vehicle.make')).selectOption({ label: optionLabel(make) });
    await byLabel(page, tr('purchasing.vehicle.model')).selectOption({ label: optionLabel(model) });
    await byLabel(page, tr('purchasing.vehicle.modelYear')).fill('2022');
    await byLabel(page, tr('purchasing.vehicle.vin')).fill(vin);
    await byLabel(page, tr('purchasing.vehicle.odometer')).fill('30500');
    await byLabel(page, tr('purchasing.vehicle.exteriorColor')).fill('Pearl white');
    await page.getByLabel(tr('purchasing.acquisitions.submitNow')).check();

    const created = await apiCall(page, 'POST', /\/api\/v1\/acquisitions$/, () =>
      page.getByRole('button', { name: tr('purchasing.acquisitions.save') }).click(),
    );
    const acq = (await created.json()) as {
      id: string;
      number: string;
      vehicle: { id: string; stockNumber: string };
    };
    await expect(page).toHaveURL(new RegExp(`/app/purchasing/acquisitions/${acq.id}$`));
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(acq.number);
    await expect(heading).toContainText(tr('purchasing.enums.acquisitionStatus.pending_approval'));
    // Maker-checker: the person who entered it cannot approve it.
    await expect(page.getByRole('button', { name: tr('common.approve'), exact: true })).toBeDisabled();
    await expect(page.getByText(tr('purchasing.acquisitions.makerCheckerTitle'))).toBeVisible();

    // ── A branch manager approves it in their own session ───────────────────────────────
    const approver = await signIn(approverMember);
    const ap = approver.page;
    await ap.goto(`/app/purchasing/acquisitions/${acq.id}`);
    await expect(ap.getByRole('heading', { level: 1 })).toContainText(acq.number);
    await ap.getByRole('button', { name: tr('common.approve'), exact: true }).click();
    const dialog = ap
      .getByRole('dialog')
      .filter({ hasText: tr('purchasing.acquisitions.approveTitle', { number: acq.number }) });
    await expect(dialog).toBeVisible();
    await apiCall(ap, 'POST', new RegExp(`/api/v1/acquisitions/${acq.id}/approve$`), () =>
      dialog.getByRole('button', { name: tr('common.approve'), exact: true }).click(),
    );
    await expect(dialog).toBeHidden();
    await expect(ap.getByRole('heading', { level: 1 })).toContainText(
      tr('purchasing.enums.acquisitionStatus.approved'),
    );

    // ── The buyer sees the approval and finds the car in inventory ─────────────────────
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      tr('purchasing.enums.acquisitionStatus.approved'),
    );
    await page.getByRole('link', { name: tr('purchasing.acquisitions.openVehicle') }).click();
    await expect(page).toHaveURL(new RegExp(`/app/vehicles/${acq.vehicle.id}$`));
    await expect(page.getByText(vin).first()).toBeVisible();

    await page.goto('/app/vehicles');
    await page.getByLabel(tr('common.search')).fill(vin);
    const card = page.getByRole('button').filter({ hasText: acq.vehicle.stockNumber });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(VEHICLE_STATUS_LABELS.incoming[lang]);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/app/vehicles/${acq.vehicle.id}$`));
  });
});
