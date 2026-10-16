import { CurrencyCode, Dec, d, money } from '../money';

export interface PriceEvaluationInput {
  askingPrice: string | null;
  floorPrice: string | null;
  agreedPrice: string;
  /** Maximum discount (percent of asking price) the acting user's role may grant. */
  maxDiscountPct: string;
  currency: CurrencyCode;
}

export interface PriceEvaluation {
  discountAmount: string;
  discountPct: string;
  belowFloor: boolean;
  exceedsRoleLimit: boolean;
  requiresApproval: boolean;
  /** The permission an approver needs; floor breaches need the stronger one. */
  approvalPermission: 'sales.approve_below_floor' | 'sales.approve_discount' | null;
}

export function evaluateSalePrice(input: PriceEvaluationInput): PriceEvaluation {
  const cur = input.currency;
  const agreed = d(input.agreedPrice);
  if (agreed.lte(0)) throw new Error('Agreed price must be positive');
  const asking = input.askingPrice ? d(input.askingPrice) : null;
  const floor = input.floorPrice ? d(input.floorPrice) : null;

  const discount = asking && agreed.lt(asking) ? asking.minus(agreed) : new Dec(0);
  const discountPct = asking && asking.gt(0) ? discount.dividedBy(asking).times(100).toDecimalPlaces(4) : new Dec(0);
  const belowFloor = floor !== null && agreed.lt(floor);
  const exceedsRoleLimit = discountPct.gt(d(input.maxDiscountPct));
  return {
    discountAmount: money(discount, cur),
    discountPct: discountPct.toFixed(4),
    belowFloor,
    exceedsRoleLimit,
    requiresApproval: belowFloor || exceedsRoleLimit,
    approvalPermission: belowFloor ? 'sales.approve_below_floor' : exceedsRoleLimit ? 'sales.approve_discount' : null,
  };
}

export interface ProfitMetrics {
  grossProfit: string;
  /** Gross profit as % of net revenue. */
  marginPct: string | null;
  /** Gross profit as % of cost. */
  markupPct: string | null;
}

export function profitMetrics(netRevenue: string, cost: string, currency: CurrencyCode): ProfitMetrics {
  const rev = d(netRevenue);
  const c = d(cost);
  const gp = rev.minus(c);
  return {
    grossProfit: money(gp, currency),
    marginPct: rev.isZero() ? null : gp.dividedBy(rev).times(100).toDecimalPlaces(2).toFixed(2),
    markupPct: c.isZero() ? null : gp.dividedBy(c).times(100).toDecimalPlaces(2).toFixed(2),
  };
}

/** Asking price that achieves a target margin (% of net price) over cost. */
export function priceForTargetMargin(cost: string, targetMarginPct: string, currency: CurrencyCode): string {
  const m = d(targetMarginPct);
  if (m.gte(100) || m.isNegative()) throw new Error('Target margin must be in [0, 100)');
  return money(d(cost).dividedBy(new Dec(1).minus(m.dividedBy(100))), currency);
}
