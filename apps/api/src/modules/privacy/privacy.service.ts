import { Injectable } from '@nestjs/common';
import {
  normalizeCustomerPhone,
  privacySettings,
  PrivacySearchQuery,
  RedactionKind,
  RedactionRequest,
} from '@autohub/shared';
import { assertPermission, TenantContext } from '../../common/context';
import { AppError, unprocessable } from '../../common/errors';
import { currentRequestInfo } from '../../common/request-info';
import { DbService } from '../../db/db.service';
import { JobsService } from '../jobs/jobs.service';

export const RETENTION_JOB = 'privacy.inquiry_retention';
/** Rows redacted per retention run (one database call, one audit entry); the rest waits for the next run. */
const RETENTION_BATCH = 5000;
const SEARCH_LIMIT = 200;
/** Neutral notification titles for redacted inquiries (the originals carry the visitor's name). */
const REDACTED_TITLE_AR = 'استفسار من المعرض الإلكتروني (حُذفت البيانات الشخصية)';
const REDACTED_TITLE_EN = 'Online showroom inquiry (personal data removed)';
/** Arabic-Indic and Persian digits → ASCII, for comparing stored phone numbers in SQL. */
const DIGITS_FROM = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
const DIGITS_TO = '01234567890123456789';

/** Data-protection requests and redaction are company-wide (like the audit log). */
function assertCompanyScope(ctx: TenantContext): void {
  if (!ctx.allBranches) {
    throw new AppError(
      'company_scope_required',
      403,
      'Data-protection requests cover the whole company; they require access to all branches',
    );
  }
}

/** "•••• 4567": the last four digits only. */
export function maskPhone(v: string): string {
  const digits = v.replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••';
}

/** "a•••@g•••.com": first character of the mailbox and of the domain, and the top-level domain. */
export function maskEmail(v: string): string {
  const [local = '', domain = ''] = v.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`;
}

/** "A. K.": initials of the first two words of a name, so family members sharing a phone can be told apart. */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => `${Array.from(w)[0] ?? ''}.`)
    .join(' ');
}

type InquiryRow = {
  id: string;
  kind: string;
  name: string;
  phone: string;
  phone_normalized: string | null;
  email: string | null;
  customer_id: string | null;
  lead_id: string | null;
  created_at: Date;
};

type MessageRow = {
  id: string;
  channel: string;
  status: string;
  recipient: string;
  related_type: string | null;
  related_id: string | null;
  created_at: Date;
};

/**
 * Data protection (D-053, OPERATIONS §9). Showroom inquiries and the message log are append-only;
 * their personal fields can only be overwritten by the database function `app_redact_contact`, which
 * also writes the audit entry. This service finds one person's rows, calls the function, replaces the
 * visitor's name in inquiry notifications, and runs the retention job.
 */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly dbs: DbService,
    jobs: JobsService,
  ) {
    jobs.register({ name: RETENTION_JOB, everyMs: 6 * 60 * 60_000, run: (ctx) => this.applyRetention(ctx) });
  }

  async search(ctx: TenantContext, q: PrivacySearchQuery) {
    assertPermission(ctx, 'privacy.manage');
    assertCompanyScope(ctx);
    const phone = q.phone ?? null;
    const normalized = phone ? normalizeCustomerPhone(phone, ctx.tenant.market) : null;
    if (phone && !normalized)
      throw unprocessable('invalid_phone', 'This phone number is not valid', { field: 'phone' });
    const email = q.email?.toLowerCase() ?? null;

    const inquiries = await this.dbs.query<InquiryRow>(
      `SELECT id, kind, name, phone, phone_normalized, email, customer_id, lead_id, created_at
         FROM showroom_inquiries
        WHERE redacted_at IS NULL
          AND (($1::text IS NOT NULL AND (phone_normalized = $1 OR phone = $2)) OR ($3::text IS NOT NULL AND lower(email) = $3))
        ORDER BY created_at DESC LIMIT ${SEARCH_LIMIT}`,
      [normalized, phone, email],
    );
    const inquiryIds = inquiries.map((r) => r.id);
    // Messages about those inquiries, and messages sent to the same phone or email for any reason.
    // Phones are pre-filtered on their last 7 digits in SQL and compared exactly after normalising.
    const candidates = await this.dbs.query<MessageRow>(
      `SELECT id, channel, status, recipient, related_type, related_id, created_at
         FROM message_log
        WHERE redacted_at IS NULL
          AND ((related_type = 'showroom_inquiry' AND related_id = ANY($1::uuid[]))
            OR ($2::text IS NOT NULL AND channel <> 'email'
                AND right(regexp_replace(translate(recipient, '${DIGITS_FROM}', '${DIGITS_TO}'), '[^0-9]', '', 'g'), 7) = right($2, 7))
            OR ($3::text IS NOT NULL AND channel = 'email' AND lower(btrim(recipient)) = $3))
        ORDER BY created_at DESC LIMIT ${SEARCH_LIMIT * 5}`,
      [inquiryIds, normalized, email],
    );
    const related = new Set(inquiryIds);
    const messages = candidates
      .filter(
        (m) =>
          (m.related_type === 'showroom_inquiry' && m.related_id !== null && related.has(m.related_id)) ||
          (m.channel === 'email'
            ? m.recipient.trim().toLowerCase() === email
            : normalized !== null && normalizeCustomerPhone(m.recipient, ctx.tenant.market) === normalized),
      )
      .slice(0, SEARCH_LIMIT);

    return {
      inquiries: inquiries.map((r) => ({
        kind: 'showroom_inquiry' as const,
        id: r.id,
        createdAt: r.created_at,
        inquiryKind: r.kind,
        initials: initials(r.name),
        phoneMasked: maskPhone(r.phone),
        emailMasked: r.email ? maskEmail(r.email) : null,
        matchedOn: [
          ...(normalized && (r.phone_normalized === normalized || r.phone === phone) ? ['phone'] : []),
          ...(email && r.email?.toLowerCase() === email ? ['email'] : []),
        ],
        // A linked customer or lead is a CRM record: it is corrected or deactivated in its own screens.
        linkedCustomer: r.customer_id !== null,
        linkedLead: r.lead_id !== null,
        messages: messages.filter((m) => m.related_id === r.id).length,
      })),
      messages: messages.map((m) => ({
        kind: 'message_log' as const,
        id: m.id,
        createdAt: m.created_at,
        channel: m.channel,
        status: m.status,
        recipientMasked: m.channel === 'email' ? maskEmail(m.recipient) : maskPhone(m.recipient),
        relatedInquiryId: m.related_type === 'showroom_inquiry' ? m.related_id : null,
      })),
      limit: SEARCH_LIMIT,
    };
  }

  async redact(ctx: TenantContext, body: RedactionRequest) {
    assertPermission(ctx, 'privacy.manage');
    assertCompanyScope(ctx);
    const info = currentRequestInfo();
    const ids = [...new Set(body.ids)];
    const result = await this.apply(body.kind, ids, body.reason, {
      source: 'api',
      requestId: info?.requestId ?? null,
      ip: info?.ip ?? null,
    });
    return { kind: body.kind, requested: ids.length, ...result };
  }

  /**
   * Retention (company setting `privacy.inquiryRetentionDays`): redacts inquiries older than that,
   * with the messages about them, in one call (one audit entry) per run. Rows already redacted are
   * skipped, so a run with nothing left to do changes and audits nothing.
   */
  async applyRetention(ctx: TenantContext): Promise<{ inquiries: number; messages: number }> {
    const days = privacySettings(ctx.tenant.settings).inquiryRetentionDays;
    if (!days) return { inquiries: 0, messages: 0 };
    const due = await this.dbs.query<{ id: string }>(
      `SELECT i.id FROM showroom_inquiries i
        WHERE i.created_at < now() - make_interval(days => $1::int)
          AND (i.redacted_at IS NULL
               OR EXISTS (SELECT 1 FROM message_log m WHERE m.related_type = 'showroom_inquiry' AND m.related_id = i.id AND m.redacted_at IS NULL))
        ORDER BY i.created_at LIMIT ${RETENTION_BATCH}`,
      [days],
    );
    if (!due.length) return { inquiries: 0, messages: 0 };
    return this.apply(
      'showroom_inquiry',
      due.map((r) => r.id),
      `Retention: online inquiries older than ${days} days`,
      { source: 'retention' },
    );
  }

  private async apply(
    kind: RedactionKind,
    ids: string[],
    reason: string,
    context: Record<string, string | null>,
  ) {
    const [r] = await this.dbs.query<{ inquiries: number; messages: number }>(
      `SELECT inquiries, messages FROM app_redact_contact($1, $2::uuid[], $3, $4::jsonb)`,
      [kind, ids, reason, JSON.stringify(context)],
    );
    if (kind === 'showroom_inquiry') {
      // The managers' notifications about an inquiry (dedupe key `showroom.inquiry:<id>:<user>`) are
      // titled with the visitor's name. RLS keeps this to the company's own notifications.
      await this.dbs.query(
        `UPDATE notifications SET title_ar = $2, title_en = $3 WHERE type = 'showroom.inquiry' AND split_part(dedupe_key, ':', 2) = ANY($1::text[])`,
        [ids, REDACTED_TITLE_AR, REDACTED_TITLE_EN],
      );
    }
    return { inquiries: r?.inquiries ?? 0, messages: r?.messages ?? 0 };
  }
}
