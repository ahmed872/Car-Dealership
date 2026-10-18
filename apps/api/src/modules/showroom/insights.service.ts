import { Injectable } from '@nestjs/common';
import { d, todayInZone, UNSOLD_STATUSES } from '@autohub/shared';
import { assertBranchAccess, hasPermission, TenantContext } from '../../common/context';
import { notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { visibleStatuses } from './showroom-common';

const MIN_COMPARABLES = 3;

function median(values: string[]): string | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => d(a).cmp(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? d(s[mid]!).toFixed(2) : d(s[mid - 1]!).plus(s[mid]!).div(2).toFixed(2);
}

/**
 * Price guidance and aging recommendations from the company's OWN history (D-037). Always labelled
 * as an estimate with its basis; with fewer than three comparable sales no figure is offered.
 * No external market data is used or implied.
 */
@Injectable()
export class InsightsService {
  constructor(private readonly dbs: DbService) {}

  /** Recognised sales of similar vehicles, limited to the branches the user may see. */
  private async comparables(ctx: TenantContext, vehicleId: string) {
    return this.dbs.query<{ agreed_price: string; sale_date: string; model_year: number; odometer_value: number | null; days_to_sell: number | null }>(
      `SELECT s.agreed_price::text, s.sale_date::text, cv.model_year, cv.odometer_value,
              (s.recognition_date - (cv.stocked_at AT TIME ZONE 'UTC')::date)::int AS days_to_sell
         FROM vehicles v
         JOIN vehicles cv ON cv.make_id = v.make_id AND cv.model_id = v.model_id AND cv.id <> v.id
                         AND cv.model_year BETWEEN v.model_year - 2 AND v.model_year + 2
         JOIN sales s ON s.vehicle_id = cv.id AND s.recognized_at IS NOT NULL AND s.status IN ('confirmed', 'delivered')
        WHERE v.id = $1 AND ($2::boolean OR s.branch_id = ANY($3::uuid[]))
        ORDER BY s.sale_date DESC
        LIMIT 50`,
      [vehicleId, ctx.allBranches, ctx.branchIds],
    );
  }

  async priceGuidance(ctx: TenantContext, vehicleId: string) {
    const [v] = await this.dbs.query<{ branch_id: string; asking_price: string | null; model_year: number }>(
      `SELECT branch_id, asking_price::text, model_year FROM vehicles WHERE id = $1`,
      [vehicleId],
    );
    if (!v) throw notFound('Vehicle');
    assertBranchAccess(ctx, v.branch_id);
    const comps = await this.comparables(ctx, vehicleId);
    const prices = comps.map((c) => c.agreed_price);
    const enough = comps.length >= MIN_COMPARABLES;
    const days = comps.map((c) => c.days_to_sell).filter((x): x is number => x !== null && x >= 0);
    return {
      estimate: true,
      basis: 'own_sales',
      criteria: 'Same make and model, model year within ±2, recognised sales',
      comparableCount: comps.length,
      sufficient: enough,
      agreedPrice: enough
        ? {
            min: d(prices.reduce((a, b) => (d(a).lt(b) ? a : b))).toFixed(2),
            median: median(prices),
            max: d(prices.reduce((a, b) => (d(a).gt(b) ? a : b))).toFixed(2),
          }
        : null,
      averageDaysToSell: enough && days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null,
      askingPrice: v.asking_price,
      askingVsMedianPct: enough && v.asking_price ? d(v.asking_price).minus(median(prices)!).div(median(prices)!).times(100).toFixed(1) : null,
      // Individual sales are shown only to users who may read sales; others get the aggregates.
      comparables: !hasPermission(ctx, 'sales.read') ? [] : comps.slice(0, 10).map((c) => ({ agreedPrice: c.agreed_price, saleDate: c.sale_date, modelYear: c.model_year, odometer: c.odometer_value })),
    };
  }

  /** Rule-based suggestions for vehicles past the company's stale-stock threshold. */
  async agingRecommendations(ctx: TenantContext) {
    const s = ctx.tenant.settings;
    const today = todayInZone(s.timezone);
    const params: unknown[] = [UNSOLD_STATUSES, s.inventory.staleDaysWarning, today, s.timezone];
    const scope = ctx.allBranches ? '' : `AND v.branch_id = ANY($5::uuid[])`;
    if (!ctx.allBranches) params.push(ctx.branchIds.length ? ctx.branchIds : ['00000000-0000-0000-0000-000000000000']);
    const rows = await this.dbs.query<{
      id: string;
      stock_number: string;
      status: string;
      days: number;
      asking_price: string | null;
      published: boolean;
      public_photos: number;
    }>(
      `SELECT v.id, v.stock_number, v.status, ($3::date - (v.stocked_at AT TIME ZONE $4)::date)::int AS days, v.asking_price::text,
              coalesce(l.is_published, false) AS published,
              (SELECT count(*)::int FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_public AND m.kind = 'photo' AND m.category = 'general') AS public_photos
         FROM vehicles v LEFT JOIN vehicle_listings l ON l.vehicle_id = v.id
        WHERE v.status = ANY($1::text[]) AND ($3::date - (v.stocked_at AT TIME ZONE $4)::date) >= $2::int ${scope}
        ORDER BY days DESC
        LIMIT 500`,
      params,
    );
    const listable = visibleStatuses(s);
    const out = [];
    for (const r of rows) {
      const actions: Array<{ code: string; detail?: Record<string, unknown> }> = [];
      if (r.days >= s.inventory.staleDaysCritical) actions.push({ code: 'critical_age', detail: { days: r.days, threshold: s.inventory.staleDaysCritical } });
      if (!r.asking_price) actions.push({ code: 'set_price' });
      if (s.showroom.enabled && !r.published && listable.includes(r.status)) actions.push({ code: 'publish_listing' });
      if (r.public_photos < 3) actions.push({ code: 'add_photos', detail: { publicPhotos: r.public_photos } });
      if (r.asking_price) {
        const comps = await this.comparables(ctx, r.id);
        if (comps.length >= MIN_COMPARABLES) {
          const med = median(comps.map((c) => c.agreed_price))!;
          if (d(r.asking_price).gt(d(med).times('1.05'))) actions.push({ code: 'review_price', detail: { askingPrice: r.asking_price, medianAgreedPrice: med, comparableCount: comps.length } });
        }
      }
      out.push({ vehicleId: r.id, stockNumber: r.stock_number, status: r.status, daysInStock: r.days, actions });
    }
    return { basis: 'rules_and_own_sales', staleDaysWarning: s.inventory.staleDaysWarning, staleDaysCritical: s.inventory.staleDaysCritical, items: out };
  }
}
