import { CurrencyCode, Dec, RoundingMode, d, money, roundMoney, sum } from '../money';
import { addMonths, parseIsoDate } from './dates';

export const INSTALLMENT_METHODS = ['flat', 'reducing_balance', 'zero_interest'] as const;
export type InstallmentMethod = (typeof INSTALLMENT_METHODS)[number];

export const FUTURE_INTEREST_POLICIES = ['waive_all', 'charge_current_period', 'charge_all'] as const;
export type FutureInterestPolicy = (typeof FUTURE_INTEREST_POLICIES)[number];

export interface ScheduleInput {
  /** Financed amount (sale balance after down payment). */
  principal: string;
  /** Nominal annual rate in percent. Ignored for zero_interest. */
  annualRatePct: string;
  count: number;
  /** Months between installments (1 = monthly, 3 = quarterly). */
  frequencyMonths: number;
  firstDueDate: string;
  method: InstallmentMethod;
  /** Declared administrative fees, spread evenly across installments. */
  feesTotal?: string;
  currency: CurrencyCode;
  rounding?: RoundingMode;
}

export interface ScheduleLine {
  seq: number;
  dueDate: string;
  principal: string;
  interest: string;
  fees: string;
  total: string;
  balanceAfter: string;
}

export interface Schedule {
  method: InstallmentMethod;
  periodicRatePct: string;
  lines: ScheduleLine[];
  totals: { principal: string; interest: string; fees: string; total: string };
}

/** Equal parts, rounded; the LAST part absorbs the rounding difference so the sum is exact. */
function equalPartsLastAbsorbs(total: Dec, n: number, currency: CurrencyCode, mode: RoundingMode): Dec[] {
  const each = roundMoney(total.dividedBy(n), currency, mode);
  const parts: Dec[] = [];
  for (let i = 0; i < n - 1; i++) parts.push(each);
  parts.push(total.minus(each.times(n - 1)));
  return parts;
}

export function validateScheduleInput(input: ScheduleInput): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 360)
    errors.push('count must be 1..360');
  if (![1, 2, 3, 6, 12].includes(input.frequencyMonths))
    errors.push('frequencyMonths must be 1, 2, 3, 6 or 12');
  if (d(input.principal).lte(0)) errors.push('principal must be positive');
  if (d(input.annualRatePct).isNegative() || d(input.annualRatePct).gt(100))
    errors.push('annualRatePct must be 0..100');
  if (input.feesTotal && d(input.feesTotal).isNegative()) errors.push('feesTotal must be >= 0');
  try {
    parseIsoDate(input.firstDueDate);
  } catch {
    errors.push('firstDueDate must be YYYY-MM-DD');
  }
  return errors;
}

export function buildSchedule(input: ScheduleInput): Schedule {
  const errors = validateScheduleInput(input);
  if (errors.length) throw new Error(`Invalid schedule input: ${errors.join('; ')}`);
  const mode = input.rounding ?? 'half_up';
  const cur = input.currency;
  const n = input.count;
  const P = roundMoney(input.principal, cur, mode);
  const fees = equalPartsLastAbsorbs(roundMoney(input.feesTotal ?? '0', cur, mode), n, cur, mode);
  const rate = input.method === 'zero_interest' ? new Dec(0) : d(input.annualRatePct);
  const periodic = rate.dividedBy(100).dividedBy(12).times(input.frequencyMonths);
  const anchorDay = parseIsoDate(input.firstDueDate).d;
  const dueDate = (k: number) => addMonths(input.firstDueDate, k * input.frequencyMonths, anchorDay);

  const principals: Dec[] = [];
  const interests: Dec[] = [];

  if (input.method === 'reducing_balance' && !periodic.isZero()) {
    const factor = new Dec(1).plus(periodic).pow(n);
    const payment = roundMoney(P.times(periodic).times(factor).dividedBy(factor.minus(1)), cur, mode);
    let balance = P;
    for (let k = 1; k <= n; k++) {
      const interest = roundMoney(balance.times(periodic), cur, mode);
      let principal = k === n ? balance : payment.minus(interest);
      if (principal.gt(balance)) principal = balance;
      if (principal.isNegative()) principal = new Dec(0);
      principals.push(principal);
      interests.push(interest);
      balance = balance.minus(principal);
    }
  } else {
    // flat (add-on) or zero interest: interest on the original principal for the whole term.
    const years = new Dec(n * input.frequencyMonths).dividedBy(12);
    const totalInterest = roundMoney(P.times(rate).dividedBy(100).times(years), cur, mode);
    principals.push(...equalPartsLastAbsorbs(P, n, cur, mode));
    interests.push(...equalPartsLastAbsorbs(totalInterest, n, cur, mode));
  }

  let balance = P;
  const lines: ScheduleLine[] = [];
  for (let k = 0; k < n; k++) {
    const principal = principals[k]!;
    const interest = interests[k]!;
    const fee = fees[k]!;
    balance = balance.minus(principal);
    lines.push({
      seq: k + 1,
      dueDate: dueDate(k),
      principal: money(principal, cur, mode),
      interest: money(interest, cur, mode),
      fees: money(fee, cur, mode),
      total: money(principal.plus(interest).plus(fee), cur, mode),
      balanceAfter: money(balance, cur, mode),
    });
  }

  const totals = {
    principal: money(sum(lines.map((l) => l.principal)), cur),
    interest: money(sum(lines.map((l) => l.interest)), cur),
    fees: money(sum(lines.map((l) => l.fees)), cur),
    total: money(sum(lines.map((l) => l.total)), cur),
  };
  // Invariants: the schedule must reproduce the contractual amounts exactly.
  if (!d(totals.principal).eq(P)) throw new Error('Schedule principal mismatch');
  if (!d(totals.total).eq(d(totals.principal).plus(totals.interest).plus(totals.fees))) {
    throw new Error('Schedule total mismatch');
  }
  return {
    method: input.method,
    periodicRatePct: periodic.times(100).toDecimalPlaces(8).toString(),
    lines,
    totals,
  };
}

export const ALLOCATION_COMPONENTS = ['fees', 'interest', 'principal'] as const;
export type AllocationComponent = (typeof ALLOCATION_COMPONENTS)[number];

export interface InstallmentState {
  id: string;
  seq: number;
  dueDate: string;
  principalDue: string;
  interestDue: string;
  feesDue: string;
  principalPaid: string;
  interestPaid: string;
  feesPaid: string;
}

export interface AllocationLine {
  installmentId: string;
  seq: number;
  principal: string;
  interest: string;
  fees: string;
  total: string;
}

/**
 * Allocates a payment oldest-installment-first. Within each installment the components are
 * paid in `order` (default: fees → interest → principal). Returns any unallocated excess,
 * which callers must reject or hold as customer credit — never silently drop.
 */
export function allocatePayment(
  installments: InstallmentState[],
  amount: string,
  currency: CurrencyCode,
  order: readonly AllocationComponent[] = ALLOCATION_COMPONENTS,
): { lines: AllocationLine[]; unallocated: string } {
  let remaining = roundMoney(amount, currency);
  if (remaining.lte(0)) throw new Error('Payment amount must be positive');
  const lines: AllocationLine[] = [];
  const sorted = [...installments].sort((a, b) => a.seq - b.seq);
  for (const inst of sorted) {
    if (remaining.isZero()) break;
    const outstanding: Record<AllocationComponent, Dec> = {
      fees: d(inst.feesDue).minus(inst.feesPaid),
      interest: d(inst.interestDue).minus(inst.interestPaid),
      principal: d(inst.principalDue).minus(inst.principalPaid),
    };
    const taken: Record<AllocationComponent, Dec> = {
      fees: new Dec(0),
      interest: new Dec(0),
      principal: new Dec(0),
    };
    for (const comp of order) {
      if (remaining.isZero()) break;
      const take = Dec.min(remaining, Dec.max(outstanding[comp], 0));
      taken[comp] = take;
      remaining = remaining.minus(take);
    }
    const total = taken.fees.plus(taken.interest).plus(taken.principal);
    if (total.gt(0)) {
      lines.push({
        installmentId: inst.id,
        seq: inst.seq,
        principal: money(taken.principal, currency),
        interest: money(taken.interest, currency),
        fees: money(taken.fees, currency),
        total: money(total, currency),
      });
    }
  }
  return { lines, unallocated: money(remaining, currency) };
}

export interface SettlementQuote {
  principal: string;
  interest: string;
  fees: string;
  total: string;
  waivedInterest: string;
}

/**
 * Early settlement amount as of a date. Principal and fees outstanding are always due.
 * Interest on installments due on/before `asOf` is always due; interest on future installments
 * follows `policy`.
 */
export function earlySettlementQuote(
  installments: InstallmentState[],
  asOf: string,
  policy: FutureInterestPolicy,
  currency: CurrencyCode,
): SettlementQuote {
  parseIsoDate(asOf);
  const sorted = [...installments].sort((a, b) => a.seq - b.seq);
  let principal = new Dec(0);
  let interest = new Dec(0);
  let fees = new Dec(0);
  let waived = new Dec(0);
  let currentPeriodCharged = false;
  for (const inst of sorted) {
    principal = principal.plus(d(inst.principalDue).minus(inst.principalPaid));
    fees = fees.plus(d(inst.feesDue).minus(inst.feesPaid));
    const intOut = d(inst.interestDue).minus(inst.interestPaid);
    if (inst.dueDate <= asOf) {
      interest = interest.plus(intOut);
    } else if (policy === 'charge_all') {
      interest = interest.plus(intOut);
    } else if (policy === 'charge_current_period' && !currentPeriodCharged) {
      interest = interest.plus(intOut);
      currentPeriodCharged = true;
    } else {
      waived = waived.plus(intOut);
    }
  }
  return {
    principal: money(principal, currency),
    interest: money(interest, currency),
    fees: money(fees, currency),
    total: money(principal.plus(interest).plus(fees), currency),
    waivedInterest: money(waived, currency),
  };
}

export interface SettlementAllocation {
  quote: SettlementQuote;
  /** What the settlement payment pays on each installment (fees, charged interest, principal). */
  lines: AllocationLine[];
  /** Interest forgiven per installment (posted against deferred finance income). */
  waived: Array<{ installmentId: string; seq: number; interest: string }>;
}

/**
 * Splits an early settlement over the remaining installments with exactly the rule of
 * `earlySettlementQuote`: all outstanding fees and principal, interest that is due or charged by
 * `policy`, and the rest of the interest waived. The lines always add up to the quote total.
 */
export function settlementAllocation(
  installments: InstallmentState[],
  asOf: string,
  policy: FutureInterestPolicy,
  currency: CurrencyCode,
): SettlementAllocation {
  const quote = earlySettlementQuote(installments, asOf, policy, currency);
  const sorted = [...installments].sort((a, b) => a.seq - b.seq);
  const lines: AllocationLine[] = [];
  const waived: SettlementAllocation['waived'] = [];
  let currentPeriodCharged = false;
  for (const inst of sorted) {
    const principal = Dec.max(d(inst.principalDue).minus(inst.principalPaid), 0);
    const fees = Dec.max(d(inst.feesDue).minus(inst.feesPaid), 0);
    const intOut = Dec.max(d(inst.interestDue).minus(inst.interestPaid), 0);
    let interest = new Dec(0);
    if (inst.dueDate <= asOf || policy === 'charge_all') {
      interest = intOut;
    } else if (policy === 'charge_current_period' && !currentPeriodCharged) {
      interest = intOut;
      currentPeriodCharged = true;
    } else if (intOut.gt(0)) {
      waived.push({ installmentId: inst.id, seq: inst.seq, interest: money(intOut, currency) });
    }
    const total = principal.plus(fees).plus(interest);
    if (total.gt(0)) {
      lines.push({
        installmentId: inst.id,
        seq: inst.seq,
        principal: money(principal, currency),
        interest: money(interest, currency),
        fees: money(fees, currency),
        total: money(total, currency),
      });
    }
  }
  return { quote, lines, waived };
}
