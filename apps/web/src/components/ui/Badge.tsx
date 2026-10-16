import clsx from 'clsx';
import { ReactNode } from 'react';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'brand';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  success: 'bg-success-soft text-success border-success/25',
  warning: 'bg-warning-soft text-warning border-warning/25',
  danger: 'bg-danger-soft text-danger border-danger/25',
  info: 'bg-info-soft text-info border-info/25',
  accent: 'bg-accent-soft text-accent border-accent/25',
  brand: 'bg-brand-soft text-brand-strong border-brand/30',
};

const dotShapes: Record<Tone, string> = {
  // Shape varies with tone so status is not conveyed by colour alone.
  neutral: 'rounded-full',
  success: 'rounded-full',
  warning: 'rotate-45 rounded-[1px]',
  danger: 'rounded-[1px]',
  info: 'rounded-full',
  accent: 'rotate-45 rounded-[1px]',
  brand: 'rounded-full',
};

export function Badge({
  tone = 'neutral',
  children,
  dot = true,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className={clsx('inline-block h-1.5 w-1.5 bg-current', dotShapes[tone])} />}
      {children}
    </span>
  );
}
