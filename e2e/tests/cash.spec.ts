import { uniq } from '../support/api';
import { cashAccount, createCashAccount, me } from '../support/fixtures';
import { ledgerProblems } from '../support/db';
import { apiCall, byLabel, expect, test } from '../support/test';

test.describe('cash and bank', () => {
  test('a transfer moves exactly the amount between accounts and its reversal needs a reason', async ({
    page,
    owner,
    tr,
    fmt,
  }) => {
    const box = await createCashAccount(owner, {
      type: 'cashbox',
      name: uniq('Box '),
      openingBalance: '5000.00',
    });
    const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Bank '), bankName: 'Al Rajhi' });
    const row = (name: string) => page.getByRole('row').filter({ hasText: name });

    await page.goto('/app/cash/accounts');
    await expect(row(box.name)).toContainText(fmt('5000.00'));
    await expect(row(bank.name)).toContainText(fmt('0.00'));

    // ── Transfer through the form ─────────────────────────────────────────────────────────
    await page.getByRole('button', { name: tr('cash.transfers.add') }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: tr('cash.transfers.addTitle') });
    // Options read "<name> · <balance>" — the formatted balance is part of what the user picks from.
    await byLabel(dialog, tr('cash.transfers.fromAccount')).selectOption({
      label: `${box.name} · ${fmt('5000.00')}`,
    });
    await byLabel(dialog, tr('cash.transfers.toAccount')).selectOption({
      label: `${bank.name} · ${fmt('0.00')}`,
    });
    await byLabel(dialog, tr('cash.transfers.amountSent')).fill('1250.50');
    await byLabel(dialog, tr('common.reference')).fill('E2E-TRF');
    const created = await apiCall(page, 'POST', /\/api\/v1\/cash\/transfers$/, () =>
      dialog.getByRole('button', { name: tr('cash.transfers.submit') }).click(),
    );
    const { transferId } = (await created.json()) as { transferId: string };
    await expect(page).toHaveURL(new RegExp(`/app/cash/transfers/${transferId}$`));
    await expect(page.getByText(fmt('1250.50')).first()).toBeVisible();

    // Balances on the account pages and in the API agree.
    await page.getByRole('link', { name: box.name }).click();
    await expect(page.getByRole('heading', { level: 1, name: box.name })).toBeVisible();
    await expect(page.getByText(fmt('3749.50')).first()).toBeVisible();
    await page.goto('/app/cash/accounts');
    await expect(row(box.name)).toContainText(fmt('3749.50'));
    await expect(row(bank.name)).toContainText(fmt('1250.50'));
    expect((await cashAccount(owner, box.id)).balance).toBe('3749.50');
    expect((await cashAccount(owner, bank.id)).balance).toBe('1250.50');

    // ── Reversal: the confirm button stays disabled until a reason is written ──────────────
    await page.goto(`/app/cash/transfers/${transferId}`);
    await page.getByRole('button', { name: tr('cash.transfers.reverse') }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: tr('cash.transfers.reverseTitle') });
    const confirmButton = confirm.getByRole('button', { name: tr('cash.transfers.reverse') });
    await expect(confirmButton).toBeDisabled();
    await byLabel(confirm, tr('common.reason')).fill('ab');
    await expect(confirmButton).toBeDisabled();
    const reason = `Entered twice ${uniq('')}`;
    await byLabel(confirm, tr('common.reason')).fill(reason);
    await expect(confirmButton).toBeEnabled();
    await apiCall(page, 'POST', new RegExp(`/api/v1/cash/transfers/${transferId}/reverse$`), () =>
      confirmButton.click(),
    );
    await expect(confirm).toBeHidden();
    const reversed = page.getByRole('status').filter({ hasText: reason });
    await expect(reversed).toContainText(tr('common.reason'));

    await page.goto('/app/cash/accounts');
    await expect(row(box.name)).toContainText(fmt('5000.00'));
    await expect(row(bank.name)).toContainText(fmt('0.00'));
    expect((await cashAccount(owner, box.id)).balance).toBe('5000.00');
    expect((await cashAccount(owner, bank.id)).balance).toBe('0.00');

    // Cash book = GL 1100 for every account, every entry balanced.
    const tenant = (await me(owner)).tenant!;
    expect(await ledgerProblems(tenant.id)).toEqual({
      trialBalance: [],
      unbalancedEntries: [],
      cashBookVsGl: [],
      cashRowsWithoutEntry: [],
    });
  });
});
