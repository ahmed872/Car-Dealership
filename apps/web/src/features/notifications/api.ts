import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';

export type Severity = 'info' | 'success' | 'warning' | 'danger';

/** A row of GET /notifications (the caller's own inbox). */
export interface AppNotification {
  id: string;
  userId: string;
  type: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string | null;
  bodyEn: string | null;
  link: string | null;
  entityType: string | null;
  entityId: string | null;
  severity: Severity;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: AppNotification[];
  total: number;
  page: number;
  pageSize: number;
}

/** Unread badge count; polled every 60 s while the tab is visible. */
export const useUnreadCount = (enabled = true) =>
  useApi<{ unread: number }>(['notifications', 'unread'], enabled ? '/notifications/unread-count' : null, undefined, {
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });

export function useMarkAllRead() {
  const { t } = useTranslation();
  return useApiMutation<Record<string, never>, { updated: number }>({
    path: '/notifications/read-all',
    invalidate: [['notifications']],
    success: (r) => (r.updated ? t('notifications.allMarked') : null),
    body: () => ({}),
  });
}

/** Localised title / body of a notification. */
export function useNotificationText() {
  const { i18n } = useTranslation();
  const en = i18n.language === 'en';
  return (n: AppNotification) => ({ title: en ? n.titleEn : n.titleAr, body: en ? n.bodyEn : n.bodyAr });
}

/**
 * Opens a notification: marks it read (when unread) and follows its in-app link. Links are
 * app paths written by the server (e.g. /app/leads/…); anything else is not navigated to.
 */
export function useOpenNotification() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useCallback(
    async (n: AppNotification) => {
      if (!n.readAt) {
        try {
          await api(`/notifications/${n.id}/read`, { method: 'POST' });
        } finally {
          void qc.invalidateQueries({ queryKey: ['notifications'] });
        }
      }
      if (n.link && n.link.startsWith('/app/')) navigate(n.link);
    },
    [qc, navigate],
  );
}

export function useMarkRead() {
  return useApiMutation<{ id: string }, AppNotification>({
    path: (v) => `/notifications/${v.id}/read`,
    body: () => ({}),
    invalidate: [['notifications']],
    success: null,
  });
}

/** Short relative time ("3 min ago") in the UI language. */
export function relativeTime(iso: string, lang: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(lang === 'en' ? 'en' : 'ar', { numeric: 'auto', style: 'short' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 30 * 86400) return rtf.format(Math.round(diff / 86400), 'day');
  return rtf.format(Math.round(diff / (30 * 86400)), 'month');
}
