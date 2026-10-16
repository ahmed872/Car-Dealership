import { CurrencyCode, Dec, d, money, roundMoney } from '../money';

export const COMMISSION_TYPES = ['pct_of_profit', 'pct_of_sale', 'fixed', 'tiered'] as const;
export type CommissionType = (typeof COMMISSION_TYPES)[number];

export const COMMISSION_EARN_ON = ['delivery', 'full_payment'] as const;
export type CommissionEarnOn = (typeof COMMISSION_EARN_ON)[number];

export interface CommissionTier {
  /** Lower bound (inclusive) of the band, in base currency. */
  from: string;
  ratePct: string;
}

export interface CommissionRule {
  type: CommissionType;
  ratePct?: string;
  fixedAmount?: string;
  tierBase?: 'profit' | 'sale';
  /** whole: the reached tier's rate applies to the entire base; marginal: each band at its own rate. */
  tierMode?: 'whole' | 'marginal';
  tiers?: CommissionTier[];
  minAmount?: string;
  capAmount?: string;
  /** When true, no commission is due if gross profit <= 0. */
  requirePositiveProfit?: boolean;
}

export interface CommissionInput {
  /** Net sale revenue (excluding tax). */
  saleNet: string;
  /** Net revenue − vehicle cost. */
  grossProfit: string;
  currency: CurrencyCode;
}

export interface CommissionResult {
  base: string;
  amount: string;
  explanation: string;
}

export function validateCommissionRule(rule: CommissionRule): string[] {
  const errors: string[] = [];
  const pct = (v: string | undefined, name: string) => {
    if (v === undefined || !/^\d{1,3}(\.\d{1,4})?$/.test(v) || d(v).gt(100)) errors.push(`${name} must be 0..100`);
  };
  if (rule.type === 'pct_of_profit' || rule.type === 'pct_of_sale') pct(rule.ratePct, 'ratePct');
  if (rule.type === 'fixed' && (rule.fixedAmount === undefined || d(rule.fixedAmount).isNegative())) {
    errors.push('fixedAmount must be >= 0');
  }
  if (rule.type === 'tiered') {
    if (!rule.tiers?.length) errors.push('tiers required');
    rule.tiers?.forEach((t, i) => pct(t.ratePct, `tiers[${i}].ratePct`));
    const froms = (rule.tiers ?? []).map((t) => d(t.from));
    for (let i = 1; i < froms.length; i++) if (!froms[i]!.gt(froms[i - 1]!)) errors.push('tiers must be strictly ascending');
    if (froms[0] && !froms[0].isZero()) errors.push('first tier must start at 0');
  }
  if (rule.minAmount && rule.capAmount && d(rule.minAmount).gt(rule.capAmount)) errors.push('minAmount > capAmount');
  return errors;
}

export function computeCommission(rule: CommissionRule, input: CommissionInput): CommissionResult {
  const cur = input.currency;
  const profit = d(input.grossProfit);
  const saleNet = d(input.saleNet);
  const zero = (why: string): CommissionResult => ({ base: money(0, cur), amount: money(0, cur), explanation: why });

  if (rule.requirePositiveProfit && profit.lte(0)) return zero('no commission: gross profit is not positive');

  let base: Dec;
  let amount: Dec;
  let explanation: string;
  switch (rule.type) {
    case 'pct_of_profit':
      base = Dec.max(profit, 0);
      amount = base.times(d(rule.ratePct ?? 0)).dividedBy(100);
      explanation = `${rule.ratePct}% of gross profit`;
      break;
    case 'pct_of_sale':
      base = saleNet;
      amount = base.times(d(rule.ratePct ?? 0)).dividedBy(100);
      explanation = `${rule.ratePct}% of net sale`;
      break;
    case 'fixed':
      base = saleNet;
      amount = d(rule.fixedAmount ?? 0);
      explanation = 'fixed amount per sale';
      break;
    case 'tiered': {
      base = rule.tierBase === 'sale' ? saleNet : Dec.max(profit, 0);
      const tiers = [...(rule.tiers ?? [])].sort((a, b) => d(a.from).comparedTo(d(b.from)));
      if (rule.tierMode === 'marginal') {
        amount = new Dec(0);
        for (let i = 0; i < tiers.length; i++) {
          const lo = d(tiers[i]!.from);
          const hi = tiers[i + 1] ? d(tiers[i + 1]!.from) : null;
          if (base.lte(lo)) break;
          const portion = (hi && base.gt(hi) ? hi : base).minus(lo);
          amount = amount.plus(portion.times(d(tiers[i]!.ratePct)).dividedBy(100));
        }
        explanation = `marginal tiers on ${rule.tierBase ?? 'profit'}`;
      } else {
        const reached = tiers.filter((t) => base.gte(d(t.from))).pop();
        amount = reached ? base.times(d(reached.ratePct)).dividedBy(100) : new Dec(0);
        explanation = `tier ${reached?.ratePct ?? 0}% on whole ${rule.tierBase ?? 'profit'}`;
      }
      break;
    }
    default:
      throw new Error(`Unknown commission type`);
  }

  amount = roundMoney(amount, cur);
  if (rule.minAmount && amount.gt(0) && amount.lt(d(rule.minAmount))) amount = roundMoney(rule.minAmount, cur);
  if (rule.capAmount && amount.gt(d(rule.capAmount))) amount = roundMoney(rule.capAmount, cur);
  return { base: money(base, cur), amount: money(amount, cur), explanation };
}
