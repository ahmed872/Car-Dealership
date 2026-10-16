/**
 * VIN validation per ISO 3779. The check digit (position 9) is mandatory in North America
 * and optional elsewhere, so a mismatch is an error only when `enforceCheckDigit` is set.
 */
const TRANSLIT: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// Model year codes cycle every 30 years (no I, O, Q, U, Z, 0).
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

export interface VinResult {
  normalized: string;
  valid: boolean;
  errors: Array<'length' | 'invalid_characters' | 'check_digit'>;
  warnings: Array<'check_digit'>;
  checkDigitValid: boolean | null;
  wmi: string | null;
  /** Possible model years (the code repeats every 30 years). */
  possibleModelYears: number[];
}

export function normalizeVin(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function computeVinCheckDigit(vin: string): string | null {
  if (vin.length !== 17) return null;
  let total = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]!;
    const value = /\d/.test(ch) ? Number(ch) : TRANSLIT[ch];
    if (value === undefined) return null;
    total += value * WEIGHTS[i]!;
  }
  const rem = total % 11;
  return rem === 10 ? 'X' : String(rem);
}

export function validateVin(raw: string, opts: { enforceCheckDigit?: boolean } = {}): VinResult {
  const vin = normalizeVin(raw);
  const errors: VinResult['errors'] = [];
  const warnings: VinResult['warnings'] = [];
  if (vin.length !== 17) errors.push('length');
  if (!/^[A-HJ-NPR-Z0-9]*$/.test(vin)) errors.push('invalid_characters');

  let checkDigitValid: boolean | null = null;
  if (errors.length === 0) {
    checkDigitValid = computeVinCheckDigit(vin) === vin[8];
    if (!checkDigitValid) (opts.enforceCheckDigit ? errors : warnings).push('check_digit');
  }

  const possibleModelYears: number[] = [];
  if (vin.length === 17) {
    const idx = YEAR_CODES.indexOf(vin[9]!);
    if (idx >= 0) {
      for (let base = 1980; base <= 2070; base += 30) possibleModelYears.push(base + idx);
    }
  }

  return {
    normalized: vin,
    valid: errors.length === 0,
    errors,
    warnings,
    checkDigitValid,
    wmi: vin.length >= 3 ? vin.slice(0, 3) : null,
    possibleModelYears,
  };
}
