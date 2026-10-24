import { z } from 'zod';
import { zUuid } from './common';

/** What a data-protection redaction targets (D-053). */
export const REDACTION_KINDS = ['showroom_inquiry', 'message_log'] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/**
 * `GET /privacy/search`: one person's contact, by phone and/or email (at least one). The phone is
 * compared in the company's normalised form, the email case-insensitively.
 */
export const zPrivacySearchQuery = z
  .object({
    phone: z.string().trim().min(6).max(25).optional(),
    email: z.string().trim().email().max(120).optional(),
  })
  .refine((q) => !!q.phone || !!q.email, { message: 'phone_or_email_required', path: ['phone'] });
export type PrivacySearchQuery = z.infer<typeof zPrivacySearchQuery>;

/**
 * `POST /privacy/redactions`: overwrite the personal fields of these rows. Redacting an inquiry also
 * redacts the messages sent about it. The reason is stored in the audit log: describe the request
 * (e.g. "erasure request #12 of 2026-10-20"), never the person's name or contact.
 */
export const zRedactionRequest = z.object({
  kind: z.enum(REDACTION_KINDS),
  ids: z.array(zUuid).min(1).max(500),
  reason: z.string().trim().min(3).max(500),
});
export type RedactionRequest = z.infer<typeof zRedactionRequest>;
