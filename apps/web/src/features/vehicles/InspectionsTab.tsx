import { ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { fmtDateTime } from '@/lib/format';
import { VehicleDetail } from './api';

export function InspectionsTab({ d }: { d: VehicleDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Card>
      <DataTable
        rows={d.inspections}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/app/inspections/${r.id}`)}
        empty={<EmptyState icon={<ClipboardList className="h-5 w-5" />} title={t('vehicles.inspections.empty')} />}
        columns={[
          { key: 'n', header: '#', cell: (r) => <span className="num font-medium">{t('vehicles.inspections.version', { n: r.versionNo })}</span> },
          { key: 'type', header: t('vehicles.inspections.type'), cell: (r) => t(`vehicles.enums.inspectionType.${r.type}`) },
          {
            key: 'status',
            header: t('common.status'),
            cell: (r) => (
              <Badge tone={r.status === 'completed' ? 'success' : r.status === 'draft' ? 'warning' : 'neutral'}>{t(`vehicles.enums.inspectionStatus.${r.status}`)}</Badge>
            ),
          },
          {
            key: 'result',
            header: t('vehicles.inspections.result'),
            cell: (r) =>
              r.overallResult ? (
                <Badge tone={r.overallResult === 'pass' ? 'success' : r.overallResult === 'fail' ? 'danger' : 'warning'}>{t(`vehicles.enums.overall.${r.overallResult}`)}</Badge>
              ) : (
                '—'
              ),
          },
          { key: 'inspector', header: t('vehicles.inspections.inspector'), hideOnMobile: true, cell: (r) => r.inspectorName ?? '—' },
          { key: 'date', header: t('common.date'), hideOnMobile: true, cell: (r) => fmtDateTime(r.completedAt ?? r.startedAt) },
        ]}
      />
    </Card>
  );
}
