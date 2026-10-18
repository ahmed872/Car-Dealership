import { CheckCircle2, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useBranches } from '@/pages/settings/BranchesPage';
import { useCashAccounts } from '@/features/cash/api';
import { useLedgerText } from '@/features/cash/finance-ui';
import { detailRoute, LedgerEntry, ledgerName, sourceLink, useJournalEntry, useLedgerAccess } from './api';
import { Amt, ReportTable, Td, Th, useMemoLabel } from './components';
import { useSourceLabel } from './JournalTab';

type Line = LedgerEntry['lines'][number];

/** Links to the business objects a journal line is tagged with (only to pages the app has). */
function LineDimensions({ l, cashNames }: { l: Line; cashNames: Map<string, string> }) {
  const { t } = useTranslation();
  const dims: Array<{ key: string; label: string; to: string | null }> = [];
  if (l.vehicleId)
    dims.push({ key: 'v', label: t('accounting.entry.vehicle'), to: detailRoute('vehicles', l.vehicleId) });
  if (l.supplierId)
    dims.push({
      key: 's',
      label: t('accounting.entry.supplier'),
      to: detailRoute('purchasing/suppliers', l.supplierId),
    });
  if (l.customerId)
    dims.push({
      key: 'c',
      label: t('accounting.entry.customer'),
      to: detailRoute('customers', l.customerId),
    });
  if (l.cashAccountId)
    dims.push({
      key: 'a',
      label: cashNames.get(l.cashAccountId) ?? t('accounting.entry.cashAccount'),
      to: detailRoute('cash/accounts', l.cashAccountId),
    });
  if (!dims.length) return <span className="text-subtle">—</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {dims.map((x) =>
        x.to ? (
          <Link key={x.key} to={x.to} className="text-xs font-medium text-brand-strong hover:underline">
            {x.label}
          </Link>
        ) : (
          <span key={x.key} className="text-xs text-muted">
            {x.label}
          </span>
        ),
      )}
    </span>
  );
}

export function JournalEntryPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const access = useLedgerAccess();
  const q = useJournalEntry(access.companyWide ? id : undefined);
  const branches = useBranches();
  const cash = useCashAccounts(true);
  const label = useSourceLabel();
  const memo = useMemoLabel();
  const text = useLedgerText();

  if (!access.companyWide)
    return (
      <Card>
        <EmptyState
          title={t('accounting.companyScopeTitle')}
          description={t('accounting.companyScopeHint')}
        />
      </Card>
    );
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  const e = q.data;
  const src = sourceLink(e);
  const branchName = e.branchId
    ? (branches.data?.find((b) => b.id === e.branchId)?.name ?? '—')
    : t('accounting.entry.companyLevel');
  const cashNames = new Map((can('cash.read') ? (cash.data ?? []) : []).map((a) => [a.id, a.name]));
  const balanced = d(e.totalDebit).eq(e.totalCredit);

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: t('accounting.title'), to: '/app/accounting' },
          { label: t('accounting.tabs.journal'), to: '/app/accounting?tab=journal' },
          { label: `#${e.entryNo}` },
        ]}
        title={t('accounting.entry.title', { no: e.entryNo })}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="num">{fmtDate(e.entryDate)}</span>
            <Badge tone="neutral" dot={false}>
              {label(e.sourceType)}
            </Badge>
            {e.reversalOfId && <Badge tone="danger">{t('accounting.common.reversal')}</Badge>}
            {e.reversedById && <Badge tone="warning">{t('accounting.common.reversed')}</Badge>}
          </span>
        }
      />

      {e.reversalOfId && (
        <Alert tone="info" className="mb-4">
          {t('accounting.entry.isReversal')}{' '}
          <Link
            to={`/app/accounting/entries/${e.reversalOfId}`}
            className="font-medium text-brand-strong hover:underline"
          >
            {t('accounting.entry.openEntry')}
          </Link>
        </Alert>
      )}
      {e.reversedById && (
        <Alert tone="warning" className="mb-4">
          {t('accounting.entry.wasReversed')}{' '}
          <Link
            to={`/app/accounting/entries/${e.reversedById}`}
            className="font-medium text-brand-strong hover:underline"
          >
            {t('accounting.entry.openEntry')}
          </Link>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader
            title={t('accounting.entry.lines')}
            actions={
              balanced && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  {t('accounting.entry.balancedNote')}
                </span>
              )
            }
          />
          <ReportTable minWidth={640}>
            <thead>
              <tr>
                <Th>{t('accounting.common.account')}</Th>
                <Th>{t('accounting.journal.memo')}</Th>
                <Th>{t('accounting.entry.dimensions')}</Th>
                <Th end>{t('accounting.common.debit')}</Th>
                <Th end>{t('accounting.common.credit')}</Th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.id} className="border-b border-line">
                  <Td>
                    <span className="num me-2 text-xs text-muted">{l.accountCode}</span>
                    <span className={d(l.debit).isZero() ? 'ps-4 font-medium' : 'font-medium'}>
                      {ledgerName(l, i18n.language)}
                    </span>
                  </Td>
                  <Td className="text-xs text-muted">{memo(l.memo) ?? '—'}</Td>
                  <Td>
                    <LineDimensions l={l} cashNames={cashNames} />
                  </Td>
                  <Td end>
                    <Amt value={l.debit} />
                  </Td>
                  <Td end>
                    <Amt value={l.credit} />
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line-strong bg-surface-2/40 font-semibold">
                <Td colSpan={3}>{t('accounting.common.total')}</Td>
                <Td end>
                  <Amt value={e.totalDebit} strong />
                </Td>
                <Td end>
                  <Amt value={e.totalCredit} strong />
                </Td>
              </tr>
            </tfoot>
          </ReportTable>
        </Card>

        <Card className="min-w-0">
          <CardBody>
            <DescriptionList
              columns={1}
              items={[
                { label: t('common.description'), value: text(e.description) },
                {
                  label: t('accounting.entry.source'),
                  value: src ? (
                    <Link
                      to={src}
                      className="inline-flex items-center gap-1 font-medium text-brand-strong hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      {label(e.sourceType)}
                    </Link>
                  ) : (
                    label(e.sourceType)
                  ),
                },
                { label: t('accounting.entry.event'), value: <code className="num text-xs">{e.event}</code> },
                {
                  label: t('accounting.entry.date'),
                  value: <span className="num">{fmtDate(e.entryDate)}</span>,
                },
                { label: t('accounting.entry.branch'), value: branchName },
                { label: t('accounting.entry.createdBy'), value: e.createdByName },
                { label: t('accounting.entry.createdAt'), value: fmtDateTime(e.createdAt) },
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
