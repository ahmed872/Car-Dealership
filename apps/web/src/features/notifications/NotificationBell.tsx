import { Bell, CheckCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ErrorState, Spinner } from '@/components/ui/Feedback';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { NotificationPage, useMarkAllRead, useOpenNotification, useUnreadCount } from './api';
import { NotificationLine } from './components';

const LATEST = 8;

function BellMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = useUnreadCount();
  const latest = useApi<NotificationPage>(['notifications', 'latest'], open ? '/notifications' : null, { pageSize: LATEST });
  const markAll = useMarkAllRead();
  const openNotification = useOpenNotification();
  const unread = count.data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="sm:relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? t('notifications.bellUnread', { count: unread }) : t('notifications.bell')}
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-ink"
        data-testid="notification-bell"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="num absolute -top-0.5 -end-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10.5px] leading-none font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('notifications.title')}
          className="animate-in fixed inset-x-2 top-16 z-40 overflow-hidden rounded-xl border border-line bg-surface shadow-pop sm:absolute sm:inset-x-auto sm:end-0 sm:top-full sm:mt-2 sm:w-96"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <p className="text-sm font-semibold text-ink">{t('notifications.title')}</p>
            <button
              type="button"
              disabled={!unread || markAll.isPending}
              onClick={() => markAll.mutate({})}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-strong hover:underline disabled:cursor-not-allowed disabled:text-subtle disabled:no-underline"
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden />
              {t('notifications.markAllRead')}
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {latest.error ? (
              <ErrorState error={latest.error} onRetry={() => latest.refetch()} />
            ) : !latest.data ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : latest.data.items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted">{t('notifications.empty')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {latest.data.items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        void openNotification(n);
                      }}
                      className={`flex w-full px-4 py-3 hover:bg-surface-2 ${n.readAt ? '' : 'bg-brand-soft/30'}`}
                    >
                      <NotificationLine n={n} compact />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Link to="/app/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-4 py-2.5 text-center text-[13px] font-medium text-brand-strong hover:bg-surface-2">
            {t('notifications.viewAll')}
          </Link>
        </div>
      )}
    </div>
  );
}

/** Top-bar bell: unread count (polled every minute) and the latest notifications. */
export function NotificationBell() {
  const { me } = useAuth();
  if (!me?.tenant) return null;
  return <BellMenu />;
}
