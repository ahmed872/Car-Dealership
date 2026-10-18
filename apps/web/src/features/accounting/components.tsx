import clsx from 'clsx';
import { ReactNode, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { d } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Field';
import { useAuth } from '@/lib/auth';
import { useBranches } from '@/pages/settings/BranchesPage';
import { Money } from '@/features/cash/finance-ui';
import { categoryName, useExpenseCategories } from '@/features/expenses/api';
import type { LedgerAccountType } from './api';

const TYPE_TONE: Record<LedgerAccountType, Tone> = {
  asset: 'info',
  liability: 'warning',
  equity: 'brand',
  income: 'success',
  expense: 'danger',
};

export function AccountTypeBadge({ type }: { type: LedgerAccountType }) {
  const { t } = useTranslation();
  return (
    <Badge tone={TYPE_TONE[type]} dot={false}>
      {t(`accounting.type.${type}`)}
    </Badge>
  );
}

/** A GL amount; zero shows as a dash so non-zero figures stand out. */
export function Amt({
  value,
  strong,
  className,
  signedTone,
}: {
  value: string;
  strong?: boolean;
  className?: string;
  signedTone?: boolean;
}) {
  const { currency } = useAuth();
  if (d(value).isZero()) return <span className="text-subtle">—</span>;
  return (
    <Money
      value={value}
      currency={currency}
      toneNegative={signedTone}
      className={clsx(strong && 'font-semibold', className)}
    />
  );
}

/** Horizontally scrollable report table (scrolls inside its card on small screens). */
export function ReportTable({ children, minWidth = 640 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  end,
  className,
}: {
  children?: ReactNode;
  end?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={clsx(
        'border-b border-line bg-surface-2/60 px-4 py-2.5 text-[12px] font-semibold whitespace-nowrap text-muted',
        end ? 'text-end' : 'text-start',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  end,
  className,
  colSpan,
}: {
  children?: ReactNode;
  end?: boolean;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={clsx('px-4 py-2.5 align-middle', end ? 'text-end' : 'text-start', className)}
    >
      {children}
    </td>
  );
}

/** Branch filter for period reports (entry-level branch); empty = whole company. */
export function BranchFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const branches = useBranches();
  const list = branches.data ?? [];
  if (list.length < 2) return null;
  return (
    <Select
      className="w-full sm:w-auto sm:min-w-[180px]"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={t('common.branch')}
    >
      <option value="">{t('accounting.common.allBranches')}</option>
      {list.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </Select>
  );
}

/** Balanced / unbalanced indicator. */
export function BalanceCheck({
  ok,
  okLabel,
  badLabel,
}: {
  ok: boolean;
  okLabel: ReactNode;
  badLabel: ReactNode;
}) {
  return <Badge tone={ok ? 'success' : 'danger'}>{ok ? okLabel : badLabel}</Badge>;
}

/**
 * Journal-line memos are codes the API writes ("transfer_in", "fx:transfer", "sale payment", an
 * expense category code, …): show them in words, falling back to the stored text.
 */
export function useMemoLabel() {
  const { t, i18n } = useTranslation();
  const categories = useExpenseCategories();
  const byCode = useMemo(() => new Map((categories.data ?? []).map((c) => [c.code, c])), [categories.data]);
  return useCallback(
    (memo: string | null | undefined): string | null => {
      if (!memo) return null;
      const head = memo.split(':')[0]!.trim().replace(/\s+/g, '_');
      const own = t(`accounting.memoCode.${head}`, { defaultValue: '' });
      if (own) return own;
      const kind = t(`cash.enums.kind.${head}`, { defaultValue: '' });
      if (kind) return kind;
      const category = byCode.get(memo);
      return category ? categoryName(category, i18n.language) : memo;
    },
    [t, i18n.language, byCode],
  );
}
