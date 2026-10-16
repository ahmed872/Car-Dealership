import clsx from 'clsx';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { EmptyState, ErrorState, Skeleton } from './Feedback';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Server sort key; omit for unsortable columns. */
  sortKey?: string;
  align?: 'start' | 'end' | 'center';
  className?: string;
  /** Hide on small screens (the row stays readable in a horizontal scroll). */
  hideOnMobile?: boolean;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  sort?: string;
  onSortChange?: (sort: string) => void;
  empty?: ReactNode;
  footer?: ReactNode;
  dense?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  onRowClick,
  sort,
  onSortChange,
  empty,
  footer,
  dense,
}: Props<T>) {
  const { t } = useTranslation();
  const sortField = sort?.replace(/^-/, '');
  const desc = sort?.startsWith('-');
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  return (
    <div className="w-full">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2/60">
              {columns.map((c) => {
                const active = c.sortKey && c.sortKey === sortField;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}
                    className={clsx(
                      'px-4 py-2.5 text-[12px] font-semibold tracking-wide text-muted whitespace-nowrap',
                      c.align === 'end' ? 'text-end' : c.align === 'center' ? 'text-center' : 'text-start',
                      c.hideOnMobile && 'hidden md:table-cell',
                      c.className,
                    )}
                  >
                    {c.sortKey && onSortChange ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-ink"
                        onClick={() => onSortChange(active && !desc ? `-${c.sortKey}` : c.sortKey!)}
                      >
                        {c.header}
                        {active &&
                          (desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading &&
              !rows &&
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-line">
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('px-4 py-3', c.hideOnMobile && 'hidden md:table-cell')}>
                      <Skeleton className="h-4 w-full max-w-[160px]" />
                    </td>
                  ))}
                </tr>
              ))}
            {rows?.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={clsx(
                  'border-b border-line last:border-0',
                  onRowClick && 'cursor-pointer hover:bg-surface-2/70 focus-visible:bg-surface-2',
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={clsx(
                      dense ? 'px-4 py-2' : 'px-4 py-3',
                      'align-middle',
                      c.align === 'end' ? 'text-end' : c.align === 'center' ? 'text-center' : 'text-start',
                      c.hideOnMobile && 'hidden md:table-cell',
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows &&
        rows.length === 0 &&
        !loading &&
        (empty ?? <EmptyState icon={<Inbox className="h-5 w-5" />} title={t('common.noResults')} />)}
      {footer}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-[13px] text-muted">
      <span className="num">{t('common.showing', { from, to, total })}</span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label={t('common.previous')}
        >
          <ChevronRight className="h-4 w-4 ltr:rotate-180" />
        </Button>
        <span className="num px-2">
          {page} / {pages}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label={t('common.next')}
        >
          <ChevronLeft className="h-4 w-4 ltr:rotate-180" />
        </Button>
      </div>
    </div>
  );
}
