import clsx from 'clsx';
import { ChevronLeft } from 'lucide-react';
import { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Array<{ label: ReactNode; to?: string }>;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumbs && (
          <nav
            aria-label="breadcrumb"
            className="mb-1 flex flex-wrap items-center gap-1 text-[12.5px] text-muted"
          >
            {breadcrumbs.map((b, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                {b.to ? (
                  <Link to={b.to} className="hover:text-ink">
                    {b.label}
                  </Link>
                ) : (
                  <span>{b.label}</span>
                )}
                {i < breadcrumbs.length - 1 && <ChevronLeft className="h-3 w-3 ltr:rotate-180" aria-hidden />}
              </span>
            ))}
          </nav>
        )}
        <h1 className="truncate text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ key: T; label: ReactNode; count?: number }>;
  value: T;
  onChange: (k: T) => void;
}) {
  return (
    <div role="tablist" className="scrollbar-thin -mb-px flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          type="button"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={clsx(
            'inline-flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.key ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="num rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={clsx(
        'grid gap-5 border-b border-line py-6 first:pt-0 last:border-0 lg:grid-cols-[260px_1fr]',
        className,
      )}
    >
      <div>
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-wrap items-center gap-2 border-b border-line px-4 py-3', className)}>
      {children}
    </div>
  );
}
