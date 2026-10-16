import clsx from 'clsx';
import { HTMLAttributes, ReactNode } from 'react';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('card', className)} {...rest} />;
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('p-5', className)} {...rest} />;
}

interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'brand';
  onClick?: () => void;
}

const toneIcon: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'bg-surface-2 text-muted',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  brand: 'bg-brand-soft text-brand-strong',
};

/** KPI tile. When clickable, it drills down to the records behind the number. */
export function StatCard({ label, value, hint, icon, tone = 'default', onClick }: StatCardProps) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={clsx(
        'card flex w-full items-start gap-3 p-4 text-start',
        onClick && 'transition hover:border-line-strong hover:shadow-pop',
      )}
    >
      {icon && (
        <span
          className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', toneIcon[tone])}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-muted">{label}</span>
        <span className="num mt-1 block truncate text-xl font-semibold text-ink">{value}</span>
        {hint && <span className="mt-0.5 block text-xs text-subtle">{hint}</span>}
      </span>
    </Comp>
  );
}

export function DescriptionList({
  items,
  columns = 2,
}: {
  items: Array<{ label: ReactNode; value: ReactNode; full?: boolean }>;
  columns?: 1 | 2 | 3;
}) {
  return (
    <dl
      className={clsx(
        'grid gap-x-6 gap-y-4',
        columns === 1 ? 'grid-cols-1' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3',
      )}
    >
      {items.map((it, i) => (
        <div key={i} className={clsx('min-w-0', it.full && 'sm:col-span-full')}>
          <dt className="text-xs text-muted">{it.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{it.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
