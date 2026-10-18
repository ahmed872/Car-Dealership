import clsx from 'clsx';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { VEHICLE_STATUS_LABELS, VehicleStatus } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Field';
import { Toolbar } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { Money, Stat } from '@/features/cash/finance-ui';
import { detailRoute, Reconciliation } from './api';
import { BalanceCheck, ReportTable, Td, Th } from './components';

type LP = ReturnType<typeof useListParams>;
type Section = Reconciliation['sections'][number];
type Mismatch = Section['mismatches'][number];

/** Page of the sub-ledger item behind a mismatch (cash account, vehicle or supplier). */
function itemLink(section: Section['name'], key: string | null): string | null {
  if (!key) return null;
  if (section === 'cash') return detailRoute('cash/accounts', key);
  if (section === 'inventory') return detailRoute('vehicles', key);
  return detailRoute('purchasing/suppliers', key);
}

function ItemLabel({ section, m }: { section: Section['name']; m: Mismatch }) {
  const { t, i18n } = useTranslation();
  if (m.key === null) {
    const k =
      section === 'cash' ? 'noCashAccount' : section === 'inventory' ? 'noVehicle' : 'directPurchases';
    return <span className="font-medium">{t(`accounting.reconciliation.${k}`)}</span>;
  }
  const to = itemLink(section, m.key);
  const extra =
    section === 'cash' && typeof m.currency === 'string'
      ? m.currency
      : section === 'inventory' && typeof m.vehicleStatus === 'string'
        ? (VEHICLE_STATUS_LABELS[m.vehicleStatus as VehicleStatus]?.[i18n.language === 'en' ? 'en' : 'ar'] ??
          m.vehicleStatus)
        : null;
  return (
    <span>
      {to ? (
        <Link to={to} className="font-medium text-brand-strong hover:underline">
          <bdi>{m.label}</bdi>
        </Link>
      ) : (
        <bdi className="font-medium">{m.label}</bdi>
      )}
      {extra && <span className="ms-2 text-xs text-muted">({extra})</span>}
    </span>
  );
}

function SectionCard({ s }: { s: Section }) {
  const { t } = useTranslation();
  const { currency } = useAuth();
  return (
    <Card className={clsx(!s.ok && 'border-danger/40')}>
      <CardHeader
        title={t(`accounting.reconciliation.section.${s.name}`)}
        actions={
          s.ok ? (
            <Badge tone="success">{t('accounting.reconciliation.ok')}</Badge>
          ) : (
            <Badge tone="danger">{t('accounting.reconciliation.mismatch')}</Badge>
          )
        }
      />
      <div className="grid grid-cols-1 gap-4 border-b border-line px-5 py-4 sm:grid-cols-3">
        <Stat label={t('accounting.reconciliation.subledger')}>
          <Money value={s.subledgerTotal} currency={currency} />
        </Stat>
        <Stat label={t('accounting.reconciliation.gl')}>
          <Money value={s.glTotal} currency={currency} />
        </Stat>
        <Stat label={t('accounting.reconciliation.difference')}>
          <Money
            value={s.difference}
            currency={currency}
            signed
            className={s.ok ? 'text-success' : 'font-semibold text-danger'}
          />
        </Stat>
      </div>
      {s.mismatches.length === 0 ? (
        <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted">
          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
          {t('accounting.reconciliation.noMismatches')}
        </p>
      ) : (
        <>
          <p className="px-5 pt-3 text-[13px] font-medium text-danger">
            {t('accounting.reconciliation.mismatchCount', { count: s.mismatchCount })}
            {s.mismatches.length < s.mismatchCount &&
              ` — ${t('accounting.reconciliation.truncated', { shown: s.mismatches.length, count: s.mismatchCount })}`}
          </p>
          <div className="px-0 pt-2">
            <ReportTable minWidth={620}>
              <thead>
                <tr>
                  <Th>{t('accounting.reconciliation.item')}</Th>
                  <Th end>{t('accounting.reconciliation.subledger')}</Th>
                  <Th end>{t('accounting.reconciliation.gl')}</Th>
                  <Th end>{t('accounting.reconciliation.difference')}</Th>
                </tr>
              </thead>
              <tbody>
                {s.mismatches.map((m, i) => (
                  <tr key={m.key ?? `none-${i}`} className="border-b border-danger/20 bg-danger-soft/60">
                    <Td>
                      <ItemLabel section={s.name} m={m} />
                    </Td>
                    <Td end>
                      <Money value={m.subledgerBase} currency={currency} />
                    </Td>
                    <Td end>
                      <Money value={m.glBase} currency={currency} />
                    </Td>
                    <Td end>
                      <Money
                        value={m.difference}
                        currency={currency}
                        signed
                        className="font-semibold text-danger"
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>
          </div>
        </>
      )}
    </Card>
  );
}

export function ReconciliationTab({ lp }: { lp: LP }) {
  const { t } = useTranslation();
  const { currency } = useAuth();
  const asOf = lp.get('asOf');
  const q = useApi<Reconciliation>(['ledger', 'reconciliation'], '/ledger/reconciliation', {
    asOf: asOf || undefined,
  });

  return (
    <div className="space-y-4">
      <Card>
        <Toolbar className="justify-between border-b-0">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">{t('accounting.reconciliation.title')}</h2>
            <p className="text-[13px] text-muted">{t('accounting.reconciliation.subtitle')}</p>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <span className="whitespace-nowrap">{t('accounting.common.asOf')}</span>
            <Input
              type="date"
              className="w-auto min-w-[150px]"
              value={asOf}
              onChange={(e) => lp.set({ asOf: e.target.value })}
            />
          </label>
        </Toolbar>
      </Card>
      {q.isLoading ? (
        <PageLoader />
      ) : q.error || !q.data ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        <>
          {q.data.ok ? (
            <Alert tone="success" title={t('accounting.reconciliation.allOk')}>
              {t('accounting.reconciliation.allOkHint', { date: fmtDate(q.data.asOf) })}
            </Alert>
          ) : (
            <Alert tone="danger" title={t('accounting.reconciliation.issues')}>
              {t('accounting.reconciliation.issuesHint')}
            </Alert>
          )}
          <Card className={clsx(!q.data.trialBalance.isBalanced && 'border-danger/40')}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="flex items-center gap-2">
                {q.data.trialBalance.isBalanced ? (
                  <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />
                ) : (
                  <ShieldAlert className="h-5 w-5 text-danger" aria-hidden />
                )}
                <span className="text-sm font-semibold text-ink">
                  {t('accounting.reconciliation.trialBalance')}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[13px]">
                <span>
                  {t('accounting.common.debit')}:{' '}
                  <Money value={q.data.trialBalance.totalDebit} currency={currency} />
                </span>
                <span>
                  {t('accounting.common.credit')}:{' '}
                  <Money value={q.data.trialBalance.totalCredit} currency={currency} />
                </span>
                <BalanceCheck
                  ok={q.data.trialBalance.isBalanced}
                  okLabel={t('accounting.reconciliation.trialOk')}
                  badLabel={t('accounting.reconciliation.trialBad')}
                />
              </div>
            </div>
          </Card>
          {q.data.sections.map((s) => (
            <SectionCard key={s.name} s={s} />
          ))}
        </>
      )}
    </div>
  );
}
