import { useMutation } from '@tanstack/react-query';
import {
  CalendarDays,
  Car,
  Eye,
  EyeOff,
  Handshake,
  History,
  MessageSquarePlus,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  ShieldCheck,
  UserCog,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { INTERACTION_TYPES } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList, StatCard } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Field, Select } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { LeadStatusBadge, StageBadge, FollowUpText, LeadCreateModal } from '@/features/leads/components';
import { LeadCard, useStageName } from '@/features/leads/api';
import { Customer360, Interaction, InteractionType, Paged, useCrmError, useCrmMutation, useCustomer } from './api';
import { ActiveBadge, AssigneeSelect, CustomerTypeBadge, InteractionModal, InteractionTimeline, PhoneText, useCanLogInteraction } from './components';

type TabKey = 'timeline' | 'leads' | 'reservations' | 'receipts' | 'appointments' | 'wishes';

const RES_TONE: Record<string, Tone> = { active: 'info', converted: 'success', expired: 'neutral', cancelled: 'danger' };

/** Masked national ID with an audited "reveal" for customers.view_sensitive holders. */
function NationalIdValue({ c }: { c: Customer360['customer'] }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const err = useCrmError();
  const [shown, setShown] = useState<string | null>(null);
  const reveal = useMutation({ mutationFn: () => api<{ nationalId: string | null }>(`/customers/${c.id}/sensitive`), onSuccess: (r) => setShown(r.nationalId) });
  if (!c.hasNationalId) return <span className="text-subtle">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span dir="ltr" className="num font-medium tracking-wide">
        {shown ?? c.nationalIdMasked}
      </span>
      {can('customers.view_sensitive') &&
        (shown ? (
          <button type="button" onClick={() => setShown(null)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
            <EyeOff className="h-3.5 w-3.5" aria-hidden /> {t('customers.detail.hide')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => reveal.mutate()}
            disabled={reveal.isPending}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-strong hover:underline disabled:opacity-50"
            title={t('customers.detail.revealHint')}
          >
            <Eye className="h-3.5 w-3.5" aria-hidden /> {t('customers.detail.reveal')}
          </button>
        ))}
      {reveal.error ? <span className="text-xs text-danger">{err(reveal.error)}</span> : null}
    </span>
  );
}

function AssignModal({ c, onClose }: { c: Customer360['customer']; onClose: () => void }) {
  const { t } = useTranslation();
  const [userId, setUserId] = useState(c.assignedUserId ?? '');
  const m = useCrmMutation<{ assignedUserId: string | null; version: number }>({
    path: `/customers/${c.id}/assign`,
    invalidate: [['customer', c.id], ['customers']],
    success: t('customers.detail.assigned'),
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('customers.detail.assignTitle')}
      description={c.fullName}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} disabled={(userId || null) === c.assignedUserId} onClick={() => m.mutate({ assignedUserId: userId || null, version: c.version })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('customers.fields.assignedUser')} hint={t('customers.detail.assignHint')}>
        {(id) => (
          <AssigneeSelect id={id} value={userId} onChange={setUserId} branchId={c.branchId} perm="customers.read" emptyLabel={t('customers.unassigned')} />
        )}
      </Field>
    </Modal>
  );
}

function TimelineTab({ customerId, canLog, onLog }: { customerId: string; canLog: boolean; onLog: () => void }) {
  const { t } = useTranslation();
  const [type, setType] = useState<InteractionType | ''>('');
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const q = useApi<Paged<Interaction>>(['customer-interactions', customerId], `/customers/${customerId}/interactions`, { page, pageSize, type: type || undefined }, { placeholderData: (p) => p });
  return (
    <Card>
      <CardHeader
        title={t('customers.detail.timeline')}
        actions={
          <>
            <Select className="h-9 w-auto min-w-[140px] text-[13px]" value={type} onChange={(e) => (setType(e.target.value as InteractionType | ''), setPage(1))} aria-label={t('customers.interaction.type')}>
              <option value="">{t('customers.detail.allTypes')}</option>
              {INTERACTION_TYPES.map((it) => (
                <option key={it} value={it}>
                  {t(`customers.enums.interactionType.${it}`)}
                </option>
              ))}
            </Select>
            {canLog && (
              <Button size="sm" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={onLog}>
                {t('customers.detail.logInteraction')}
              </Button>
            )}
          </>
        }
      />
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <PageLoader />
      ) : q.data && q.data.items.length > 0 ? (
        <>
          <InteractionTimeline items={q.data.items} />
          <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />
        </>
      ) : (
        <EmptyState
          icon={<History className="h-5 w-5" />}
          title={t('customers.detail.noInteractions')}
          description={canLog ? t('customers.detail.noInteractionsHint') : undefined}
        />
      )}
    </Card>
  );
}

/** Every lead of the customer the user may see (GET /leads?customerId=, same visibility rules as the leads list). */
function LeadsTab({ customerId, canCreate, onCreate }: { customerId: string; canCreate: boolean; onCreate: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const q = useApi<Paged<LeadCard>>(['leads', 'customer', customerId], '/leads', { customerId, page, pageSize, sort: '-createdAt' }, { placeholderData: (p) => p });
  return (
    <Card>
      <CardHeader
        title={t('customers.detail.leads')}
        actions={
          canCreate ? (
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={onCreate}>
              {t('customers.detail.newLead')}
            </Button>
          ) : undefined
        }
      />
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(l) => l.id}
        onRowClick={(l) => navigate(`/app/leads/${l.id}`)}
        empty={<EmptyState icon={<Handshake className="h-5 w-5" />} title={t('customers.detail.noLeads')} />}
        columns={[
          { key: 'number', header: t('leads.fields.number'), cell: (l) => <span className="num font-medium whitespace-nowrap">{l.number}</span> },
          { key: 'stage', header: t('leads.fields.stage'), cell: (l) => <StageBadge stage={{ nameEn: l.stageNameEn, nameAr: l.stageNameAr, code: l.stageCode, kind: l.status === 'open' ? 'open' : l.status }} /> },
          { key: 'status', header: t('common.status'), cell: (l) => <LeadStatusBadge status={l.status} /> },
          { key: 'owner', header: t('leads.fields.assignee'), hideOnMobile: true, cell: (l) => (l.assigneeName ? <span className="whitespace-nowrap">{l.assigneeName}</span> : <span className="text-subtle">{t('customers.unassigned')}</span>) },
          { key: 'follow', header: t('leads.fields.nextFollowUpAt'), cell: (l) => (l.status === 'open' ? <FollowUpText at={l.nextFollowUpAt} /> : <span className="text-subtle">—</span>) },
          { key: 'created', header: t('common.createdAt'), hideOnMobile: true, cell: (l) => <span className="whitespace-nowrap text-muted">{fmtDate(l.createdAt)}</span> },
        ]}
        footer={q.data && q.data.total > pageSize ? <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} /> : undefined}
      />
    </Card>
  );
}

export function CustomerDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can, canAny, currency } = useAuth();
  const stageName = useStageName();
  const q = useCustomer(id);
  const [tab, setTab] = useState<TabKey>('timeline');
  const [logOpen, setLogOpen] = useState<InteractionType | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [leadOpen, setLeadOpen] = useState(false);
  const [confirm, setConfirm] = useState<'deactivate' | 'reactivate' | null>(null);
  const canLog = useCanLogInteraction();
  const en = i18n.language === 'en';

  const deactivate = useCrmMutation<{ reason: string; version: number }>({
    path: `/customers/${id}/deactivate`,
    invalidate: [['customer', id], ['customers']],
    success: t('customers.detail.deactivated'),
    onSuccess: () => setConfirm(null),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'version_conflict') void q.refetch();
      return false;
    },
  });
  const reactivate = useCrmMutation<{ version: number }>({
    path: `/customers/${id}/reactivate`,
    invalidate: [['customer', id], ['customers']],
    success: t('customers.detail.reactivated'),
    onSuccess: () => setConfirm(null),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'version_conflict') void q.refetch();
      return false;
    },
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data;
  const c = data.customer;
  const counts = data.counts;
  const canAssign = canAny('leads.assign', 'customers.read_all');
  const canManage = can('customers.manage');

  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [{ key: 'timeline', label: t('customers.detail.timeline'), count: counts.interactions }];
  if (data.leads) tabs.push({ key: 'leads', label: t('customers.detail.leads'), count: counts.leads ?? undefined });
  // Secondary sections get a tab only when they hold records (their totals stay visible on the stat cards).
  if (data.reservations && (counts.reservations ?? 0) > 0) tabs.push({ key: 'reservations', label: t('customers.detail.reservations'), count: counts.reservations ?? undefined });
  if (data.receipts && (counts.receipts ?? 0) > 0) tabs.push({ key: 'receipts', label: t('customers.detail.receipts'), count: counts.receipts ?? undefined });
  if (data.appointments && (counts.appointments ?? 0) > 0) tabs.push({ key: 'appointments', label: t('customers.detail.appointments'), count: counts.appointments ?? undefined });
  if (counts.wishes > 0) tabs.push({ key: 'wishes', label: t('customers.detail.wishes'), count: counts.wishes });

  const shownTab = tabs.some((x) => x.key === tab) ? tab : 'timeline';

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('nav.customers'), to: '/app/customers' }, { label: c.fullName }]}
        title={c.fullName}
        subtitle={
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <CustomerTypeBadge type={c.type} />
            <ActiveBadge active={c.isActive} />
            {c.companyName && <span className="text-muted">{c.companyName}</span>}
            {c.branchName && <span className="text-muted">· {c.branchName}</span>}
          </span>
        }
        actions={
          <>
            {canLog && c.isActive && (
              <Button variant="secondary" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={() => setLogOpen('call')}>
                {t('customers.detail.logInteraction')}
              </Button>
            )}
            {can('leads.manage') && c.isActive && (
              <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setLeadOpen(true)}>
                {t('customers.detail.newLead')}
              </Button>
            )}
            {canManage && c.isActive && (
              <Button icon={<Pencil className="h-4 w-4" />} onClick={() => navigate(`/app/customers/${c.id}/edit`)}>
                {t('common.edit')}
              </Button>
            )}
          </>
        }
      />

      {!c.isActive && (
        <Alert tone="warning" className="mb-4" title={t('customers.detail.inactiveTitle')}>
          {t('customers.detail.inactiveHint')}
        </Alert>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {counts.openLeads !== null && (
          <StatCard label={t('customers.detail.openLeads')} value={counts.openLeads} hint={t('customers.detail.ofTotal', { total: counts.leads ?? 0 })} icon={<Handshake className="h-5 w-5" />} tone="brand" onClick={() => setTab('leads')} />
        )}
        {counts.activeReservations !== null && (
          <StatCard label={t('customers.detail.activeReservations')} value={counts.activeReservations} hint={t('customers.detail.ofTotal', { total: counts.reservations ?? 0 })} icon={<Car className="h-5 w-5" />} tone="info" onClick={() => setTab('reservations')} />
        )}
        <StatCard
          label={t('customers.detail.lastInteraction')}
          value={data.lastInteractionAt ? fmtDate(data.lastInteractionAt) : '—'}
          hint={t('customers.detail.interactionsCount', { count: counts.interactions })}
          icon={<History className="h-5 w-5" />}
          onClick={() => setTab('timeline')}
        />
        {data.advanceBalance !== null ? (
          <StatCard label={t('customers.detail.advanceBalance')} value={fmtMoney(data.advanceBalance, currency)} hint={t('customers.detail.advanceHint')} icon={<Wallet className="h-5 w-5" />} tone="success" />
        ) : counts.upcomingAppointments !== null ? (
          <StatCard label={t('customers.detail.upcomingAppointments')} value={counts.upcomingAppointments} icon={<CalendarDays className="h-5 w-5" />} tone="warning" />
        ) : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <Tabs<TabKey> tabs={tabs} value={shownTab} onChange={setTab} />
          {shownTab === 'timeline' && <TimelineTab customerId={c.id} canLog={canLog && c.isActive} onLog={() => setLogOpen('call')} />}
          {shownTab === 'leads' && data.leads && <LeadsTab customerId={c.id} canCreate={can('leads.manage') && c.isActive} onCreate={() => setLeadOpen(true)} />}
          {shownTab === 'reservations' && data.reservations && (
            <Card>
              <CardHeader
                title={t('customers.detail.reservations')}
                subtitle={(counts.reservations ?? 0) > data.reservations.length ? t('customers.detail.recentOnly', { shown: data.reservations.length, total: counts.reservations }) : undefined}
              />
              <DataTable
                rows={data.reservations}
                rowKey={(r) => r.id}
                onRowClick={(r) => navigate(`/app/vehicles/${r.vehicleId}`)}
                empty={<EmptyState icon={<Car className="h-5 w-5" />} title={t('customers.detail.noReservations')} />}
                columns={[
                  { key: 'number', header: t('customers.detail.reservationNo'), cell: (r) => <span className="num font-medium">{r.number}</span> },
                  {
                    key: 'vehicle',
                    header: t('leads.fields.vehicle'),
                    cell: (r) => (
                      <span>
                        {[en ? r.makeEn : r.makeAr, en ? r.modelEn : r.modelAr, r.modelYear].join(' ')}
                        <span className="num ms-1 text-xs text-muted">{r.stockNumber}</span>
                      </span>
                    ),
                  },
                  { key: 'status', header: t('common.status'), cell: (r) => <Badge tone={RES_TONE[r.status] ?? 'neutral'}>{t(`customers.enums.reservationStatus.${r.status}`)}</Badge> },
                  { key: 'deposit', header: t('customers.detail.deposit'), align: 'end', cell: (r) => <span className="num">{fmtMoney(r.receivedBase, currency)}</span> },
                  { key: 'expires', header: t('customers.detail.expiresAt'), hideOnMobile: true, cell: (r) => <span className="text-muted">{fmtDateTime(r.expiresAt)}</span> },
                ]}
              />
            </Card>
          )}
          {shownTab === 'receipts' && data.receipts && (
            <Card>
              <CardHeader title={t('customers.detail.receipts')} subtitle={(counts.receipts ?? 0) > data.receipts.length ? t('customers.detail.recentOnly', { shown: data.receipts.length, total: counts.receipts }) : undefined} />
              <DataTable
                rows={data.receipts}
                rowKey={(r) => r.id}
                empty={<EmptyState icon={<Wallet className="h-5 w-5" />} title={t('customers.detail.noReceipts')} />}
                columns={[
                  { key: 'number', header: t('customers.detail.receiptNo'), cell: (r) => <span className="num font-medium">{r.number}</span> },
                  { key: 'date', header: t('common.date'), cell: (r) => fmtDate(r.receivedAt) },
                  { key: 'account', header: t('customers.detail.cashAccount'), hideOnMobile: true, cell: (r) => r.cashAccountName ?? '—' },
                  { key: 'amount', header: t('common.amount'), align: 'end', cell: (r) => <span className="num">{fmtMoney(r.amount, r.currency)}</span> },
                  { key: 'status', header: t('common.status'), cell: (r) => <Badge tone={r.status === 'posted' ? 'success' : 'neutral'}>{t(`customers.enums.receiptStatus.${r.status}`)}</Badge> },
                ]}
              />
            </Card>
          )}
          {shownTab === 'appointments' && data.appointments && (
            <Card>
              <CardHeader title={t('customers.detail.appointments')} />
              <DataTable
                rows={data.appointments}
                rowKey={(a) => a.id}
                empty={<EmptyState icon={<CalendarDays className="h-5 w-5" />} title={t('customers.detail.noAppointments')} />}
                columns={[
                  { key: 'when', header: t('common.date'), cell: (a) => <span className="num">{fmtDateTime(a.startsAt)}</span> },
                  { key: 'type', header: t('common.type'), cell: (a) => t(`customers.enums.appointmentType.${a.type}`, { defaultValue: a.type }) },
                  { key: 'title', header: t('common.description'), hideOnMobile: true, cell: (a) => a.title ?? '—' },
                  { key: 'status', header: t('common.status'), cell: (a) => <Badge tone="neutral">{t(`customers.enums.appointmentStatus.${a.status}`, { defaultValue: a.status })}</Badge> },
                  { key: 'owner', header: t('leads.fields.assignee'), hideOnMobile: true, cell: (a) => a.assignedUserName ?? '—' },
                ]}
              />
            </Card>
          )}
          {shownTab === 'wishes' && (
            <Card>
              <CardHeader title={t('customers.detail.wishes')} />
              <DataTable
                rows={data.wishes}
                rowKey={(w) => w.id}
                empty={<EmptyState icon={<Car className="h-5 w-5" />} title={t('customers.detail.noWishes')} />}
                columns={[
                  {
                    key: 'what',
                    header: t('leads.fields.vehicle'),
                    cell: (w) => [en ? w.makeEn : w.makeAr, en ? w.modelEn : w.modelAr].filter(Boolean).join(' ') || t('customers.detail.anyVehicle'),
                  },
                  { key: 'years', header: t('customers.detail.years'), cell: (w) => <span className="num">{w.yearFrom || w.yearTo ? `${w.yearFrom ?? '…'}–${w.yearTo ?? '…'}` : '—'}</span> },
                  { key: 'max', header: t('customers.detail.maxPrice'), align: 'end', cell: (w) => <span className="num">{fmtMoney(w.maxPrice, currency)}</span> },
                  { key: 'status', header: t('common.status'), cell: (w) => <Badge tone={w.status === 'active' ? 'info' : 'neutral'}>{t(`customers.enums.wishStatus.${w.status}`, { defaultValue: w.status })}</Badge> },
                ]}
              />
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title={t('customers.detail.profile')} />
            <CardBody>
              <DescriptionList
                columns={1}
                items={[
                  { label: t('customers.fields.phone'), value: <PhoneText phone={c.phone} /> },
                  { label: t('customers.fields.whatsapp'), value: <PhoneText phone={c.whatsapp} /> },
                  ...(c.phoneAlt ? [{ label: t('customers.fields.phoneAlt'), value: <PhoneText phone={c.phoneAlt} /> }] : []),
                  {
                    label: t('customers.fields.email'),
                    value: c.email ? (
                      <a dir="ltr" href={`mailto:${c.email}`} className="hover:text-brand-strong hover:underline">
                        {c.email}
                      </a>
                    ) : null,
                  },
                  { label: t('customers.fields.nationalId'), value: <NationalIdValue c={c} /> },
                  { label: t('customers.fields.nationality'), value: c.nationality },
                  ...(c.type === 'company'
                    ? [
                        { label: t('customers.fields.commercialRegistration'), value: c.commercialRegistration ? <span className="num">{c.commercialRegistration}</span> : null },
                        { label: t('customers.fields.taxNumber'), value: c.taxNumber ? <span className="num">{c.taxNumber}</span> : null },
                      ]
                    : [{ label: t('customers.fields.dateOfBirth'), value: c.dateOfBirth ? fmtDate(c.dateOfBirth) : null }]),
                  { label: t('customers.fields.city'), value: [c.city, c.address].filter(Boolean).join(' — ') || null },
                  { label: t('customers.fields.source'), value: c.source ? t(`customers.enums.source.${c.source}`) : null },
                  { label: t('customers.fields.preferredLanguage'), value: c.preferredLanguage === 'en' ? 'English' : 'العربية' },
                  {
                    label: t('customers.fields.marketingConsent'),
                    value: c.marketingConsent ? (
                      <span className="inline-flex items-center gap-1 text-success">
                        <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> {t('common.yes')}
                      </span>
                    ) : (
                      t('common.no')
                    ),
                  },
                  ...(c.tags.length
                    ? [
                        {
                          label: t('customers.fields.tags'),
                          value: (
                            <span className="flex flex-wrap gap-1">
                              {c.tags.map((tag) => (
                                <Link key={tag} to={`/app/customers?tag=${encodeURIComponent(tag)}`} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted hover:text-ink">
                                  #{tag}
                                </Link>
                              ))}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  ...(c.notes ? [{ label: t('common.notes'), value: <span className="whitespace-pre-wrap">{c.notes}</span> }] : []),
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={t('customers.detail.ownership')}
              actions={
                canAssign && c.isActive ? (
                  <Button size="sm" variant="secondary" icon={<UserCog className="h-4 w-4" />} onClick={() => setAssignOpen(true)}>
                    {c.assignedUserId ? t('customers.detail.reassign') : t('customers.detail.assign')}
                  </Button>
                ) : undefined
              }
            />
            <CardBody>
              <DescriptionList
                columns={1}
                items={[
                  { label: t('customers.fields.assignedUser'), value: c.assignedUserName ?? <span className="text-subtle">{t('customers.unassigned')}</span> },
                  { label: t('common.branch'), value: c.branchName ?? t('customers.noBranch') },
                  { label: t('customers.detail.createdBy'), value: `${c.createdByName ?? '—'} · ${fmtDate(c.createdAt)}` },
                  { label: t('customers.detail.updatedAt'), value: fmtDateTime(c.updatedAt) },
                ]}
              />
            </CardBody>
          </Card>

          {canManage && (
            <Card>
              <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-muted">{c.isActive ? t('customers.detail.deactivateHint') : t('customers.detail.reactivateHint')}</p>
                {c.isActive ? (
                  <Button variant="outline" size="sm" icon={<Power className="h-4 w-4" />} onClick={() => setConfirm('deactivate')}>
                    {t('customers.detail.deactivate')}
                  </Button>
                ) : (
                  <Button variant="success" size="sm" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setConfirm('reactivate')}>
                    {t('customers.detail.reactivate')}
                  </Button>
                )}
              </CardBody>
            </Card>
          )}

          {data.leads && data.leads.some((l) => l.status === 'open') && (
            <Card>
              <CardHeader title={t('customers.detail.openLeadsCard')} />
              <ul className="divide-y divide-line">
                {data.leads
                  .filter((l) => l.status === 'open')
                  .map((l) => (
                    <li key={l.id}>
                      <Link to={`/app/leads/${l.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-2/60">
                        <span className="min-w-0">
                          <span className="num block text-sm font-medium">{l.number}</span>
                          <span className="block truncate text-xs text-muted">{stageName({ nameEn: l.stageNameEn, nameAr: l.stageNameAr, code: l.stageCode })}</span>
                        </span>
                        <FollowUpText at={l.nextFollowUpAt} className="text-xs" />
                      </Link>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {logOpen && (
        <InteractionModal
          customerId={c.id}
          leads={(data.leads ?? []).map((l) => ({ id: l.id, number: l.number, status: l.status }))}
          defaultType={logOpen}
          onClose={() => setLogOpen(null)}
        />
      )}
      {assignOpen && <AssignModal c={c} onClose={() => setAssignOpen(false)} />}
      {leadOpen && (
        <LeadCreateModal
          customer={{ id: c.id, fullName: c.fullName, phone: c.phone ?? c.whatsapp, branchId: c.branchId, source: c.source }}
          onClose={() => setLeadOpen(false)}
        />
      )}
      <ConfirmDialog
        open={confirm === 'deactivate'}
        onClose={() => setConfirm(null)}
        title={t('customers.detail.deactivateTitle')}
        message={t('customers.detail.deactivateMessage', { name: c.fullName })}
        confirmLabel={t('customers.detail.deactivate')}
        tone="danger"
        requireReason
        loading={deactivate.isPending}
        onConfirm={(reason) => deactivate.mutate({ reason, version: c.version })}
      />
      <ConfirmDialog
        open={confirm === 'reactivate'}
        onClose={() => setConfirm(null)}
        title={t('customers.detail.reactivateTitle')}
        message={t('customers.detail.reactivateMessage', { name: c.fullName })}
        confirmLabel={t('customers.detail.reactivate')}
        loading={reactivate.isPending}
        onConfirm={() => reactivate.mutate({ version: c.version })}
      />
    </>
  );
}
