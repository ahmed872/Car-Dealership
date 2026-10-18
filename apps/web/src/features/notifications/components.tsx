import clsx from 'clsx';
import { AlertTriangle, Bell, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppNotification, relativeTime, Severity, useNotificationText } from './api';

const SEVERITY: Record<Severity, { Icon: typeof Info; cls: string }> = {
  info: { Icon: Info, cls: 'bg-info-soft text-info' },
  success: { Icon: CheckCircle2, cls: 'bg-success-soft text-success' },
  warning: { Icon: AlertTriangle, cls: 'bg-warning-soft text-warning' },
  danger: { Icon: XCircle, cls: 'bg-danger-soft text-danger' },
};

export function SeverityIcon({ severity, unread, className }: { severity: Severity; unread?: boolean; className?: string }) {
  const { t } = useTranslation();
  const s = SEVERITY[severity] ?? { Icon: Bell, cls: 'bg-surface-2 text-muted' };
  return (
    <span className={clsx('relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full', s.cls, className)}>
      <s.Icon className="h-4 w-4" aria-hidden />
      {unread && <span className="absolute -top-0.5 -end-0.5 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-surface" role="img" aria-label={t('notifications.unread')} />}
    </span>
  );
}

/** One notification line (title, body, relative time, unread dot). */
export function NotificationLine({ n, compact }: { n: AppNotification; compact?: boolean }) {
  const { i18n } = useTranslation();
  const text = useNotificationText();
  const { title, body } = text(n);
  return (
    <span className="flex min-w-0 flex-1 items-start gap-3 text-start">
      <SeverityIcon severity={n.severity} unread={!n.readAt} />
      <span className="min-w-0 flex-1">
        <span className={clsx('block text-[13.5px] text-ink', !n.readAt && 'font-semibold', compact && 'line-clamp-2')}>{title}</span>
        {body && <span className={clsx('mt-0.5 block text-xs text-muted', compact && 'truncate')}>{body}</span>}
        <span className="mt-1 block text-[11.5px] text-subtle" title={new Date(n.createdAt).toLocaleString()}>
          {relativeTime(n.createdAt, i18n.language)}
        </span>
      </span>
    </span>
  );
}
