import { d, VEHICLE_STATUS_LABELS } from '@autohub/shared';
import { ApiClient, uniq } from '../support/api';
import {
  addMember,
  cashAccount,
  costCategory,
  createAcquisition,
  createCashAccount,
  createCustomer,
  createSupplier,
  me,
  passInspection,
  patchSettings,
} from '../support/fixtures';
import { glBalance, ledgerProblems } from '../support/db';
import { reEscape } from '../support/i18n';
import { apiCall, byLabel, emptyState, expect, pickFromCombobox, rowValue, test } from '../support/test';

/**
 * The dealership's core loop on one car, every money step through the UI:
 * purchase (approved by a second person) → preparation cost paid from the cash box → pricing,
 * listing and publishing to the online showroom → reservation with a deposit → installment sale
 * (the deposit counts towards the down payment) → down payment → invoice → delivery → first
 * installment collected → the books balance and the cash box holds exactly the money moved.
 */
test.describe('vehicle journey', () => {
  test.describe.configure({ timeout: 180_000 });

  test('purchase → cost → listing → reservation with deposit → installment sale → collection → ledger', async ({
    page,
    browser,
    owner,
    tr,
    fmt,
    lang,
  }) => {
    // ── Preconditions (API) ──────────────────────────────────────────────────────────────
    await patchSettings(owner, {
      installments: { enabled: true },
      showroom: { enabled: true, showPrices: true },
    });
    const tenant = (await me(owner)).tenant!;
    const box = await createCashAccount(owner, {
      type: 'cashbox',
      name: uniq('Journey box '),
      openingBalance: '20000.00',
    });
    const supplier = await createSupplier(owner);
    const customer = await createCustomer(owner, { fullName: uniq('Installment buyer ') });
    const approverMember = await addMember(owner, 'branch_manager');
    const approver = await ApiClient.login(approverMember.email, approverMember.password);
    const acq = await createAcquisition(owner, { supplierId: supplier.id, approver, price: '70000.00' });
    await approver.dispose();
    const vehicleId = acq.vehicleId;
    await passInspection(owner, vehicleId);
    const detailing = await costCategory(owner, 'detailing');
    const boxOption = `${box.name} · SAR (${tr('sales.payment.accountType.cashbox')})`;
    const vehiclePage = async (tab: string) => {
      await page.goto(`/app/vehicles/${vehicleId}`);
      await page.getByRole('tab', { name: tab }).click();
    };

    // ── Preparation cost, paid now from the cash box ────────────────────────────────────
    await vehiclePage(tr('costs.tab'));
    await page.getByRole('button', { name: tr('costs.actions.add') }).click();
    const costDialog = page.getByRole('dialog').filter({ hasText: tr('costs.form.title') });
    await byLabel(costDialog, tr('costs.form.category')).selectOption({
      label: lang === 'en' ? detailing.nameEn : detailing.nameAr,
    });
    const costText = uniq('Polish and ceramic coat ');
    await byLabel(costDialog, tr('costs.form.description')).fill(costText);
    await byLabel(costDialog, tr('costs.form.amount')).fill('1500.00');
    await costDialog.getByLabel(tr('costs.payNow.toggle')).check();
    await byLabel(costDialog, tr('costs.payNow.account')).selectOption({
      label: `${tr('costs.accountType.cashbox')} · ${box.name} (SAR)`,
    });
    await apiCall(page, 'POST', /\/api\/v1\/vehicle-costs$/, () =>
      costDialog.getByRole('button', { name: tr('costs.form.submit') }).click(),
    );
    await expect(costDialog).toBeHidden();
    await expect(page.getByRole('row').filter({ hasText: costText })).toContainText(fmt('1500.00'));

    // ── Pricing and listing ──────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: tr('vehicles.actions.setPricing') }).click();
    const pricing = page.getByRole('dialog').filter({ hasText: tr('vehicles.pricing.title') });
    await byLabel(pricing, tr('vehicles.askingPrice')).fill('95000.00');
    await byLabel(pricing, tr('vehicles.minPrice')).fill('90000.00');
    await apiCall(page, 'PUT', new RegExp(`/api/v1/vehicles/${vehicleId}/pricing$`), () =>
      pricing.getByRole('button', { name: tr('common.save') }).click(),
    );
    await expect(pricing).toBeHidden();

    await page.getByRole('button', { name: tr('vehicles.actions.changeStatus') }).click();
    const statusDialog = page.getByRole('dialog').filter({ hasText: tr('vehicles.statusChange.title') });
    await byLabel(statusDialog, tr('vehicles.statusChange.to')).selectOption({
      label: VEHICLE_STATUS_LABELS.available[lang],
    });
    await apiCall(page, 'POST', new RegExp(`/api/v1/vehicles/${vehicleId}/status$`), () =>
      statusDialog.getByRole('button', { name: tr('common.confirm') }).click(),
    );
    await expect(statusDialog).toBeHidden();
    await expect(page.getByText(VEHICLE_STATUS_LABELS.available[lang]).first()).toBeVisible();

    await page.getByRole('tab', { name: tr('showroom.tab.label') }).click();
    await apiCall(page, 'POST', new RegExp(`/api/v1/vehicles/${vehicleId}/listing/publish$`), () =>
      page.getByRole('button', { name: tr('showroom.actions.publish') }).click(),
    );
    await expect(page.getByRole('button', { name: tr('showroom.actions.unpublish') })).toBeVisible();
    const shareUrl = (
      await page
        .getByText(/\/showroom\/[^/\s]+\/vehicles\/[0-9a-f-]{36}/)
        .first()
        .innerText()
    ).trim();

    // An anonymous visitor sees the car and its price on the public showroom page.
    const visitor = await browser.newContext({ storageState: emptyState(lang) });
    const pub = await visitor.newPage();
    await pub.goto(shareUrl);
    await expect(pub.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(pub.getByText(fmt('95000.00')).filter({ visible: true }).first()).toBeVisible();
    await expect(pub.getByText(acq.vin)).toHaveCount(0); // the VIN is never public
    await visitor.close();

    // ── Reservation with a 5,000 deposit into the cash box ──────────────────────────────
    await vehiclePage(tr('reservations.vehicleTab.tab'));
    await page.getByRole('button', { name: tr('reservations.vehicleTab.reserve') }).click();
    const resDialog = page.getByRole('dialog').filter({ hasText: tr('reservations.newHint') });
    await pickFromCombobox(
      resDialog.getByRole('combobox', {
        name: new RegExp(`^${reEscape(tr('reservations.fields.customer'))}`),
      }),
      customer.fullName,
      new RegExp(reEscape(customer.fullName)),
    );
    await byLabel(resDialog, tr('reservations.fields.agreedPrice')).fill('95000.00');
    await byLabel(resDialog, tr('reservations.fields.depositAmount')).fill('5000.00');
    await resDialog.getByLabel(tr('reservations.receiveNow')).check();
    // The receivables kit labels account types itself ("receivables.kit.accountType").
    await byLabel(resDialog, tr('receivables.kit.account')).selectOption({
      label: `${box.name} · SAR (${tr('receivables.kit.accountType.cashbox')})`,
    });
    await expect(byLabel(resDialog, tr('receivables.kit.amount'))).toHaveValue('5000.00');
    const reserved = await apiCall(page, 'POST', /\/api\/v1\/reservations$/, () =>
      resDialog.getByRole('button', { name: tr('reservations.reserve') }).click(),
    );
    const reservation = (await reserved.json()) as { id: string; number: string };
    await expect(page).toHaveURL(new RegExp(`/app/reservations/${reservation.id}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(tr('reservations.status.active'));
    await expect(page.getByText(fmt('5000.00')).first()).toBeVisible();
    expect((await cashAccount(owner, box.id)).balance).toBe('23500.00'); // 20,000 − 1,500 + 5,000

    // ── Installment sale to the reserving customer ─────────────────────────────────────
    await vehiclePage(tr('sales.vehicleTab.tab'));
    await page.getByRole('button', { name: tr('sales.vehicleTab.sell') }).click();
    await expect(page.getByText(tr('sales.form.reservedNote'))).toBeVisible();
    await pickFromCombobox(
      page.getByRole('combobox', { name: new RegExp(tr('sales.fields.customer')) }),
      customer.fullName,
      new RegExp(reEscape(customer.fullName)),
    );
    await byLabel(page, tr('sales.fields.agreedPrice')).fill('95000.00');
    await page
      .getByRole('radio', { name: new RegExp(`^${reEscape(tr('sales.paymentType.installments'))}`) })
      .click();
    await byLabel(page, tr('sales.fields.downPayment')).fill('35000.00');
    await byLabel(page, tr('sales.fields.annualRate')).fill('10');
    await expect(byLabel(page, tr('sales.fields.count'))).toHaveValue('12');
    await expect(rowValue(page, tr('sales.fields.financed'))).toHaveText(fmt('60000.00'));
    const created = await apiCall(page, 'POST', /\/api\/v1\/sales$/, () =>
      page.getByRole('button', { name: tr('sales.form.create') }).click(),
    );
    const sale = (await created.json()) as { id: string; number: string };
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(sale.number);

    await page.getByRole('button', { name: tr('sales.actions.confirm') }).click();
    const confirmDialog = page
      .getByRole('dialog')
      .filter({ hasText: tr('sales.confirm.title', { number: sale.number }) });
    await apiCall(page, 'POST', new RegExp(`/api/v1/sales/${sale.id}/confirm$`), () =>
      confirmDialog.getByRole('button', { name: tr('sales.actions.confirm') }).click(),
    );
    await expect(heading).toContainText(tr('sales.status.confirmed'));
    // The reservation deposit now counts towards the 35,000 down payment.
    await expect(rowValue(page, tr('sales.fields.depositTransferred'))).toHaveText(fmt('5000.00'));
    await expect(rowValue(page, tr('sales.money.outstanding'))).toHaveText(fmt('30000.00'));

    await page
      .getByRole('button', { name: tr('sales.actions.recordPayment') })
      .first()
      .click();
    const payDialog = page
      .getByRole('dialog')
      .filter({ hasText: tr('sales.payment.title', { number: sale.number }) });
    await byLabel(payDialog, tr('sales.payment.account')).selectOption({ label: boxOption });
    await expect(byLabel(payDialog, tr('sales.payment.amount'))).toHaveValue('30000.00');
    await apiCall(page, 'POST', /\/api\/v1\/receipts$/, () =>
      payDialog.getByRole('button', { name: tr('sales.payment.submit') }).click(),
    );
    await expect(payDialog).toBeHidden();
    await expect(rowValue(page, tr('sales.money.outstanding'))).toHaveText(fmt('0.00'));

    await page
      .getByRole('button', { name: tr('sales.documents.issue') })
      .first()
      .click();
    const issueDialog = page.getByRole('dialog').filter({ hasText: tr('sales.documents.issueTitle') });
    await byLabel(issueDialog, tr('sales.documents.type')).selectOption({
      label: tr('sales.docType.invoice'),
    });
    await apiCall(page, 'POST', new RegExp(`/api/v1/sales/${sale.id}/documents$`), () =>
      issueDialog.getByRole('button', { name: tr('sales.documents.issue') }).click(),
    );
    await expect(issueDialog).toBeHidden();
    await page.getByRole('button', { name: tr('sales.actions.deliver') }).click();
    const deliverDialog = page
      .getByRole('dialog')
      .filter({ hasText: tr('sales.deliver.title', { number: sale.number }) });
    await apiCall(page, 'POST', new RegExp(`/api/v1/sales/${sale.id}/deliver$`), () =>
      deliverDialog.getByRole('button', { name: tr('sales.actions.deliver') }).click(),
    );
    await expect(heading).toContainText(tr('sales.status.delivered'));

    // The reservation shows it became this sale.
    await page.goto(`/app/reservations/${reservation.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(tr('reservations.status.converted'));

    // ── First installment collected on the plan page ───────────────────────────────────
    await page.goto(`/app/sales/${sale.id}`);
    await page.getByRole('link', { name: tr('sales.detail.openPlan') }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(tr('installments.planStatus.active'));
    await page.getByRole('button', { name: tr('installments.collect.button') }).click();
    const collectDialog = page
      .getByRole('dialog')
      .filter({ hasText: tr('installments.collect.title', { number: sale.number }) });
    await byLabel(collectDialog, tr('sales.payment.account')).selectOption({ label: boxOption });
    const firstInstallment = await byLabel(collectDialog, tr('sales.payment.amount')).inputValue();
    expect(d(firstInstallment).gt(0)).toBe(true);
    await apiCall(page, 'POST', /\/api\/v1\/receipts$/, () =>
      collectDialog.getByRole('button', { name: tr('sales.payment.submit') }).click(),
    );
    await expect(collectDialog).toBeHidden();
    const firstLine = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: '1', exact: true }) });
    await expect(firstLine).toContainText(tr('installments.lineStatus.paid'));

    // ── Money and books ─────────────────────────────────────────────────────────────────
    const expected = d('20000.00')
      .minus('1500.00')
      .plus('5000.00')
      .plus('30000.00')
      .plus(firstInstallment)
      .toFixed(2);
    await page.goto('/app/cash/accounts');
    await expect(page.getByRole('row').filter({ hasText: box.name })).toContainText(fmt(expected));
    expect((await cashAccount(owner, box.id)).balance).toBe(expected);

    await page.goto('/app/accounting?tab=trial');
    await expect(page.getByText(tr('accounting.trial.balancedHint'))).toBeVisible();
    expect(await glBalance(tenant.id, '1100', { col: 'cash_account_id', id: box.id })).toBe(expected);
    expect(await glBalance(tenant.id, '1300', { col: 'vehicle_id', id: vehicleId })).toBe('0.00'); // inventory relieved on delivery
    expect(await glBalance(tenant.id, '2100', { col: 'customer_id', id: customer.id })).toBe('0.00'); // deposit applied
    expect(await ledgerProblems(tenant.id)).toEqual({
      trialBalance: [],
      unbalancedEntries: [],
      cashBookVsGl: [],
      cashRowsWithoutEntry: [],
    });
  });
});
