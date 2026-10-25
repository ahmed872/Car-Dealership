import { d, money } from '@autohub/shared';
import { expectStatus, uniq } from '../support/api';
import { addMember, me } from '../support/fixtures';
import { apiCall, byLabel, expect, mainNav, rowValue, test } from '../support/test';

test.describe('employees and commission policies', () => {
  test('a tiered (marginal) commission policy is created in the UI and its calculator matches an independent computation', async ({
    page,
    tr,
    fmt,
  }) => {
    const code = `tier_${uniq('')}`;
    const name = `Tiered ${code}`;
    // Bands on gross profit: 4 % up to 15,000, 6.5 % up to 40,000, 9.25 % above.
    const saleNet = '180000.00';
    const profit = '52345.67';
    const expected = money(
      d('15000.00')
        .minus('0.00')
        .times('4')
        .dividedBy(100)
        .plus(d('40000.00').minus('15000.00').times('6.5').dividedBy(100))
        .plus(d(profit).minus('40000.00').times('9.25').dividedBy(100)),
      'SAR',
    );
    expect(expected).toBe('3366.97'); // 600 + 1,625 + 1,141.974475, rounded half-up

    await page.goto('/app/commission-policies');
    await expect(page.getByRole('heading', { level: 1, name: tr('employees.policies.title') })).toBeVisible();
    await page
      .getByRole('button', { name: tr('employees.policies.add') })
      .first()
      .click();
    const dialog = page.getByRole('dialog').filter({ hasText: tr('employees.policies.createTitle') });
    await byLabel(dialog, tr('employees.policies.name')).fill(name);
    await byLabel(dialog, tr('employees.policies.code')).fill(code);
    await dialog.getByRole('radio', { name: tr('employees.rule.types.tiered') }).click();
    await byLabel(dialog, tr('employees.rule.tierBase')).selectOption('profit');
    await byLabel(dialog, tr('employees.rule.tierMode')).selectOption('marginal');
    const tiers = dialog.getByRole('group', { name: tr('employees.rule.tiers') });
    await tiers.getByRole('button', { name: tr('employees.rule.addTier') }).click();
    await tiers.getByRole('button', { name: tr('employees.rule.addTier') }).click();
    // Each band is a "from" amount and a rate, in order.
    const cells = tiers.getByRole('textbox');
    await expect(cells).toHaveCount(6);
    const values = ['0.00', '4', '15000.00', '6.5', '40000.00', '9.25'];
    for (const [i, v] of values.entries()) await cells.nth(i).fill(v);

    // The live calculator in the form works on the unsaved rule.
    await byLabel(dialog, tr('employees.preview.saleNet')).fill(saleNet);
    await byLabel(dialog, tr('employees.preview.grossProfit')).fill(profit);
    await apiCall(page, 'POST', /\/api\/v1\/commission-policies\/preview$/, () =>
      dialog.getByRole('button', { name: tr('employees.preview.calculate') }).click(),
    );
    await expect(dialog.getByText(fmt(expected))).toBeVisible();

    const created = await apiCall(page, 'POST', /\/api\/v1\/commission-policies$/, () =>
      dialog.getByRole('button', { name: tr('common.save') }).click(),
    );
    const policy = (await created.json()) as { id: string; rule: { type: string; tierMode: string } };
    expect(policy.rule).toMatchObject({ type: 'tiered', tierMode: 'marginal' });
    await expect(page).toHaveURL(new RegExp(`/app/commission-policies/${code}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
    await expect(
      page
        .getByText(
          tr('employees.rule.summary.tieredMarginal', { base: tr('employees.rule.tierBasesInline.profit') }),
        )
        .first(),
    ).toBeVisible();

    // ── The saved version's calculator ─────────────────────────────────────────────────
    await byLabel(page, tr('employees.preview.saleNet')).fill(saleNet);
    await byLabel(page, tr('employees.preview.grossProfit')).fill(profit);
    const previewed = await apiCall(page, 'POST', /\/api\/v1\/commission-policies\/preview$/, () =>
      page.getByRole('button', { name: tr('employees.preview.calculate') }).click(),
    );
    const result = ((await previewed.json()) as { result: { base: string; amount: string } }).result;
    expect(result).toMatchObject({ base: profit, amount: expected });
    // The result panel (a polite live region, like the toasts — told apart by its labels).
    const output = page.locator('[aria-live="polite"]').filter({ hasText: tr('employees.preview.amount') });
    await expect(output).toContainText(fmt(profit));
    await expect(output).toContainText(fmt(expected));

    // No profit, no commission (the default "require positive profit" condition).
    await byLabel(page, tr('employees.preview.grossProfit')).fill('-250.00');
    await page.getByRole('button', { name: tr('employees.preview.calculate') }).click();
    await expect(output).toContainText(tr('employees.preview.noProfit'));
    await expect(output).toContainText(fmt('0.00'));
  });

  test('the owner sets a rep’s code, target and policy; the rep sees only their own profile', async ({
    page,
    owner,
    tr,
    fmt,
    signIn,
  }) => {
    const code = `pct_${uniq('')}`;
    const policyName = `Profit share ${code}`;
    await expectStatus(
      await owner.post('/commission-policies', {
        code,
        name: policyName,
        rule: { type: 'pct_of_profit', ratePct: '2.5', requirePositiveProfit: true, earnOn: 'full_payment' },
      }),
      201,
      'create commission policy',
    );
    const rep = await addMember(owner, 'sales_rep', uniq('Rep '));
    const ownerId = (await me(owner)).user.id;
    const employeeCode = `E-${uniq('').toUpperCase()}`;

    // ── The owner finds the rep and fills in the profile ───────────────────────────────
    await page.goto('/app/employees');
    await page.getByLabel(tr('common.search')).fill(rep.fullName);
    await page.getByRole('link', { name: rep.fullName }).click();
    await expect(page).toHaveURL(new RegExp(`/app/employees/${rep.userId}$`));
    await expect(page.getByText(tr('employees.profile.notSetUp'))).toBeVisible();
    await page.getByRole('button', { name: tr('employees.profile.edit') }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: tr('employees.profile.editTitle') });
    await byLabel(dialog, tr('employees.fields.employeeCode')).fill(employeeCode);
    await byLabel(dialog, tr('employees.fields.jobTitle')).fill('Sales consultant');
    await byLabel(dialog, tr('employees.fields.monthlyTargetUnits')).fill('6');
    await byLabel(dialog, tr('employees.fields.monthlyTargetAmount')).fill('450000.00');
    await byLabel(dialog, tr('employees.fields.commissionPolicyId')).selectOption({
      label: `${policyName} (${code})`,
    });
    await apiCall(page, 'PUT', new RegExp(`/api/v1/employees/${rep.userId}/profile$`), () =>
      dialog.getByRole('button', { name: tr('common.save') }).click(),
    );
    await expect(dialog).toBeHidden();
    await expect(rowValue(page, tr('employees.fields.employeeCode'))).toHaveText(employeeCode);
    await expect(page.getByText(fmt('450000.00'))).toBeVisible();
    await expect(page.getByText(policyName)).toBeVisible();

    const stored = await owner.json<{
      profile: { employeeCode: string; monthlyTargetUnits: number; monthlyTargetAmount: string };
      policyCode: string;
    }>(`/employees/${rep.userId}`);
    expect(stored.profile).toMatchObject({
      employeeCode,
      monthlyTargetUnits: 6,
      monthlyTargetAmount: '450000.00',
    });
    expect(stored.policyCode).toBe(code);

    // The list shows the code and the policy too.
    await page.goto('/app/employees');
    await page.getByLabel(tr('common.search')).fill(employeeCode);
    const row = page.getByRole('row').filter({ hasText: rep.fullName });
    await expect(row).toContainText(employeeCode);
    await expect(row).toContainText(policyName);

    // ── The rep: own profile yes, the directory no ─────────────────────────────────────
    const { page: rp } = await signIn(rep);
    const nav = await mainNav(rp);
    await expect(nav.getByRole('link', { name: tr('employees.nav') })).toHaveCount(0);
    await nav.getByRole('link', { name: tr('employees.myProfileNav') }).click();
    await expect(rp).toHaveURL(/\/app\/employees\/me$/);
    await expect(rp.getByRole('heading', { level: 1 })).toContainText(tr('employees.profile.myTitle'));
    await expect(rowValue(rp, tr('employees.fields.employeeCode'))).toHaveText(employeeCode);
    await expect(rp.getByText(policyName)).toBeVisible();
    await expect(rp.getByText(fmt('450000.00'))).toBeVisible();
    // Read-only for them.
    await expect(rp.getByRole('button', { name: tr('employees.profile.edit') })).toHaveCount(0);

    for (const path of ['/app/employees', `/app/employees/${ownerId}`]) {
      await rp.goto(path);
      await expect(rp.getByRole('heading', { name: tr('errors.forbidden') }), path).toBeVisible();
    }
    expect((await rp.request.get('/api/v1/employees')).status()).toBe(403);
    expect((await rp.request.get(`/api/v1/employees/${ownerId}`)).status()).toBe(403);
    expect((await rp.request.get(`/api/v1/employees/${rep.userId}`)).status()).toBe(200);
  });
});
