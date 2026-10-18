import { ArrowLeftRight, Plus, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Field';
import { PageHeader, Toolbar } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { useApi, useListParams } from '@/lib/hooks';
import { CashTransfer, Paged, useCashAccounts } from './api';
import { TransfersTable } from './components';
import { DateRange } from './finance-ui';
import { TransferFormModal } from './TransferFormModal';

export function TransfersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const lp = useListParams();
  const accounts = useCashAccounts(true);
  const [creating, setCreating] = useState(false);
  const filters = {
    cashAccountId: lp.get('account') || undefined,
    status: lp.get('status') || undefined,
    from: lp.get('from') || undefined,
    to: lp.get('to') || undefined,
  };
  const q = useApi<Paged<CashTransfer>>(
    ['cash-transfers', 'list'],
    '/cash/transfers',
    { ...filters, page: lp.page, pageSize: 25 },
    { placeholderData: (p) => p },
  );
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title={t('cash.transfers.title')}
        subtitle={t('cash.transfers.subtitle')}
        actions={
          <Can perm="cash.transfer">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              {t('cash.transfers.add')}
            </Button>
          </Can>
        }
      />
      <Card>
        <Toolbar>
          <Select
            className="w-full sm:w-auto sm:min-w-[200px]"
            value={lp.get('account')}
            onChange={(e) => lp.set({ account: e.target.value })}
            aria-label={t('cash.transfers.account')}
          >
            <option value="">{t('cash.transfers.allAccounts')}</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </Select>
          <Select
            className="w-full sm:w-auto sm:min-w-[150px]"
            value={lp.get('status')}
            onChange={(e) => lp.set({ status: e.target.value })}
            aria-label={t('common.status')}
          >
            <option value="">
              {t('common.status')}: {t('common.all')}
            </option>
            <option value="posted">{t('cash.enums.transferStatus.posted')}</option>
            <option value="reversed">{t('cash.enums.transferStatus.reversed')}</option>
          </Select>
          <DateRange from={lp.get('from')} to={lp.get('to')} onChange={(v) => lp.set(v)} />
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={() => lp.set({ account: null, status: null, from: null, to: null })}
            >
              {t('common.clearFilters')}
            </Button>
          )}
        </Toolbar>
        <TransfersTable
          data={q.data}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          page={lp.page}
          onPage={(p) => lp.set({ page: p }, false)}
          emptyAction={
            !filtered &&
            can('cash.transfer') && (
              <Button icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setCreating(true)}>
                {t('cash.transfers.add')}
              </Button>
            )
          }
        />
      </Card>
      {creating && (
        <TransferFormModal
          onClose={() => setCreating(false)}
          onDone={(tr) => {
            setCreating(false);
            navigate(`/app/cash/transfers/${tr.transferId}`);
          }}
        />
      )}
    </>
  );
}
