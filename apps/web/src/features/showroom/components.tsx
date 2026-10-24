import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VEHICLE_STATUS_LABELS, VehicleStatus } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonProps } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { DescriptionSource } from './api';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Listing title in the current language, falling back to the other language. */
export function listingTitle(l: { titleAr: string | null; titleEn: string | null }, lang: string, fallback = '—'): string {
  return (lang === 'en' ? (l.titleEn ?? l.titleAr) : (l.titleAr ?? l.titleEn)) ?? fallback;
}

export function PublishedBadge({ published }: { published: boolean | null }) {
  const { t } = useTranslation();
  if (published === null) return <Badge tone="neutral">{t('showroom.listingState.none')}</Badge>;
  return published ? <Badge tone="success">{t('showroom.listingState.published')}</Badge> : <Badge tone="neutral">{t('showroom.listingState.unpublished')}</Badge>;
}

export function VisibilityBadge({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  return visible ? <Badge tone="info">{t('showroom.visibility.public')}</Badge> : <Badge tone="warning">{t('showroom.visibility.hidden')}</Badge>;
}

export function DescriptionSourceBadge({ source }: { source: DescriptionSource | null }) {
  const { t } = useTranslation();
  if (!source) return null;
  return (
    <Badge tone={source === 'ai' ? 'accent' : source === 'template' ? 'neutral' : 'brand'} dot={false}>
      {t(`showroom.descriptionSource.${source}`)}
    </Badge>
  );
}

/** Plain-language reason a listing is not publicly visible. */
export function visibilityReason(code: string, t: T, lang: string, vehicleStatus: VehicleStatus): string {
  if (code === 'status_not_listed') {
    const label = VEHICLE_STATUS_LABELS[vehicleStatus]?.[lang === 'en' ? 'en' : 'ar'] ?? vehicleStatus;
    return t('showroom.visibility.reasons.status_not_listed', { status: label });
  }
  return t(`showroom.visibility.reasons.${code}`, { defaultValue: '' }) || t('showroom.visibility.reasons.unknown', { code });
}

/** Why a generated description fell back to the template (null when the AI text was used). */
export function fallbackReasonText(reason: string | null, t: T): string | null {
  if (!reason) return null;
  if (reason.startsWith('error:')) return t('showroom.generate.fallback.error', { detail: reason.slice('error:'.length) });
  return t(`showroom.generate.fallback.${reason}`, { defaultValue: '' }) || t('showroom.generate.fallback.unknown', { reason });
}

/** Explains why an online inquiry was stored without a lead. */
export function unlinkedReasonText(code: string, t: T): string {
  return t(`showroom.inquiries.reasons.${code}`, { defaultValue: '' }) || t('showroom.inquiries.reasons.other', { code });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label, copiedLabel, ...rest }: { text: string; label: string; copiedLabel: string } & Omit<ButtonProps, 'onClick'>) {
  const { t } = useTranslation();
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          toast.success(copiedLabel);
          setTimeout(() => setDone(false), 2000);
        } else toast.error(t('showroom.share.copyFailed'));
      }}
      {...rest}
    >
      {label}
    </Button>
  );
}
