import { ArrowLeft, FileBarChart2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { ReportDef, useAllowedReports } from './api';

function ReportCard({ def }: { def: ReportDef }) {
  const { t } = useTranslation();
  const Icon = def.icon;
  return (
    <Link
      to={`/app/reports/${def.key}`}
      className="card group flex h-full flex-col gap-3 p-5 transition hover:border-line-strong hover:shadow-pop"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-strong">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">{t(`reports.catalog.${def.i18nKey}.title`)}</h3>
          <p className="mt-1 text-[13px] text-muted">{t(`reports.catalog.${def.i18nKey}.description`)}</p>
        </div>
      </div>
      <span className="mt-auto inline-flex items-center gap-1 text-[13px] font-medium text-brand-strong group-hover:underline">
        {t('reports.hub.open')}
        <ArrowLeft className="h-3.5 w-3.5 ltr:rotate-180" aria-hidden />
      </span>
    </Link>
  );
}

/** /app/reports — the reports the user may open, operational and financial. */
export function ReportsHubPage() {
  const { t } = useTranslation();
  const allowed = useAllowedReports();
  const groups = (['operational', 'financial'] as const).map((kind) => ({ kind, items: allowed.filter((r) => r.kind === kind) })).filter((g) => g.items.length);
  return (
    <>
      <PageHeader title={t('reports.hub.title')} subtitle={t('reports.hub.subtitle')} />
      {groups.length === 0 ? (
        <Card>
          <EmptyState icon={<FileBarChart2 className="h-5 w-5" />} title={t('reports.hub.empty')} description={t('reports.hub.emptyHint')} />
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.kind} aria-labelledby={`reports-${g.kind}`}>
              <h2 id={`reports-${g.kind}`} className="mb-3 text-[13px] font-semibold tracking-wide text-muted">
                {t(`reports.hub.${g.kind}`)}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {g.items.map((r) => (
                  <ReportCard key={r.key} def={r} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
