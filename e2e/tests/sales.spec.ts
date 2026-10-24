import { uniq } from '../support/api';
import { availableVehicle, cashAccount, createCashAccount, createCustomer, me } from '../support/fixtures';
import { glBalance, ledgerProblems } from '../support/db';
import { ARABIC } from '../support/i18n';
import { apiCall, byLabel, expect, pickFromCombobox, rowValue, test } from '../support/test';

test.describe('sales', () => {
  test('a cash sale goes draft → confirmed → paid → invoiced → delivered and the money lands in the cash box', async ({
    page,
    owner,
    tr,
    fmt,
    lang,
  }) => {
    const vehicle = await availableVehicle(owner, '98500.00');
    const customer = await createCustomer(owner, { fullName: uniq('Buyer ') });
    const box = await createCashAccount(owner, {
      type: 'cashbox',
      name: uniq('Showroom box '),
      openingBalance: '1000.00',
    });
    const tenant = (await me(owner)).tenant!;

    // ── From the vehicle page to a draft sale ───────────────────────────────────────────
    await page.goto(`/app/vehicles/${vehicle.id}`);
    await page.getByRole('tab', { name: tr('sales.vehicleTab.tab') }).click();
    await page.getByRole('button', { name: tr('sales.vehicleTab.sell') }).click();
    await expect(page).toHaveURL(new RegExp(`/app/sales/new\\?vehicleId=${vehicle.id}$`));
    await expect(page.getByText(vehicle.stockNumber).first()).toBeVisible();
    await pickFromCombobox(
      page.getByRole('combobox', { name: new RegExp(tr('sales.fields.customer')) }),
      customer.fullName,
      new RegExp(customer.fullName),
    );
    await byLabel(page, tr('sales.fields.agreedPrice')).fill('98500.00');
    // The live calculation (prices include 15% VAT in Saudi Arabia): gross = agreed price.
    await expect(rowValue(page, tr('sales.fields.dueBeforeDelivery'))).toHaveText(fmt('98500.00'));
    const created = await apiCall(page, 'POST', /\/api\/v1\/sales$/, () =>
      page.getByRole('button', { name: tr('sales.form.create') }).click(),
    );
    const sale = (await created.json()) as { id: string; number: string; grossAmount: string };
    expect(sale.grossAmount).toBe('98500.00');
    await expect(page).toHaveURL(new RegExp(`/app/sales/${sale.id}$`));
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(sale.number);
    await expect(heading).toContainText(tr('sales.status.draft'));

    // ── Confirm ──────────────────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: tr('sales.actions.confirm') }).click();
    const confirmDialog = page
      .getByRole('dialog')
      .filter({ hasText: tr('sales.confirm.title', { number: sale.number }) });
    await apiCall(page, 'POST', new RegExp(`/api/v1/sales/${sale.id}/confirm$`), () =>
      confirmDialog.getByRole('button', { name: tr('sales.actions.confirm') }).click(),
    );
    await expect(heading).toContainText(tr('sales.status.confirmed'));
    await expect(rowValue(page, tr('sales.money.outstanding'))).toHaveText(fmt('98500.00'));

    // ── Record the payment into our cash box ───────────────────────────────────────────
    await page
      .getByRole('button', { name: tr('sales.actions.recordPayment') })
      .first()
      .click();
    const payDialog = page
      .getByRole('dialog')
      .filter({ hasText: tr('sales.payment.title', { number: sale.number }) });
    await byLabel(payDialog, tr('sales.payment.account')).selectOption({
      label: `${box.name} · SAR (${tr('sales.payment.accountType.cashbox')})`,
    });
    await expect(byLabel(payDialog, tr('sales.payment.amount'))).toHaveValue('98500.00');
    const receipt = await apiCall(page, 'POST', /\/api\/v1\/receipts$/, () =>
      payDialog.getByRole('button', { name: tr('sales.payment.submit') }).click(),
    );
    const receiptNumber = ((await receipt.json()) as { number: string }).number;
    await expect(payDialog).toBeHidden();
    await expect(rowValue(page, tr('sales.money.outstanding'))).toHaveText(fmt('0.00'));
    await expect(page.getByRole('row').filter({ hasText: receiptNumber })).toContainText(fmt('98500.00'));

    // ── Invoice, then delivery ───────────────────────────────────────────────────────────
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
    await expect(page.getByRole('row').filter({ hasText: tr('sales.docType.invoice') })).toContainText(
      tr('sales.docStatus.issued'),
    );

    await page.getByRole('button', { name: tr('sales.actions.deliver') }).click();
    const deliverDialog = page
      .getByRole('dialog')
      .filter({ hasText: tr('sales.deliver.title', { number: sale.number }) });
    await expect(deliverDialog.getByText(tr('sales.deliver.ready'))).toBeVisible();
    await apiCall(page, 'POST', new RegExp(`/api/v1/sales/${sale.id}/deliver$`), () =>
      deliverDialog.getByRole('button', { name: tr('sales.actions.deliver') }).click(),
    );
    await expect(heading).toContainText(tr('sales.status.delivered'));
    await expect(rowValue(page, tr('sales.money.outstanding'))).toHaveText(fmt('0.00'));
    await expect(rowValue(page, tr('sales.money.receivable'))).toHaveText(fmt('0.00'));
    await expect(rowValue(page, tr('sales.money.held'))).toHaveText(fmt('98500.00'));

    // Money is formatted for the language; digits stay Latin in both (apps/web/src/lib/format.ts).
    const gross = await rowValue(page, tr('sales.fields.gross')).first().innerText();
    expect(gross).toBe(fmt('98500.00'));
    expect(gross).not.toMatch(/[٠-٩]/);
    expect(gross).toMatch(lang === 'ar' ? /^⁦[\d,]+\.\d{2}⁩ ر\.س$/ : /^SAR ⁦[\d,]+\.\d{2}⁩$/);
    expect(ARABIC.test(await heading.innerText())).toBe(lang === 'ar');

    // ── The cash box grew by exactly the payment (UI and API agree) ─────────────────────
    await page.goto('/app/cash/accounts');
    await expect(page.getByRole('row').filter({ hasText: box.name })).toContainText(fmt('99500.00'));
    expect((await cashAccount(owner, box.id)).balance).toBe('99500.00');

    // The receipt is listed on the receipts page (Phase 4).
    await page.goto('/app/receipts');
    await expect(page.getByRole('row').filter({ hasText: receiptNumber })).toContainText(fmt('98500.00'));

    // Books: the customer's advances are consumed (2100 = 0 for this customer), cash book = GL.
    expect(await glBalance(tenant.id, '2100', { col: 'customer_id', id: customer.id })).toBe('0.00');
    expect(await ledgerProblems(tenant.id)).toEqual({
      trialBalance: [],
      unbalancedEntries: [],
      cashBookVsGl: [],
      cashRowsWithoutEntry: [],
    });
  });
});
