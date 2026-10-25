import { uniq } from '../support/api';
import { addMember, addMemberWithPermissions, createCustomer, createLead } from '../support/fixtures';
import { apiCall, byLabel, expect, rowValue, test } from '../support/test';

test.describe('lead assignment', () => {
  test('a dispatcher without users.read still picks a salesperson (GET /members/assignable)', async ({
    owner,
    tr,
    signIn,
  }) => {
    // May assign leads, but may not read the member directory.
    const dispatcher = await addMemberWithPermissions(owner, [
      'dashboard.view',
      'customers.read',
      'customers.read_all',
      'leads.read',
      'leads.manage',
      'leads.assign',
    ]);
    const rep = await addMember(owner, 'sales_rep', uniq('Assignable rep '));
    const customer = await createCustomer(owner, { fullName: uniq('Lead customer ') });
    const lead = await createLead(owner, customer.id);
    expect(lead.assignedUserId).toBeNull();

    const { page } = await signIn(dispatcher);
    expect((await page.request.get('/api/v1/users')).status()).toBe(403);

    await page.goto(`/app/leads/${lead.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(lead.number);
    await expect(rowValue(page, tr('leads.fields.assignee')).first()).toHaveText(tr('customers.unassigned'));

    const assignable = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/v1/members/assignable' && r.request().method() === 'GET',
    );
    await page
      .getByRole('button', { name: tr('leads.actions.assign'), exact: true })
      .first()
      .click();
    const res = await assignable;
    expect(res.status()).toBe(200);
    expect(new URL(res.url()).searchParams.get('permission')).toBe('leads.read');
    expect(((await res.json()) as Array<{ id: string }>).map((m) => m.id)).toContain(rep.userId);

    const dialog = page.getByRole('dialog').filter({ hasText: lead.number });
    // Names are wrapped in Unicode isolates so Latin and Arabic text keep their order.
    await byLabel(dialog, tr('leads.fields.assignee')).selectOption({ label: `\u2068${rep.fullName}\u2069` });
    await apiCall(page, 'POST', new RegExp(`/api/v1/leads/${lead.id}/assign$`), () =>
      dialog.getByRole('button', { name: tr('leads.actions.assign'), exact: true }).click(),
    );
    await expect(dialog).toBeHidden();
    await expect(rowValue(page, tr('leads.fields.assignee')).first()).toHaveText(rep.fullName);

    const stored = await owner.json<{ assignedUserId: string | null }>(`/leads/${lead.id}`);
    expect(stored.assignedUserId).toBe(rep.userId);
  });
});
