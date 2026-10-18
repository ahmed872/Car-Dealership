import { Bell, Check, CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pagination } from '@/components/ui/DataTable';
import { EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { NotificationPage, useMarkAllRead, useMarkRead, useOpenNotification, useUnreadCount } from './api';
import { NotificationLine } from './components';

type Filter = 'all' | 'unread';
const PAGE_SIZE = 20;

/** The signed-in user's full notification inbox. */
export function NotificationsPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const q = useApi<NotificationPage>(['notifications', 'page'], '/notifications', { page, pageSize: PAGE_SIZE, unread: filter === 'unread' ? 'true' : undefined }, { placeholderData: (p) => p });
  const count = useUnreadCount();
  const markAll = useMarkAllRead();
  const markRead = useMarkRead();
  const openNotification = useOpenNotification();
  const unread = count.data?.unread ?? 0;

  return (
    <>
      <PageHeader
        title={t('notifications.title')}
        subtitle={t('notifications.subtitle', { count: unread })}
        actions={
          <Button variant="secondary" icon={<CheckCheck className="h-4 w-4" />} disabled={!unread} loading={markAll.isPending} onClick={() => markAll.mutate({})}>
            {t('notifications.markAllRead')}
          </Button>
        }
      />
      <Card>
        <div className="px-4 pt-2">
          <Tabs<Filter>
            value={filter}
            onChange={(f) => (setFilter(f), setPage(1))}
            tabs={[
              { key: 'all', label: t('common.all') },
              { key: 'unread', label: t('notifications.unreadTab'), count: unread },
            ]}
          />
        </div>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <PageLoader />
        ) : q.data.items.length === 0 ? (
          <EmptyState icon={<Bell className="h-5 w-5" />} title={filter === 'unread' ? t('notifications.noUnread') : t('notifications.empty')} description={t('notifications.emptyHint')} />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {q.data.items.map((n) => (
                <li key={n.id} className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center ${n.readAt ? '' : 'bg-brand-soft/25'}`}>
                  <button type="button" onClick={() => void openNotification(n)} className="flex min-w-0 flex-1 rounded-lg text-start" disabled={!n.link && !!n.readAt}>
                    <NotificationLine n={n} />
                  </button>
                  <div className="flex shrink-0 items-center gap-3 ps-11 sm:ps-0">
                    <span className="num text-xs text-subtle">{fmtDateTime(n.createdAt)}</span>
                    {!n.readAt && (
                      <Button size="sm" variant="ghost" icon={<Check className="h-4 w-4" />} loading={markRead.isPending && markRead.variables?.id === n.id} onClick={() => markRead.mutate({ id: n.id })}>
                        {t('notifications.markRead')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
