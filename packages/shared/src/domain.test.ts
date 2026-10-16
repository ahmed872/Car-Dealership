import { describe, expect, it } from 'vitest';
import { checkTransition, VEHICLE_STATUSES, VEHICLE_TRANSITIONS } from './vehicle-lifecycle';
import { computeVinCheckDigit, validateVin } from './vin';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from './permissions';
import { normalizePhone } from './markets';
import { defaultTenantSettings } from './schemas/admin';
import { zTenantSettings, zMoneyPos, zMoney } from './schemas/common';

describe('vehicle lifecycle', () => {
  it('allows workflow transitions only for the system', () => {
    expect(checkTransition('available', 'reserved', true)).toEqual({ ok: true });
    expect(checkTransition('available', 'reserved', false)).toEqual({ ok: false, reason: 'system_only' });
    expect(checkTransition('sold', 'available', false).ok).toBe(false);
    expect(checkTransition('reserved', 'available', false).ok).toBe(false);
    expect(checkTransition('reserved', 'available', true).ok).toBe(true);
  });
  it('rejects impossible transitions', () => {
    expect(checkTransition('delivered', 'available', true)).toEqual({ ok: false, reason: 'not_allowed' });
    expect(checkTransition('sold', 'reserved', true).ok).toBe(false);
    expect(checkTransition('removed', 'available', true).ok).toBe(false);
    expect(checkTransition('available', 'available', true)).toEqual({ ok: false, reason: 'same_status' });
    expect(checkTransition('incoming', 'sold', true).ok).toBe(false);
  });
  it('lets staff move a returned vehicle back into preparation', () => {
    expect(checkTransition('returned', 'in_preparation', false).ok).toBe(true);
  });
  it('transition table only references known states', () => {
    for (const [from, tos] of Object.entries(VEHICLE_TRANSITIONS)) {
      expect(VEHICLE_STATUSES).toContain(from);
      for (const to of tos) expect(VEHICLE_STATUSES).toContain(to);
    }
  });
});

describe('VIN', () => {
  it('validates known VINs and check digits', () => {
    expect(computeVinCheckDigit('1M8GDM9AXKP042788')).toBe('X');
    expect(validateVin('1M8GDM9AXKP042788', { enforceCheckDigit: true }).valid).toBe(true);
    expect(validateVin('1hgcm82633a004352').normalized).toBe('1HGCM82633A004352');
    expect(validateVin('1HGCM82633A004352', { enforceCheckDigit: true }).valid).toBe(true);
  });
  it('treats check digit as warning outside North America', () => {
    const r = validateVin('JTDKN3DU0A0123456');
    expect(r.valid).toBe(true);
    expect(r.warnings).toContain('check_digit');
    expect(validateVin('JTDKN3DU0A0123456', { enforceCheckDigit: true }).valid).toBe(false);
  });
  it('rejects bad length and I/O/Q', () => {
    expect(validateVin('ABC').errors).toContain('length');
    expect(validateVin('1HGCM82633A00435O').errors).toContain('invalid_characters');
  });
  it('decodes possible model years', () => {
    expect(validateVin('1HGCM82633A004352').possibleModelYears).toContain(2003);
  });
});

describe('permissions & roles', () => {
  it('owner has everything; auditor cannot mutate', () => {
    expect(SYSTEM_ROLES.owner.permissions.length).toBe(ALL_PERMISSIONS.length);
    const mutating = /\.(create|update|manage|approve|cancel|confirm|deliver|receive|void|pay|transfer|close|reopen|adjust|perform|remove|issue|collect|settle|reverse|return|assign|extend|count|reconcile|set_floor|post_manual|change_status|post_after_sale|deliver_with_balance|cancel_confirmed|manage_media|manage_documents|manage_policies|manage_accounts|manage_templates|approve_discount|approve_below_floor)$/;
    for (const p of SYSTEM_ROLES.auditor.permissions) expect(p).not.toMatch(mutating);
  });
  it('sales reps cannot see cost or approve discounts', () => {
    expect(SYSTEM_ROLES.sales_rep.permissions).not.toContain('vehicles.view_cost');
    expect(SYSTEM_ROLES.sales_rep.permissions).not.toContain('sales.approve_discount');
  });
  it('every role references valid permissions', () => {
    for (const role of Object.values(SYSTEM_ROLES)) for (const p of role.permissions) expect(ALL_PERMISSIONS).toContain(p);
  });
});

describe('markets & settings', () => {
  it('normalises phone numbers to E.164', () => {
    expect(normalizePhone('0501234567', 'SA')).toBe('+966501234567');
    expect(normalizePhone('01012345678', 'EG')).toBe('+201012345678');
    expect(normalizePhone('٠١٠١٢٣٤٥٦٧٨', 'EG')).toBe('+201012345678');
    expect(normalizePhone('00971 50 123 4567', 'SA')).toBe('+971501234567');
    expect(normalizePhone('12', 'AE')).toBeNull();
  });
  it('default settings validate for every market', () => {
    for (const m of ['EG', 'SA', 'AE'] as const) expect(zTenantSettings.safeParse(defaultTenantSettings(m)).success).toBe(true);
    expect(defaultTenantSettings('SA').tax.ratePct).toBe('15');
  });
  it('money schema rejects floats-as-strings beyond 2 decimals and negatives where required', () => {
    expect(zMoney.safeParse('10.123').success).toBe(false);
    expect(zMoney.safeParse('1e5').success).toBe(false);
    expect(zMoneyPos.safeParse('0').success).toBe(false);
    expect(zMoneyPos.safeParse('-1').success).toBe(false);
    expect(zMoneyPos.safeParse('0.01').success).toBe(true);
  });
});
