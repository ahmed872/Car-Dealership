import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/Feedback';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/lib/hooks';
import { useLedgerAccess } from './api';
import { JournalTab } from './JournalTab';
import { ReconciliationTab } from './ReconciliationTab';
import { AccountsTab, BalanceSheetTab, IncomeStatementTab, TrialBalanceTab } from './ReportTabs';
import { StatementTab } from './StatementTab';

const TABS = ['accounts', 'trial', 'journal', 'statement', 'income', 'balance', 'reconciliation'] as const;
type TabKey = (typeof TABS)[number];

/** Single entry point for the general ledger: chart of accounts, journal and the financial reports. */
export function LedgerPage() {
  const { t } = useTranslation();
  const { currency } = useAuth();
  const access = useLedgerAccess();
  const lp = useListParams();
  const raw = lp.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(raw) ? (raw as TabKey) : 'accounts';

  return (
    <>
      <PageHeader title={t('accounting.title')} subtitle={t('accounting.subtitle', { base: currency })} />
      {!access.companyWide ? (
        <Card>
          <EmptyState
            icon={<ShieldAlert className="h-5 w-5" />}
            title={t('accounting.companyScopeTitle')}
            description={t('accounting.companyScopeHint')}
          />
        </Card>
      ) : (
        <>
          <div className="mb-4">
            <Tabs
              value={tab}
              onChange={(k) => lp.set({ tab: k === 'accounts' ? null : k, page: null })}
              tabs={TABS.map((k) => ({ key: k, label: t(`accounting.tabs.${k}`) }))}
            />
          </div>
          {tab === 'accounts' && <AccountsTab lp={lp} />}
          {tab === 'trial' && <TrialBalanceTab lp={lp} />}
          {tab === 'journal' && <JournalTab lp={lp} />}
          {tab === 'statement' && <StatementTab lp={lp} />}
          {tab === 'income' && <IncomeStatementTab lp={lp} />}
          {tab === 'balance' && <BalanceSheetTab lp={lp} />}
          {tab === 'reconciliation' && <ReconciliationTab lp={lp} />}
        </>
      )}
    </>
  );
}
