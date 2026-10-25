import { useQuery } from '@tanstack/react-query';
import { Eraser, Search, ShieldAlert, UserSearch } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog } from '@/components/ui/Modal';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApiMutation } from '@/lib/hooks';

interface InquiryMatch {
  kind: 'showroom_inquiry';
  id: string;
  createdAt: string;
  inquiryKind: 'inquiry' | 'test_drive';
  initials: string;
  phoneMasked: string;
  emailMasked: string | null;
  matchedOn: Array<'phone' | 'email'>;
  linkedCustomer: boolean;
  linkedLead: boolean;
  messages: number;
}

interface MessageMatch {
  kind: 'message_log';
  id: string;
  createdAt: string;
  channel: 'whatsapp' | 'sms' | 'email';
  status: 'logged' | 'sent' | 'failed';
  recipientMasked: string;
  relatedInquiryId: string | null;
}

interface SearchResult {
  inquiries: InquiryMatch[];
  messages: MessageMatch[];
  limit: number;
}

interface RedactionResult {
  kind: string;
  requested: number;
  inquiries: number;
  messages: number;
}

type Query = { phone?: string; email?: string };

/** /app/settings/privacy — data-protection requests (privacy.manage, company-wide like the audit log). */
export function PrivacyPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  if (!me?.allBranches) {
    return (
      <>
        <PageHeader title={t('privacy.title')} subtitle={t('privacy.subtitle')} />
        <Card>
          <EmptyState
            icon={<ShieldAlert className="h-5 w-5" />}
            title={t('privacy.companyScopeTitle')}
            description={t('privacy.companyScopeHint')}
          />
        </Card>
      </>
    );
  }
  return <PrivacyRequests />;
}

/** A checkbox column header/cell that toggles ids in a set. */
function SelectBox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="h-4 w-4 rounded border-line-strong accent-[var(--brand-strong)]"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function PrivacyRequests() {
  const { t } = useTranslation();
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [query, setQuery] = useState<Query | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [selInquiries, setSelInquiries] = useState<Set<string>>(new Set());
  const [selMessages, setSelMessages] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ inquiries: number; messages: number } | null>(null);

  // POST with a JSON body: the person's phone/email never goes into a URL (logs, history; D-054).
  const q = useQuery<SearchResult>({
    queryKey: ['privacy-search', query],
    queryFn: ({ signal }) => api<SearchResult>('/privacy/search', { method: 'POST', body: query, signal }),
    enabled: query !== null,
  });
  const inquiries = q.data?.inquiries ?? [];
  const messages = q.data?.messages ?? [];
  // Messages about a selected inquiry are erased with it; they need no separate request.
  const coveredMessages = messages
    .filter((m) => m.relatedInquiryId && selInquiries.has(m.relatedInquiryId))
    .map((m) => m.id);
  const separateMessages = [...selMessages].filter((id) => !coveredMessages.includes(id));
  const messageCount = new Set([...coveredMessages, ...selMessages]).size;

  const redact = useApiMutation<
    { kind: 'showroom_inquiry' | 'message_log'; ids: string[]; reason: string },
    RedactionResult
  >({
    path: '/privacy/redactions',
    success: null,
    invalidate: [['privacy-search'], ['showroom', 'inquiries']],
  });
  const [busy, setBusy] = useState(false);

  /** Inquiries first (with their messages), then the other selected messages: one request and audit entry per kind. */
  const confirmRedaction = async (reason: string) => {
    setBusy(true);
    try {
      const total = { inquiries: 0, messages: 0 };
      if (selInquiries.size > 0) {
        const r = await redact.mutateAsync({ kind: 'showroom_inquiry', ids: [...selInquiries], reason });
        total.inquiries += r.inquiries;
        total.messages += r.messages;
      }
      if (separateMessages.length > 0) {
        const r = await redact.mutateAsync({ kind: 'message_log', ids: separateMessages, reason });
        total.messages += r.messages;
      }
      setDone(total);
      setSelInquiries(new Set());
      setSelMessages(new Set());
      setConfirming(false);
    } catch {
      // The mutation already showed the translated error.
    } finally {
      setBusy(false);
    }
  };

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const next: Query = {};
    if (phone.trim()) next.phone = phone.trim();
    if (email.trim()) next.email = email.trim();
    if (!next.phone && !next.email) {
      setFormError(t('privacy.needOne'));
      return;
    }
    setFormError(null);
    setDone(null);
    setSelInquiries(new Set());
    setSelMessages(new Set());
    setQuery(next);
  };

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    setter(next);
  };

  return (
    <>
      <PageHeader title={t('privacy.title')} subtitle={t('privacy.subtitle')} />
      <div className="space-y-5">
        <Card>
          <CardHeader title={t('privacy.searchTitle')} subtitle={t('privacy.searchHint')} />
          <CardBody>
            <form
              onSubmit={submitSearch}
              noValidate
              className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            >
              <Field label={t('privacy.phone')} error={formError ?? undefined}>
                {(id) => (
                  <Input
                    id={id}
                    dir="ltr"
                    inputMode="tel"
                    maxLength={25}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+9665…"
                  />
                )}
              </Field>
              <Field label={t('privacy.email')}>
                {(id) => (
                  <Input
                    id={id}
                    dir="ltr"
                    type="email"
                    maxLength={120}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" icon={<Search className="h-4 w-4" />} loading={q.isFetching}>
                {t('privacy.search')}
              </Button>
            </form>
          </CardBody>
        </Card>

        {done && <Alert tone="success" title={t('privacy.done', done)} />}

        {query && (
          <>
            {!q.isLoading && !q.error && inquiries.length === 0 && messages.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<UserSearch className="h-5 w-5" />}
                  title={t('privacy.noMatches')}
                  description={t('privacy.noMatchesHint')}
                />
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader
                    title={t('privacy.inquiries')}
                    subtitle={t('privacy.inquiryIncludesMessages')}
                  />
                  <DataTable
                    dense
                    rows={q.data?.inquiries}
                    loading={q.isLoading}
                    error={q.error}
                    onRetry={() => q.refetch()}
                    rowKey={(r) => r.id}
                    onRowClick={(r) => toggle(selInquiries, setSelInquiries, r.id, !selInquiries.has(r.id))}
                    empty={
                      <p className="px-4 py-6 text-center text-sm text-muted">{t('privacy.noMatchesHint')}</p>
                    }
                    columns={[
                      {
                        key: 'select',
                        header: (
                          <SelectBox
                            label={t('privacy.selectAll')}
                            checked={inquiries.length > 0 && inquiries.every((r) => selInquiries.has(r.id))}
                            onChange={(on) => setSelInquiries(new Set(on ? inquiries.map((r) => r.id) : []))}
                          />
                        ),
                        cell: (r) => (
                          <SelectBox
                            label={t('privacy.select')}
                            checked={selInquiries.has(r.id)}
                            onChange={(on) => toggle(selInquiries, setSelInquiries, r.id, on)}
                          />
                        ),
                      },
                      {
                        key: 'at',
                        header: t('privacy.received'),
                        cell: (r) => (
                          <span className="num text-[13px] whitespace-nowrap">
                            {fmtDateTime(r.createdAt)}
                          </span>
                        ),
                      },
                      {
                        key: 'kind',
                        header: t('privacy.kind'),
                        cell: (r) => (
                          <Badge tone={r.inquiryKind === 'test_drive' ? 'accent' : 'info'}>
                            {t(`privacy.kinds.${r.inquiryKind}`)}
                          </Badge>
                        ),
                      },
                      {
                        key: 'contact',
                        header: t('privacy.contact'),
                        cell: (r) => (
                          <div className="space-y-0.5 text-[13px]">
                            <p className="font-medium">
                              <bdi>{r.initials}</bdi>
                            </p>
                            <p dir="ltr" className="num text-muted">
                              {r.phoneMasked}
                              {r.emailMasked && ` · ${r.emailMasked}`}
                            </p>
                          </div>
                        ),
                      },
                      {
                        key: 'matched',
                        header: t('privacy.matchedOn'),
                        hideOnMobile: true,
                        cell: (r) => (
                          <span className="text-[13px] text-muted">
                            {r.matchedOn.map((m) => t(`privacy.matched.${m}`)).join(' · ')}
                          </span>
                        ),
                      },
                      {
                        key: 'links',
                        header: '',
                        cell: (r) => (
                          <div className="space-y-1 text-xs text-muted">
                            {r.messages > 0 && <p>{t('privacy.messageCount', { count: r.messages })}</p>}
                            {r.linkedCustomer && (
                              <p title={t('privacy.linkedCustomerHint')}>
                                <Badge tone="warning">{t('privacy.linkedCustomer')}</Badge>
                              </p>
                            )}
                          </div>
                        ),
                      },
                    ]}
                  />
                </Card>

                <Card>
                  <CardHeader title={t('privacy.messages')} />
                  <DataTable
                    dense
                    rows={q.data?.messages}
                    loading={q.isLoading}
                    error={q.error}
                    onRetry={() => q.refetch()}
                    rowKey={(r) => r.id}
                    onRowClick={(r) => toggle(selMessages, setSelMessages, r.id, !selMessages.has(r.id))}
                    empty={
                      <p className="px-4 py-6 text-center text-sm text-muted">{t('privacy.noMatchesHint')}</p>
                    }
                    columns={[
                      {
                        key: 'select',
                        header: (
                          <SelectBox
                            label={t('privacy.selectAll')}
                            checked={
                              messages.length > 0 &&
                              messages.every((r) => selMessages.has(r.id) || coveredMessages.includes(r.id))
                            }
                            onChange={(on) => setSelMessages(new Set(on ? messages.map((r) => r.id) : []))}
                          />
                        ),
                        cell: (r) => (
                          <SelectBox
                            label={t('privacy.select')}
                            checked={selMessages.has(r.id) || coveredMessages.includes(r.id)}
                            onChange={(on) => toggle(selMessages, setSelMessages, r.id, on)}
                          />
                        ),
                      },
                      {
                        key: 'at',
                        header: t('privacy.received'),
                        cell: (r) => (
                          <span className="num text-[13px] whitespace-nowrap">
                            {fmtDateTime(r.createdAt)}
                          </span>
                        ),
                      },
                      {
                        key: 'channel',
                        header: t('privacy.channel'),
                        cell: (r) => t(`privacy.channels.${r.channel}`),
                      },
                      {
                        key: 'status',
                        header: t('privacy.status'),
                        hideOnMobile: true,
                        cell: (r) => (
                          <span className="text-[13px] text-muted">{t(`privacy.statuses.${r.status}`)}</span>
                        ),
                      },
                      {
                        key: 'to',
                        header: t('privacy.contact'),
                        cell: (r) => (
                          <span dir="ltr" className="num text-[13px] text-muted">
                            {r.recipientMasked}
                          </span>
                        ),
                      },
                      {
                        key: 'about',
                        header: '',
                        hideOnMobile: true,
                        cell: (r) =>
                          r.relatedInquiryId ? (
                            <span className="text-xs text-muted">{t('privacy.aboutInquiry')}</span>
                          ) : null,
                      },
                    ]}
                  />
                </Card>

                <div className="flex flex-wrap items-center justify-end gap-3">
                  <span className="text-sm text-muted">
                    {t('privacy.selected', { count: selInquiries.size + messageCount })}
                  </span>
                  <Button
                    variant="danger"
                    icon={<Eraser className="h-4 w-4" />}
                    disabled={selInquiries.size === 0 && separateMessages.length === 0}
                    onClick={() => setConfirming(true)}
                  >
                    {t('privacy.redact')}
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        <Alert tone="info" title={t('privacy.notErasedTitle')}>
          {t('privacy.notErased')}
        </Alert>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        tone="danger"
        requireReason
        loading={busy}
        title={t('privacy.confirmTitle')}
        message={t('privacy.confirmMessage', { inquiries: selInquiries.size, messages: messageCount })}
        confirmLabel={t('privacy.redact')}
        onConfirm={confirmRedaction}
      />
    </>
  );
}
