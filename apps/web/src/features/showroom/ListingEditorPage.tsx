import { CarFront } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { useVehicle } from '@/features/vehicles/api';
import { VehicleStatusBadge, vehicleTitle } from '@/features/vehicles/components';
import { ListingPanel } from './ListingPanel';

/** The vehicle's showroom listing on its own page (linked from the listings list and aging advice). */
export function ListingEditorPage() {
  const { vehicleId } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const q = useVehicle(vehicleId);
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const v = d.vehicle;
  const title = vehicleTitle(
    { modelYear: v.modelYear, trim: v.trim, makeNameEn: d.make.nameEn, makeNameAr: d.make.nameAr, modelNameEn: d.model.nameEn, modelNameAr: d.model.nameAr },
    i18n.language,
  );
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('showroom.nav.listings'), to: '/app/showroom' }, { label: v.stockNumber }, { label: t('showroom.editorPage.breadcrumb') }]}
        title={title}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="num">{v.stockNumber}</span>
            <VehicleStatusBadge status={v.status} />
          </span>
        }
        actions={
          <Button variant="secondary" icon={<CarFront className="h-4 w-4" />} onClick={() => navigate(`/app/vehicles/${v.id}`)}>
            {t('showroom.actions.openVehicle')}
          </Button>
        }
      />
      <ListingPanel d={d} />
    </>
  );
}
