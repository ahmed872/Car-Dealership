import type { Page } from '@playwright/test';
import { expectStatus, uniq } from '../support/api';
import {
  addMember,
  availableVehicle,
  createCustomer,
  mainBranchId,
  type Member,
  tenantSettings,
} from '../support/fixtures';
import { reEscape, type Translate } from '../support/i18n';
import { apiCall, byLabel, expect, pickFromCombobox, rowValue, test } from '../support/test';

const MINUTE = 60_000;

/** Wall-clock date and time ('HH:MM') of an instant in the company's time zone. */
function wallClock(at: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** The instant of a wall-clock date + time in the zone (what the booking form sends). */
function zonedInstant(date: string, time: string, tz: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  const shown = wallClock(guess, tz);
  const offset = new Date(`${shown.date}T${shown.time}:00Z`).getTime() - guess.getTime();
  return new Date(guess.getTime() - offset);
}

interface Booking {
  customer: { fullName: string };
  vehicle: { stockNumber: string };
  date: string;
  start: string;
  end: string;
  /** Assignee option label, or null for "unassigned". */
  assignee: string | null;
}

/** Opens "Test drive" on the calendar page and fills the booking form (not submitted). */
async function fillTestDrive(page: Page, tr: Translate, b: Booking) {
  await page.getByRole('button', { name: tr('appointments.newTestDrive'), exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: tr('appointments.newTitle') });
  await expect(byLabel(dialog, tr('appointments.fields.type'))).toHaveValue('test_drive');
  // The customer picker has no visible label of its own (the fieldset legend names the group).
  await pickFromCombobox(
    dialog.getByPlaceholder(tr('receivables.kit.customerSearch')),
    b.customer.fullName,
    new RegExp(reEscape(b.customer.fullName)),
  );
  await pickFromCombobox(
    byLabel(dialog, tr('appointments.fields.vehicle')),
    b.vehicle.stockNumber,
    new RegExp(reEscape(b.vehicle.stockNumber)),
  );
  await byLabel(dialog, tr('appointments.fields.date')).fill(b.date);
  await byLabel(dialog, tr('appointments.fields.start')).fill(b.start);
  await byLabel(dialog, tr('appointments.fields.end')).fill(b.end);
  await byLabel(dialog, tr('appointments.fields.assignee')).selectOption({
    label: b.assignee ?? tr('appointments.unassigned'),
  });
  await byLabel(dialog, tr('appointments.fields.licenceNumber')).fill('DL-778899');
  await byLabel(dialog, tr('appointments.fields.licenceExpiry')).fill('2030-12-31');
  return dialog;
}

test.describe('appointments and test drives', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a test drive is booked on the calendar, confirmed, driven and returned; the car’s odometer follows', async ({
    page,
    owner,
    tr,
  }) => {
    const { timezone } = await tenantSettings(owner);
    const vehicle = await availableVehicle(owner);
    const customer = await createCustomer(owner, { fullName: uniq('Test driver ') });
    const other = await createCustomer(owner, { fullName: uniq('Second driver ') });
    // A dedicated salesperson, so the booking never collides with another test's staff calendar.
    const rep: Member = await addMember(owner, 'sales_rep');
    const before = await owner.json<{ vehicle: { odometerValue: number } }>(`/vehicles/${vehicle.id}`);
    const odometerOut = before.vehicle.odometerValue;

    // Now, rounded down to five minutes (bookings may start up to 15 minutes in the past, and a
    // test drive may start at most 30 minutes early). A slot crossing midnight ends at 23:59.
    const startAt = new Date(Math.floor(Date.now() / (5 * MINUTE)) * 5 * MINUTE);
    const slot = wallClock(startAt, timezone);
    const endWall = wallClock(new Date(startAt.getTime() + 30 * MINUTE), timezone);
    const end = endWall.date === slot.date ? endWall.time : '23:59';

    // ── Book through the calendar ──────────────────────────────────────────────────────
    await page.goto('/app/appointments');
    await expect(page.getByRole('heading', { level: 1, name: tr('appointments.title') })).toBeVisible();
    const dialog = await fillTestDrive(page, tr, {
      customer,
      vehicle,
      date: slot.date,
      start: slot.time,
      end,
      assignee: rep.fullName,
    });
    const booked = await apiCall(page, 'POST', /\/api\/v1\/appointments$/, () =>
      dialog.getByRole('button', { name: tr('appointments.book') }).click(),
    );
    const drive = (await booked.json()) as { id: string; startsAt: string; assignedUserId: string };
    expect(new Date(drive.startsAt).toISOString()).toBe(
      zonedInstant(slot.date, slot.time, timezone).toISOString(),
    );
    expect(drive.assignedUserId).toBe(rep.userId);
    await expect(page).toHaveURL(new RegExp(`/app/appointments/${drive.id}$`));
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(tr('appointments.status.scheduled'));
    await expect(rowValue(page, tr('appointments.fields.customer'))).toContainText(customer.fullName);
    await expect(rowValue(page, tr('appointments.fields.assignee'))).toHaveText(rep.fullName);

    // ── Confirm with the customer ──────────────────────────────────────────────────────
    await page.getByRole('button', { name: tr('appointments.actions.confirm'), exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: tr('appointments.confirmMessage') });
    await apiCall(page, 'POST', new RegExp(`/api/v1/appointments/${drive.id}/confirm$`), () =>
      confirm.getByRole('button', { name: tr('appointments.actions.confirm'), exact: true }).click(),
    );
    await expect(confirm).toBeHidden();
    await expect(heading).toContainText(tr('appointments.status.confirmed'));

    // ── The calendar shows it; the same car at the same time is refused ────────────────
    await page.goto('/app/appointments');
    await expect(page.getByRole('button', { name: new RegExp(reEscape(customer.fullName)) })).toBeVisible();
    const clash = await fillTestDrive(page, tr, {
      customer: other,
      vehicle,
      date: slot.date,
      start: slot.time,
      end,
      assignee: null, // nobody's calendar is busy: only the vehicle is
    });
    await apiCall(
      page,
      'POST',
      /\/api\/v1\/appointments$/,
      () => clash.getByRole('button', { name: tr('appointments.book') }).click(),
      [409],
    );
    await expect(
      clash.getByRole('alert').filter({ hasText: tr('appointments.errors.vehicle_busy') }),
    ).toBeVisible();
    await clash.getByRole('button', { name: tr('common.cancel') }).click();
    await expect(clash).toBeHidden();

    // ── Hand over: odometer out (prefilled with the car's last reading) ────────────────
    await page.goto(`/app/appointments/${drive.id}`);
    await page.getByRole('button', { name: tr('appointments.actions.start') }).click();
    const start = page.getByRole('dialog').filter({ hasText: tr('appointments.startHint') });
    const out = byLabel(start, tr('appointments.fields.odometerOut', { unit: tr('appointments.units.km') }));
    await expect(out).toHaveValue(String(odometerOut));
    await expect(byLabel(start, tr('appointments.fields.licenceNumber'))).toHaveValue('DL-778899');
    await apiCall(page, 'POST', new RegExp(`/api/v1/appointments/${drive.id}/start-test-drive$`), () =>
      start.getByRole('button', { name: tr('appointments.startConfirm') }).click(),
    );
    await expect(start).toBeHidden();
    await expect(heading).toContainText(tr('appointments.status.in_progress'));
    await expect(page.getByText(tr('appointments.onTheRoadHint'))).toBeVisible();

    // ── Take back: odometer in and the outcome ─────────────────────────────────────────
    const odometerIn = odometerOut + 42;
    await page.getByRole('button', { name: tr('appointments.actions.finish') }).click();
    const finish = page.getByRole('dialog').filter({ hasText: tr('appointments.finishTitle') });
    await byLabel(finish, tr('appointments.fields.odometerIn')).fill(String(odometerIn));
    await expect(finish.getByText(`${tr('appointments.distance')}: 42`)).toBeVisible();
    const outcome = `Liked it, wants a trade-in offer ${uniq('')}`;
    await byLabel(finish, tr('appointments.fields.outcome')).fill(outcome);
    await apiCall(page, 'POST', new RegExp(`/api/v1/appointments/${drive.id}/finish-test-drive$`), () =>
      finish.getByRole('button', { name: tr('appointments.finishConfirm') }).click(),
    );
    await expect(finish).toBeHidden();
    await expect(heading).toContainText(tr('appointments.status.completed'));
    await expect(rowValue(page, tr('appointments.distance'))).toHaveText('42');
    await expect(rowValue(page, tr('appointments.fields.outcome')).first()).toHaveText(outcome);

    // The vehicle now carries the returned reading.
    const after = await owner.json<{ vehicle: { odometerValue: number } }>(`/vehicles/${vehicle.id}`);
    expect(after.vehicle.odometerValue).toBe(odometerIn);
  });

  test('a booked test drive is rescheduled (back to “scheduled”) and cancelled with a reason', async ({
    page,
    owner,
    tr,
  }) => {
    const { timezone } = await tenantSettings(owner);
    const vehicle = await availableVehicle(owner);
    const customer = await createCustomer(owner, { fullName: uniq('Rebooking ') });
    const rep = await addMember(owner, 'sales_rep');
    const tomorrow = wallClock(new Date(Date.now() + 24 * 60 * MINUTE), timezone).date;

    // A confirmed test drive tomorrow 10:00–10:30 (precondition through the API).
    const created = await expectStatus<{ id: string; version: number }>(
      await owner.post('/appointments', {
        type: 'test_drive',
        branchId: await mainBranchId(owner),
        customerId: customer.id,
        vehicleId: vehicle.id,
        assignedUserId: rep.userId,
        startsAt: zonedInstant(tomorrow, '10:00', timezone).toISOString(),
        endsAt: zonedInstant(tomorrow, '10:30', timezone).toISOString(),
      }),
      201,
      'book test drive',
    );
    await expectStatus(
      await owner.post(`/appointments/${created.id}/confirm`, { version: created.version }),
      200,
      'confirm',
    );

    await page.goto(`/app/appointments/${created.id}`);
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(tr('appointments.status.confirmed'));

    // ── Reschedule: moving the start keeps the 30-minute duration ──────────────────────
    await page.getByRole('button', { name: tr('appointments.actions.reschedule') }).click();
    const edit = page.getByRole('dialog').filter({ hasText: tr('appointments.editHint') });
    await expect(byLabel(edit, tr('appointments.fields.start'))).toHaveValue('10:00');
    await byLabel(edit, tr('appointments.fields.start')).fill('11:30');
    await expect(byLabel(edit, tr('appointments.fields.end'))).toHaveValue('12:00');
    const saved = await apiCall(page, 'PATCH', new RegExp(`/api/v1/appointments/${created.id}$`), () =>
      edit.getByRole('button', { name: tr('common.save') }).click(),
    );
    const moved = (await saved.json()) as { startsAt: string; endsAt: string; status: string };
    expect(new Date(moved.startsAt).toISOString()).toBe(
      zonedInstant(tomorrow, '11:30', timezone).toISOString(),
    );
    expect(new Date(moved.endsAt).toISOString()).toBe(
      zonedInstant(tomorrow, '12:00', timezone).toISOString(),
    );
    await expect(edit).toBeHidden();
    // A new time needs the customer's confirmation again.
    await expect(heading).toContainText(tr('appointments.status.scheduled'));
    await expect(rowValue(page, tr('appointments.fields.when'))).toContainText('11:30');

    // ── Cancel: the reason is required and shown afterwards ────────────────────────────
    await page.getByRole('button', { name: tr('appointments.actions.cancel') }).click();
    const cancel = page.getByRole('dialog').filter({ hasText: tr('appointments.cancelMessage') });
    const confirmCancel = cancel.getByRole('button', { name: tr('appointments.actions.cancel') });
    await expect(confirmCancel).toBeDisabled();
    const reason = `Customer travelling ${uniq('')}`;
    await byLabel(cancel, tr('common.reason')).fill(reason);
    await apiCall(page, 'POST', new RegExp(`/api/v1/appointments/${created.id}/cancel$`), () =>
      confirmCancel.click(),
    );
    await expect(cancel).toBeHidden();
    await expect(heading).toContainText(tr('appointments.status.cancelled'));
    await expect(page.getByRole('status').filter({ hasText: reason })).toContainText(
      tr('appointments.cancelledTitle'),
    );
    const stored = await owner.json<{ status: string; cancelReason: string }>(`/appointments/${created.id}`);
    expect(stored).toMatchObject({ status: 'cancelled', cancelReason: reason });
    // Nothing is left to do on a cancelled booking.
    await expect(page.getByRole('button', { name: tr('appointments.actions.reschedule') })).toHaveCount(0);
  });
});
