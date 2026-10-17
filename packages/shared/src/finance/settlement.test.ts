import { describe, expect, it } from 'vitest';
import { d, sum } from '../money';
import { buildSchedule, earlySettlementQuote, FUTURE_INTEREST_POLICIES, InstallmentState, settlementAllocation } from './installments';

function states(): InstallmentState[] {
  const s = buildSchedule({
    principal: '60000.00',
    annualRatePct: '12',
    count: 12,
    frequencyMonths: 1,
    firstDueDate: '2026-02-01',
    method: 'reducing_balance',
    feesTotal: '600.00',
    currency: 'SAR',
  });
  return s.lines.map((l) => ({
    id: `i${l.seq}`,
    seq: l.seq,
    dueDate: l.dueDate,
    principalDue: l.principal,
    interestDue: l.interest,
    feesDue: l.fees,
    // First two installments fully paid, third partly (fees + half the interest).
    principalPaid: l.seq <= 2 ? l.principal : '0.00',
    interestPaid: l.seq <= 2 ? l.interest : l.seq === 3 ? d(l.interest).dividedBy(2).toDecimalPlaces(2).toFixed(2) : '0.00',
    feesPaid: l.seq <= 3 ? l.fees : '0.00',
  }));
}

describe('settlementAllocation', () => {
  for (const policy of FUTURE_INTEREST_POLICIES) {
    it(`matches the quote exactly (${policy})`, () => {
      const inst = states();
      const asOf = '2026-03-15';
      const quote = earlySettlementQuote(inst, asOf, policy, 'SAR');
      const alloc = settlementAllocation(inst, asOf, policy, 'SAR');
      expect(alloc.quote).toEqual(quote);
      expect(sum(alloc.lines.map((l) => l.total)).toFixed(2)).toBe(quote.total);
      expect(sum(alloc.lines.map((l) => l.principal)).toFixed(2)).toBe(quote.principal);
      expect(sum(alloc.lines.map((l) => l.interest)).toFixed(2)).toBe(quote.interest);
      expect(sum(alloc.waived.map((w) => w.interest)).toFixed(2)).toBe(quote.waivedInterest);
      // Nothing is allocated to fully paid installments.
      expect(alloc.lines.some((l) => l.seq <= 2)).toBe(false);
    });
  }

  it('charge_current_period charges exactly one future installment of interest', () => {
    const inst = states();
    const alloc = settlementAllocation(inst, '2026-03-15', 'charge_current_period', 'SAR');
    const future = alloc.lines.filter((l) => inst.find((i) => i.id === l.installmentId)!.dueDate > '2026-03-15' && d(l.interest).gt(0));
    expect(future).toHaveLength(1);
    expect(future[0]!.seq).toBe(3); // due 2026-04-01: the period running on 2026-03-15
  });
});
