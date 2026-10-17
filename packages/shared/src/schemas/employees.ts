import { z } from 'zod';
import { COMMISSION_EARN_ON, COMMISSION_TYPES, validateCommissionRule } from '../finance/commission';
import { patchOf, zIsoDate, zMoney, zMoneyNonNeg, zOptText, zText, zUuid } from './common';
import { zEmployeeProfileInput } from './crm';

export const zEmployeeProfileUpdate = patchOf(zEmployeeProfileInput);
export type EmployeeProfileUpdateInput = z.infer<typeof zEmployeeProfileUpdate>;

const zRatePct = z.string().trim().regex(/^\d{1,3}(\.\d{1,4})?$/, 'invalid_percent');

/** A commission rule; `validateCommissionRule` (shared with the calculator) checks consistency. */
export const zCommissionRule = z
  .object({
    type: z.enum(COMMISSION_TYPES),
    ratePct: zRatePct.optional(),
    fixedAmount: zMoneyNonNeg.optional(),
    tierBase: z.enum(['profit', 'sale']).optional(),
    tierMode: z.enum(['whole', 'marginal']).optional(),
    tiers: z.array(z.object({ from: zMoneyNonNeg, ratePct: zRatePct })).max(20).optional(),
    minAmount: zMoneyNonNeg.optional(),
    capAmount: zMoneyNonNeg.optional(),
    requirePositiveProfit: z.boolean().optional(),
    /** When the commission becomes payable (used when sales are delivered/paid, Phase 5). */
    earnOn: z.enum(COMMISSION_EARN_ON).default('delivery'),
  })
  .superRefine((rule, ctx) => {
    for (const message of validateCommissionRule(rule)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });
export type CommissionRuleInput = z.infer<typeof zCommissionRule>;

export const zCommissionPolicyCreate = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, 'invalid_code'),
  name: zText(120).min(2),
  rule: zCommissionRule,
  /** Defaults to today; never before today (commissions are not changed retroactively). */
  effectiveFrom: zIsoDate.optional(),
});
export type CommissionPolicyCreateInput = z.infer<typeof zCommissionPolicyCreate>;

/** A new version of an existing policy, effective from a date after the current version's start. */
export const zCommissionPolicyVersion = z.object({
  name: zText(120).min(2).optional(),
  rule: zCommissionRule,
  effectiveFrom: zIsoDate,
  reason: zText(500).min(3),
});
export type CommissionPolicyVersionInput = z.infer<typeof zCommissionPolicyVersion>;

export const zCommissionPolicyListQuery = z.object({ includeHistory: z.enum(['true', 'false']).optional() });
export const zCommissionResolveQuery = z.object({ userId: zUuid, date: zIsoDate.optional() });
export const zCommissionPolicyDeactivate = z.object({ reason: zText(500).min(3) });

export const zCommissionPreview = z
  .object({
    policyId: zUuid.optional(),
    rule: zCommissionRule.optional(),
    saleNet: zMoneyNonNeg,
    /** Net revenue − vehicle cost; may be negative. */
    grossProfit: zMoney,
    note: zOptText(200),
  })
  .refine((p) => !!p.policyId !== !!p.rule, { message: 'Give either policyId or rule', path: ['policyId'] });
export type CommissionPreviewInput = z.infer<typeof zCommissionPreview>;
