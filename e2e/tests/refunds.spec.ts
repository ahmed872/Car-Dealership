import { d, money } from '@autohub/shared';
import { uniq } from '../support/api';
import {
  addMember,
  availableVehicle,
  cashAccount,
  createCashAccount,
  createCustomer,
  createReservation,
  me,
  tenantSettings,
} from '../support/fixtures';
import { glBalance, ledgerProblems } from '../support/db';
import { apiCall, byLabel, expect, test } from '../support/test';

test.describe('refunds', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a cancelled reservation’s deposit is refunded per policy: requested, approved by someone else, paid from the cash box', async ({
    page,
    owner,
    tr,
    fmt,
    signIn,
  }) => {
    // ── Preconditions: a 2,345.67 deposit held under a 35 % refundable policy ──────────
    const tenant = (await me(owner)).tenant!;
    const { rounding } = await tenantSettings(owner);
    const box = await createCashAccount(owner, {
      type: 'cashbox',
      name: uniq('Refund box '),
      openingBalance: '10000.00',
    });
    const customer = await createCustomer(owner, { fullName: uniq('Refunded customer ') });
    const vehicle = await availableVehicle(owner);
    const deposit = '2345.67';
    const reservation = await createReservation(owner, {
      vehicleId: vehicle.id,
      customerId: customer.id,
      depositAmount: deposit,
      refundPolicy: 'partial',
      refundablePct: '35',
      depositInto: box.id,
    });
    expect(reservation.receipt).not.toBeNull();
    const held = d('10000.00').plus(deposit).toFixed(2);
    expect((await cashAccount(owner, box.id)).balance).toBe(held);
    // Computed independently of the API: 35 % of the deposit in the company's rounding mode.
    const refund = money(d(deposit).times('35').dividedBy(100), 'SAR', rounding);
    const forfeit = d(deposit).minus(refund).toFixed(2);
    const manager = await addMember(owner, 'branch_manager');

    // ── The owner cancels the reservation with a refund per policy ─────────────────────
    await page.goto(`/app/reservations/${reservation.id}`);
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(tr('reservations.status.active'));
    await page.getByRole('button', { name: tr('reservations.cancel') }).click();
    const cancel = page
      .getByRole('dialog')
      .filter({ hasText: tr('reservations.cancelTitle', { number: reservation.number }) });
    await expect(cancel.getByRole('radio').first()).toBeChecked(); // "per policy" is the default
    await expect(cancel.getByText(fmt(refund))).toBeVisible();
    await expect(cancel.getByText(fmt(forfeit))).toBeVisible();
    await byLabel(cancel, tr('common.reason')).fill(`Customer changed plans ${uniq('')}`);
    const cancelled = await apiCall(
      page,
      'POST',
      new RegExp(`/api/v1/reservations/${reservation.id}/cancel$`),
      () => cancel.getByRole('button', { name: tr('reservations.cancelConfirm') }).click(),
    );
    const body = (await cancelled.json()) as { refund: { id: string; number: string; amountBase: string } };
    expect(body.refund.amountBase).toBe(refund);
    const refundNo = body.refund.number;
    await expect(cancel).toBeHidden();
    await expect(heading).toContainText(tr('reservations.status.cancelled'));
    const refundRow = page.getByRole('row').filter({ hasText: refundNo });
    await expect(refundRow).toContainText(tr('receivables.refundStatus.requested'));
    await expect(refundRow).toContainText(fmt(refund));
    // Cancelling moves no cash: the refund still needs approval and payment.
    expect((await cashAccount(owner, box.id)).balance).toBe(held);

    // ── Maker-checker: the requester cannot approve their own request ──────────────────
    await refundRow.getByRole('button', { name: tr('common.approve') }).click();
    const selfApprove = page
      .getByRole('dialog')
      .filter({ hasText: tr('receivables.refunds.approveTitle', { number: refundNo }) });
    await expect(selfApprove.getByText(tr('receivables.refunds.selfRequestedHint'))).toBeVisible();
    await apiCall(
      page,
      'POST',
      new RegExp(`/api/v1/refunds/${body.refund.id}/approve$`),
      () => selfApprove.getByRole('button', { name: tr('receivables.refunds.approveConfirm') }).click(),
      [403],
    );
    await expect(
      selfApprove.getByRole('alert').filter({ hasText: tr('receivables.errors.self_approval_forbidden') }),
    ).toBeVisible();
    await selfApprove.getByRole('button', { name: tr('common.cancel') }).click();
    await expect(refundRow).toContainText(tr('receivables.refundStatus.requested'));

    // ── A branch manager finds it by number, approves and pays it ──────────────────────
    const { page: mp } = await signIn(manager);
    await mp.goto('/app/refunds');
    await expect(mp.getByRole('heading', { level: 1, name: tr('receivables.refunds.title') })).toBeVisible();
    await mp.getByLabel(tr('common.search')).fill(refundNo);
    await expect(mp).toHaveURL(new RegExp(`[?&]q=${refundNo}`));
    const row = mp.getByRole('row').filter({ hasText: refundNo });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(customer.fullName);
    await expect(row).toContainText(tr('receivables.refundStatus.requested'));
    await row.getByRole('button', { name: tr('common.approve') }).click();
    const approve = mp
      .getByRole('dialog')
      .filter({ hasText: tr('receivables.refunds.approveTitle', { number: refundNo }) });
    await expect(approve.getByText(tr('receivables.refunds.selfRequestedHint'))).toHaveCount(0);
    await byLabel(approve, tr('receivables.refunds.note')).fill('Checked against the cancellation policy');
    await apiCall(mp, 'POST', new RegExp(`/api/v1/refunds/${body.refund.id}/approve$`), () =>
      approve.getByRole('button', { name: tr('receivables.refunds.approveConfirm') }).click(),
    );
    await expect(approve).toBeHidden();

    await mp.goto(`/app/refunds?status=approved&q=${refundNo}`);
    const approvedRow = mp.getByRole('row').filter({ hasText: refundNo });
    await expect(approvedRow).toContainText(tr('receivables.refundStatus.approved'));
    await approvedRow.getByRole('button', { name: tr('receivables.refunds.pay') }).click();
    const pay = mp
      .getByRole('dialog')
      .filter({ hasText: tr('receivables.refunds.payTitle', { number: refundNo }) });
    await expect(pay.getByText(fmt(refund))).toBeVisible();
    await byLabel(pay, tr('receivables.kit.account')).selectOption({
      label: `${box.name} · SAR (${tr('receivables.kit.accountType.cashbox')})`,
    });
    await apiCall(mp, 'POST', new RegExp(`/api/v1/refunds/${body.refund.id}/pay$`), () =>
      pay.getByRole('button', { name: tr('receivables.refunds.payConfirm') }).click(),
    );
    await expect(pay).toBeHidden();

    // ── Lists show the right states ────────────────────────────────────────────────────
    await mp.goto(`/app/refunds?status=all&q=${refundNo}`);
    await expect(mp.getByRole('row').filter({ hasText: refundNo })).toContainText(
      tr('receivables.refundStatus.paid'),
    );
    // Nothing else matches the number; another number finds nothing.
    await expect(mp.getByRole('row').filter({ hasText: refundNo })).toHaveCount(1);
    await mp.goto(`/app/refunds?status=all&q=${refundNo}9`);
    await expect(mp.getByText(tr('receivables.refunds.empty'))).toBeVisible();

    // The deposit receipt itself stays posted (the refund is a separate payment out).
    await page.goto('/app/receipts');
    await expect(page.getByRole('row').filter({ hasText: reservation.receipt!.number })).toContainText(
      tr('receivables.receiptStatus.posted'),
    );
    await page.goto(`/app/reservations/${reservation.id}`);
    await expect(page.getByRole('row').filter({ hasText: refundNo })).toContainText(
      tr('receivables.refundStatus.paid'),
    );

    // ── Money: the box lost exactly the refund; the customer's advances are cleared ────
    const expected = d(held).minus(refund).toFixed(2);
    await page.goto('/app/cash/accounts');
    await expect(page.getByRole('row').filter({ hasText: box.name })).toContainText(fmt(expected));
    expect((await cashAccount(owner, box.id)).balance).toBe(expected);
    expect(await glBalance(tenant.id, '1100', { col: 'cash_account_id', id: box.id })).toBe(expected);
    // Deposit (credit) − forfeit − refund paid = 0 on 2100 for this customer.
    expect(await glBalance(tenant.id, '2100', { col: 'customer_id', id: customer.id })).toBe('0.00');
    expect(await ledgerProblems(tenant.id)).toEqual({
      trialBalance: [],
      unbalancedEntries: [],
      cashBookVsGl: [],
      cashRowsWithoutEntry: [],
    });
  });
});
