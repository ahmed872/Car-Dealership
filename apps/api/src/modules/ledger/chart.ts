/** System chart of accounts, seeded for every tenant. See docs/ARCHITECTURE.md §6. */
export const ACCOUNTS = {
  CASH: '1100',
  RECEIVABLES: '1200',
  INVENTORY: '1300',
  COMMISSION_ADVANCES: '1400',
  PAYABLES: '2000',
  CUSTOMER_ADVANCES: '2100',
  TAX_PAYABLE: '2200',
  COMMISSIONS_PAYABLE: '2300',
  DEFERRED_FINANCE_INCOME: '2400',
  EQUITY: '3000',
  SALES_REVENUE: '4000',
  FINANCE_INCOME: '4100',
  OTHER_INCOME: '4200',
  FX_GAIN_LOSS: '4300',
  COGS: '5000',
  OPERATING_EXPENSES: '6000',
  COMMISSION_EXPENSE: '6100',
  CASH_OVER_SHORT: '6200',
  INVENTORY_ADJUSTMENTS: '6300',
} as const;

export type AccountCode = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];

export const CHART: Array<{
  code: AccountCode;
  nameEn: string;
  nameAr: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
}> = [
  { code: '1100', nameEn: 'Cash & bank', nameAr: 'النقدية والبنوك', type: 'asset' },
  { code: '1200', nameEn: 'Accounts receivable – customers', nameAr: 'ذمم العملاء المدينة', type: 'asset' },
  { code: '1300', nameEn: 'Vehicle inventory', nameAr: 'مخزون السيارات', type: 'asset' },
  { code: '1400', nameEn: 'Commission advances & clawbacks', nameAr: 'سلف ومستردات العمولات', type: 'asset' },
  { code: '2000', nameEn: 'Supplier payables', nameAr: 'ذمم الموردين الدائنة', type: 'liability' },
  {
    code: '2100',
    nameEn: 'Customer deposits & advances',
    nameAr: 'عربون ودفعات العملاء المقدمة',
    type: 'liability',
  },
  { code: '2200', nameEn: 'Output tax payable', nameAr: 'ضريبة المخرجات المستحقة', type: 'liability' },
  { code: '2300', nameEn: 'Commissions payable', nameAr: 'عمولات مستحقة', type: 'liability' },
  { code: '2400', nameEn: 'Deferred finance income', nameAr: 'إيرادات تمويل مؤجلة', type: 'liability' },
  {
    code: '3000',
    nameEn: 'Owner equity / opening balances',
    nameAr: 'حقوق الملكية / الأرصدة الافتتاحية',
    type: 'equity',
  },
  { code: '4000', nameEn: 'Vehicle sales revenue', nameAr: 'إيرادات بيع السيارات', type: 'income' },
  {
    code: '4100',
    nameEn: 'Finance income (installments)',
    nameAr: 'إيرادات التمويل (التقسيط)',
    type: 'income',
  },
  {
    code: '4200',
    nameEn: 'Other income (forfeited deposits)',
    nameAr: 'إيرادات أخرى (عربون مصادر)',
    type: 'income',
  },
  {
    code: '4300',
    nameEn: 'Realized foreign exchange gains / (losses)',
    nameAr: 'أرباح / (خسائر) فروق العملة المحققة',
    type: 'income',
  },
  { code: '5000', nameEn: 'Cost of vehicles sold', nameAr: 'تكلفة السيارات المباعة', type: 'expense' },
  { code: '6000', nameEn: 'Operating expenses', nameAr: 'المصروفات التشغيلية', type: 'expense' },
  { code: '6100', nameEn: 'Sales commissions', nameAr: 'عمولات المبيعات', type: 'expense' },
  { code: '6200', nameEn: 'Cash over / short', nameAr: 'فروقات الخزينة', type: 'expense' },
  {
    code: '6300',
    nameEn: 'Inventory adjustments & write-offs',
    nameAr: 'تسويات وشطب المخزون',
    type: 'expense',
  },
];
