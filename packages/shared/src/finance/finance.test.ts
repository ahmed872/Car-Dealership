import { describe, expect, it } from 'vitest';
import { allocateProportionally, d, formatMoney, money, splitEvenly, sum, convert } from '../money';
import { addMonths, diffDays } from './dates';
import { allocatePayment, buildSchedule, earlySettlementQuote, InstallmentState } from './installments';
import { computeTax } from './tax';
import { computeCommission, validateCommissionRule } from './commission';
import { evaluateSalePrice, priceForTargetMargin, profitMetrics } from './pricing';

describe('money', () => {
  it('rounds half-up to 2 decimals without float error', () => {
    expect(money('0.1', 'SAR')).toBe('0.10');
    expect(money(d('0.1').plus('0.2'), 'SAR')).toBe('0.30');
    expect(money('2.675', 'EGP')).toBe('2.68'); // float would give 2.67
    expect(money('2.675', 'EGP', 'half_even')).toBe('2.68');
    expect(money('2.665', 'EGP', 'half_even')).toBe('2.66');
    expect(money('-1.005', 'AED')).toBe('-1.01');
  });

  it('sums large amounts exactly', () => {
    expect(sum(['9999999999999.99', '0.01']).toFixed(2)).toBe('10000000000000.00');
  });

  it('allocates proportionally with an exact total', () => {
    const parts = allocateProportionally('100', [1, 1, 1], 'SAR');
    expect(parts).toEqual(['33.34', '33.33', '33.33']);
    expect(sum(parts).toFixed(2)).toBe('100.00');
    const weighted = allocateProportionally('1000.00', ['250000', '150000', '100000'], 'EGP');
    expect(weighted).toEqual(['500.00', '300.00', '200.00']);
    const odd = allocateProportionally('0.05', ['1', '1', '1', '1'], 'AED');
    expect(sum(odd).toFixed(2)).toBe('0.05');
    expect(splitEvenly('10', 3, 'SAR')).toEqual(['3.34', '3.33', '3.33']);
  });

  it('converts foreign currency with rounding', () => {
    expect(convert('1000', '3.75', 'SAR')).toBe('3750.00');
    expect(convert('333.33', '48.7512', 'EGP')).toBe('16250.24');
    expect(() => convert('1', '0', 'SAR')).toThrow();
  });

  it('formats for display per locale', () => {
    expect(formatMoney('1234567.5', 'SAR', 'en')).toBe('SAR 1,234,567.50');
    expect(formatMoney('1234567.5', 'EGP', 'ar')).toBe('1,234,567.50 ج.م');
  });
});

describe('dates', () => {
  it('clamps month ends and keeps the anchor day', () => {
    expect(addMonths('2026-01-31', 1, 31)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2, 31)).toBe('2026-03-31');
    expect(addMonths('2028-01-31', 1, 31)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(diffDays('2026-01-01', '2026-03-01')).toBe(59);
  });
});

describe('installment schedules', () => {
  it('flat add-on: 120,000 at 10% for 24 months', () => {
    const s = buildSchedule({
      principal: '120000',
      annualRatePct: '10',
      count: 24,
      frequencyMonths: 1,
      firstDueDate: '2026-02-01',
      method: 'flat',
      currency: 'SAR',
    });
    expect(s.totals).toEqual({
      principal: '120000.00',
      interest: '24000.00',
      fees: '0.00',
      total: '144000.00',
    });
    expect(s.lines[0]).toMatchObject({ principal: '5000.00', interest: '1000.00', total: '6000.00' });
    expect(s.lines[23]!.dueDate).toBe('2028-01-01');
    expect(s.lines[23]!.balanceAfter).toBe('0.00');
  });

  it('reducing balance: 100,000 at 12% for 12 months matches the annuity formula', () => {
    const s = buildSchedule({
      principal: '100000',
      annualRatePct: '12',
      count: 12,
      frequencyMonths: 1,
      firstDueDate: '2026-01-31',
      method: 'reducing_balance',
      currency: 'EGP',
    });
    // Standard annuity payment for 1%/month over 12 months = 8,884.88
    for (const line of s.lines.slice(0, 11)) expect(line.total).toBe('8884.88');
    expect(s.lines[0]).toMatchObject({ interest: '1000.00', principal: '7884.88' });
    expect(s.totals.principal).toBe('100000.00');
    expect(d(s.lines[11]!.total).minus('8884.88').abs().lte('0.05')).toBe(true);
    expect(s.totals.interest).toBe('6618.53'); // verified independently with Python Decimal
    expect(s.lines[11]!.total).toBe('8884.85');
    expect(s.lines[1]!.dueDate).toBe('2026-02-28');
    expect(s.lines[2]!.dueDate).toBe('2026-03-31');
  });

  it('zero interest with rounding: last installment absorbs the difference', () => {
    const s = buildSchedule({
      principal: '100000',
      annualRatePct: '18',
      count: 3,
      frequencyMonths: 1,
      firstDueDate: '2026-05-10',
      method: 'zero_interest',
      feesTotal: '100',
      currency: 'AED',
    });
    expect(s.lines.map((l) => l.principal)).toEqual(['33333.33', '33333.33', '33333.34']);
    expect(s.lines.map((l) => l.fees)).toEqual(['33.33', '33.33', '33.34']);
    expect(s.totals).toEqual({
      principal: '100000.00',
      interest: '0.00',
      fees: '100.00',
      total: '100100.00',
    });
  });

  it('rejects invalid input', () => {
    const base = {
      principal: '1000',
      annualRatePct: '5',
      count: 12,
      frequencyMonths: 1,
      firstDueDate: '2026-01-01',
      method: 'flat' as const,
      currency: 'SAR' as const,
    };
    expect(() => buildSchedule({ ...base, count: 0 })).toThrow();
    expect(() => buildSchedule({ ...base, principal: '-5' })).toThrow();
    expect(() => buildSchedule({ ...base, firstDueDate: '2026-02-30' })).toThrow();
  });

  const state = (): InstallmentState[] => [
    {
      id: 'a',
      seq: 1,
      dueDate: '2026-01-01',
      principalDue: '900',
      interestDue: '100',
      feesDue: '10',
      principalPaid: '0',
      interestPaid: '0',
      feesPaid: '0',
    },
    {
      id: 'b',
      seq: 2,
      dueDate: '2026-02-01',
      principalDue: '900',
      interestDue: '100',
      feesDue: '10',
      principalPaid: '0',
      interestPaid: '0',
      feesPaid: '0',
    },
    {
      id: 'c',
      seq: 3,
      dueDate: '2026-03-01',
      principalDue: '900',
      interestDue: '100',
      feesDue: '10',
      principalPaid: '0',
      interestPaid: '0',
      feesPaid: '0',
    },
  ];

  it('allocates oldest first, fees → interest → principal', () => {
    const r = allocatePayment(state(), '1500', 'SAR');
    expect(r.lines).toEqual([
      {
        installmentId: 'a',
        seq: 1,
        principal: '900.00',
        interest: '100.00',
        fees: '10.00',
        total: '1010.00',
      },
      { installmentId: 'b', seq: 2, principal: '380.00', interest: '100.00', fees: '10.00', total: '490.00' },
    ]);
    expect(r.unallocated).toBe('0.00');
    const over = allocatePayment(state(), '4000', 'SAR');
    expect(over.unallocated).toBe('970.00');
  });

  it('quotes early settlement under each interest policy', () => {
    const asOf = '2026-01-15';
    expect(earlySettlementQuote(state(), asOf, 'charge_all', 'SAR')).toMatchObject({
      interest: '300.00',
      total: '3030.00',
    });
    expect(earlySettlementQuote(state(), asOf, 'charge_current_period', 'SAR')).toMatchObject({
      interest: '200.00',
      waivedInterest: '100.00',
      total: '2930.00',
    });
    expect(earlySettlementQuote(state(), asOf, 'waive_all', 'SAR')).toMatchObject({
      interest: '100.00',
      waivedInterest: '200.00',
      principal: '2700.00',
      fees: '30.00',
    });
  });
});

describe('tax', () => {
  it('standard inclusive (SA 15%)', () => {
    expect(
      computeTax({
        amount: '115000',
        amountIncludesTax: true,
        mode: 'standard',
        ratePct: '15',
        currency: 'SAR',
      }),
    ).toEqual({
      net: '100000.00',
      tax: '15000.00',
      gross: '115000.00',
      taxableBase: '100000.00',
    });
  });
  it('standard exclusive (EG 14%)', () => {
    expect(
      computeTax({
        amount: '100000',
        amountIncludesTax: false,
        mode: 'standard',
        ratePct: '14',
        currency: 'EGP',
      }),
    ).toMatchObject({
      tax: '14000.00',
      gross: '114000.00',
    });
  });
  it('margin scheme taxes only the positive margin', () => {
    expect(
      computeTax({
        amount: '115000',
        amountIncludesTax: true,
        mode: 'margin',
        ratePct: '15',
        cost: '92000',
        currency: 'SAR',
      }),
    ).toEqual({ net: '112000.00', tax: '3000.00', gross: '115000.00', taxableBase: '20000.00' });
    expect(
      computeTax({
        amount: '90000',
        amountIncludesTax: true,
        mode: 'margin',
        ratePct: '15',
        cost: '92000',
        currency: 'SAR',
      }).tax,
    ).toBe('0.00');
  });
  it('none mode', () => {
    expect(
      computeTax({ amount: '50000', amountIncludesTax: true, mode: 'none', ratePct: '14', currency: 'EGP' })
        .tax,
    ).toBe('0.00');
  });
  it('rounds inclusive tax at 5%', () => {
    const r = computeTax({
      amount: '99999.99',
      amountIncludesTax: true,
      mode: 'standard',
      ratePct: '5',
      currency: 'AED',
    });
    expect(r).toMatchObject({ tax: '4761.90', net: '95238.09' });
    expect(d(r.net).plus(r.tax).toFixed(2)).toBe('99999.99');
  });
});

describe('commissions', () => {
  const input = { saleNet: '200000', grossProfit: '25000', currency: 'SAR' as const };
  it('percent of profit and sale', () => {
    expect(computeCommission({ type: 'pct_of_profit', ratePct: '10' }, input).amount).toBe('2500.00');
    expect(computeCommission({ type: 'pct_of_sale', ratePct: '0.5' }, input).amount).toBe('1000.00');
    expect(computeCommission({ type: 'fixed', fixedAmount: '750' }, input).amount).toBe('750.00');
  });
  it('tiered whole vs marginal', () => {
    const tiers = [
      { from: '0', ratePct: '5' },
      { from: '10000', ratePct: '10' },
    ];
    expect(computeCommission({ type: 'tiered', tiers, tierMode: 'marginal' }, input).amount).toBe('2000.00');
    expect(computeCommission({ type: 'tiered', tiers, tierMode: 'whole' }, input).amount).toBe('2500.00');
  });
  it('no commission on loss when required, min/cap applied', () => {
    const loss = { ...input, grossProfit: '-500' };
    expect(
      computeCommission({ type: 'fixed', fixedAmount: '750', requirePositiveProfit: true }, loss).amount,
    ).toBe('0.00');
    expect(computeCommission({ type: 'pct_of_profit', ratePct: '10' }, loss).amount).toBe('0.00');
    expect(computeCommission({ type: 'pct_of_profit', ratePct: '10', capAmount: '1000' }, input).amount).toBe(
      '1000.00',
    );
    expect(computeCommission({ type: 'pct_of_profit', ratePct: '1', minAmount: '500' }, input).amount).toBe(
      '500.00',
    );
  });
  it('validates rules', () => {
    expect(validateCommissionRule({ type: 'pct_of_profit', ratePct: '150' })).not.toEqual([]);
    expect(validateCommissionRule({ type: 'tiered', tiers: [{ from: '5', ratePct: '1' }] })).toContain(
      'first tier must start at 0',
    );
  });
});

describe('pricing', () => {
  it('flags discounts beyond role limit and floor breaches', () => {
    const base = {
      askingPrice: '200000',
      floorPrice: '185000',
      maxDiscountPct: '3',
      currency: 'SAR' as const,
    };
    expect(evaluateSalePrice({ ...base, agreedPrice: '195000' })).toMatchObject({
      discountAmount: '5000.00',
      discountPct: '2.5000',
      requiresApproval: false,
    });
    expect(evaluateSalePrice({ ...base, agreedPrice: '190000' })).toMatchObject({
      exceedsRoleLimit: true,
      belowFloor: false,
      approvalPermission: 'sales.approve_discount',
    });
    expect(evaluateSalePrice({ ...base, agreedPrice: '180000' })).toMatchObject({
      belowFloor: true,
      approvalPermission: 'sales.approve_below_floor',
    });
    expect(evaluateSalePrice({ ...base, agreedPrice: '210000' }).discountAmount).toBe('0.00');
  });
  it('computes margin and target price', () => {
    expect(profitMetrics('112000', '92000', 'SAR')).toEqual({
      grossProfit: '20000.00',
      marginPct: '17.86',
      markupPct: '21.74',
    });
    expect(priceForTargetMargin('90000', '10', 'SAR')).toBe('100000.00');
  });
});
