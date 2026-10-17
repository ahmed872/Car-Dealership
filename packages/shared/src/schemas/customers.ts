import { z } from 'zod';
import { MARKETS, type MarketCode } from '../markets';
import { patchOf, zPaginationQuery, zText, zUuid } from './common';
import { CUSTOMER_TYPES, INTERACTION_TYPES, zCustomerInput, zCustomerListQuery, zInteractionCreate } from './crm';

// ── Pure normalisers (shared by the API and the web forms) ──────────────────────────────────

/** Arabic-Indic (U+0660–0669) and Extended Arabic-Indic / Persian (U+06F0–06F9) digits → ASCII. */
export function toLatinDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

/** Separators people type or paste inside phone numbers: spaces (incl. NBSP), dashes, dots, slashes, parentheses, bidi marks. */
const PHONE_SEPARATORS = /[\s\u00A0\u2010-\u2015\u2212()./\u200E\u200F\u202A-\u202E\u2066-\u2069-]/g;

/**
 * Canonical customer phone: digits only, WITH the country code (no "+"), e.g. "966501234567".
 *  - Arabic-Indic / Persian digits become ASCII; spaces, dashes, dots and parentheses are dropped.
 *  - "+CC…" or "00CC…" is international and kept as given.
 *  - A local number gets the market's country code: the trunk "0" is dropped ("0501234567" →
 *    "966501234567"); a number already starting with the market code and long enough to hold a
 *    subscriber number ("966501234567") is kept.
 *  - Without a market, local numbers are returned as digits only.
 * Returns null for empty or impossible input (non-digits, fewer than 8 or more than 15 digits).
 */
export function normalizeCustomerPhone(raw: string | null | undefined, market?: MarketCode | null): string | null {
  if (raw === null || raw === undefined) return null;
  let s = toLatinDigits(String(raw)).trim().replace(PHONE_SEPARATORS, '');
  if (!s) return null;
  let international = false;
  if (s.startsWith('+')) {
    international = true;
    s = s.slice(1);
  } else if (s.startsWith('00')) {
    international = true;
    s = s.slice(2);
  }
  if (!/^\d+$/.test(s)) return null;
  const cc = market ? MARKETS[market]?.phoneCountryCode.replace(/^\+/, '') : undefined;
  if (!international && cc) {
    if (s.startsWith('0')) s = cc + s.replace(/^0+/, '');
    else if (!(s.startsWith(cc) && s.length >= cc.length + 8)) s = cc + s;
  }
  const canonical = international || !!cc;
  if (canonical && s.startsWith('0')) return null;
  if (s.length < (canonical ? 8 : 6) || s.length > 15) return null;
  return s;
}

/**
 * Canonical national ID / Iqama / Emirates ID / passport number used for the keyed hash:
 * ASCII digits, upper case, separators removed. Returns null when fewer than 4 characters remain
 * or anything other than letters and digits is left.
 */
export function normalizeNationalId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = toLatinDigits(String(raw)).toUpperCase().replace(PHONE_SEPARATORS, '');
  if (!/^[A-Z0-9]{4,40}$/.test(s)) return null;
  return s;
}

/** Display form of a stored national ID: only the last 4 characters, e.g. "••••1234". */
export function maskNationalId(last4: string | null | undefined): string | null {
  return last4 ? `••••${last4}` : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const s = raw?.trim().toLowerCase();
  return s ? s : null;
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────

/**
 * Create a customer. `force: true` creates the customer even though another customer has the same
 * phone/WhatsApp number (e.g. family members sharing a phone); it needs customers.manage and is
 * recorded in the audit log. A national-ID match can never be forced (one customer per ID).
 */
export const zCustomerCreate = zCustomerInput.extend({ force: z.boolean().default(false) });
export type CustomerCreateInput = z.infer<typeof zCustomerCreate>;

/** PATCH: absent fields stay untouched (patchOf, never .partial()). `force` as on create. */
export const zCustomerPatch = patchOf(zCustomerInput).extend({
  isActive: z.boolean().optional(),
  version: z.number().int().min(1),
  force: z.boolean().optional(),
});
export type CustomerPatchInput = z.infer<typeof zCustomerPatch>;

const zPhoneQuery = z.string().trim().max(30).optional().nullable();

/** Body of POST /customers/check-duplicates (POST so national IDs never appear in URLs or logs). */
export const zCustomerDuplicateCheck = z.object({
  phone: zPhoneQuery,
  phoneAlt: zPhoneQuery,
  whatsapp: zPhoneQuery,
  email: z.string().trim().max(120).optional().nullable(),
  nationalId: z.string().trim().max(40).optional().nullable(),
  commercialRegistration: z.string().trim().max(60).optional().nullable(),
  taxNumber: z.string().trim().max(40).optional().nullable(),
  /** The customer being edited (never reported as its own duplicate). */
  excludeId: zUuid.optional().nullable(),
});
export type CustomerDuplicateCheckInput = z.infer<typeof zCustomerDuplicateCheck>;

export const CUSTOMER_MATCH_FIELDS = ['nationalId', 'phone', 'email', 'commercialRegistration', 'taxNumber'] as const;
export type CustomerMatchField = (typeof CUSTOMER_MATCH_FIELDS)[number];

export interface CustomerDuplicate {
  id: string;
  type: (typeof CUSTOMER_TYPES)[number];
  fullName: string;
  companyName: string | null;
  isActive: boolean;
  branchId: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  matchedOn: CustomerMatchField[];
  /** Whether the caller may open this customer (visibility rules). */
  canView: boolean;
}

export interface CustomerDuplicateResult {
  candidates: CustomerDuplicate[];
  /** A create with these values would be refused (409 customer_duplicate). */
  blocking: boolean;
  /** The refusal can be overridden with force=true (phone matches only, never national ID). */
  forceAllowed: boolean;
}

/** GET /customers: zCustomerListQuery + status and branch filters. `active` defaults to 'true'. */
export const zCustomerSearchQuery = zCustomerListQuery.extend({
  active: z.enum(['true', 'false', 'all']).optional(),
  branchId: zUuid.optional(),
});
export type CustomerSearchQuery = z.infer<typeof zCustomerSearchQuery>;

/** Assign / reassign / unassign (null) the responsible salesperson. */
export const zCustomerAssign = z.object({
  assignedUserId: zUuid.nullable(),
  version: z.number().int().min(1).optional(),
});
export type CustomerAssignInput = z.infer<typeof zCustomerAssign>;

export const zCustomerDeactivate = z.object({
  reason: zText(500).min(3),
  version: z.number().int().min(1),
});
export const zCustomerReactivate = z.object({ version: z.number().int().min(1) });

export const zInteractionListQuery = zPaginationQuery.extend({
  type: z.enum(INTERACTION_TYPES).optional(),
  leadId: zUuid.optional(),
});
export type InteractionListQuery = z.infer<typeof zInteractionListQuery>;

export type InteractionCreateInput = z.infer<typeof zInteractionCreate>;
