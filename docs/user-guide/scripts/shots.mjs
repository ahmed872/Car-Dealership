// The list of screenshots in the guide. Each shot: id, as (user email; null = signed out), path,
// optional prep(page, {S, api}), target ('content' | 'page' | 'dialog' | (page) => locator),
// grow (extend the viewport to the page height), callouts: [(page) => locator] (numbered 1..n).
const V = (S, k) => S.acquisitions[k].vehicleId;
const A = (S, k) => S.acquisitions[k].acqId;
const btn = (page, name) => page.getByRole('button', { name }).first();
const link = (page, name) => page.getByRole('link', { name }).first();
const txt = (page, t) => page.getByText(t, { exact: false }).first();
const tab = (page, name) => page.getByRole('tab', { name }).first();
const label = (page, l) => page.getByLabel(l, { exact: false }).first();
const nav = (page, name) => page.locator('aside nav').getByRole('link', { name, exact: true }).first();
async function clickBtn(page, name) {
  await btn(page, name).click();
  await page.waitForTimeout(500);
}
async function openDialog(page, name) {
  await btn(page, name).click();
  await page.locator('dialog[open]').last().waitFor();
  await page.waitForTimeout(600);
}
async function clickTab(page, name) {
  const t = page.getByRole('tab', { name });
  if (await t.count()) await t.first().click();
  else await page.getByRole('button', { name }).first().click();
  await page.waitForTimeout(700);
}
const items = (j) => j.items ?? j.data ?? j;
/** Types into the n-th combobox of the page (or dialog) and chooses the first option. */
async function pick(page, n, text, scope = page.locator('main')) {
  const cb = scope.getByRole('combobox').nth(n);
  await cb.click();
  await cb.fill(text);
  await page.waitForTimeout(900);
  const match = page.getByRole('option').filter({ hasText: text });
  await ((await match.count()) ? match.first() : page.getByRole('option').first()).click();
  await page.waitForTimeout(500);
}
const OWNER = 'owner@demo.test';
const REP = 'rep@demo.test';
const SM = 'sm@demo.test';
const ACC = 'acc@demo.test';
const INV = 'inv@demo.test';
const BM = 'bm@demo.test';

export const SHOTS = [
  // ── Sign-in, shell ─────────────────────────────────────────────────────────────────────
  {
    id: 'auth-login', as: null, path: '/login', target: 'page',
    callouts: [(p) => label(p, 'البريد الإلكتروني'), (p) => label(p, 'كلمة المرور'), (p) => btn(p, 'دخول'), (p) => btn(p, 'English')],
  },
  {
    id: 'auth-select-company', as: OWNER, path: '/select-company', target: 'page', clipX: [470, 970], clipY: [205, 700],
    callouts: [(p) => txt(p, 'معرض الواحة للسيارات'), (p) => txt(p, 'معرض النخبة'), (p) => btn(p, 'قبول'), (p) => btn(p, 'رفض')],
  },
  { id: 'auth-select-company-2', as: BM, path: '/select-company', target: (p) => p.locator('main, body > div').locator('div').filter({ hasText: 'اختر الشركة' }).last(), pad: 0 },
  {
    id: 'shell-overview', path: '/app', target: 'page',
    callouts: [
      (p) => p.locator('aside nav').locator('div').filter({ hasText: 'معرض الواحة' }).first(),
      (p) => nav(p, 'لوحة التحكم'),
      (p) => p.locator('header').getByRole('button', { name: /التنبيهات/ }),
      (p) => btn(p, 'English'),
      (p) => p.locator('header').getByRole('button', { name: 'المظهر' }),
      (p) => p.locator('header [aria-haspopup="menu"]'),
    ],
  },
  {
    id: 'shell-user-menu', path: '/app', target: (p) => p.locator('header [role="menu"]'), pad: 10,
    prep: async (p) => { await p.locator('header [aria-haspopup="menu"]').click(); await p.waitForTimeout(400); },
  },
  {
    id: 'shell-account', path: '/app/account',
  },
  {
    id: 'shell-notifications-bell', path: '/app', target: 'content',
    prep: async (p) => { await p.locator('header').getByRole('button', { name: /التنبيهات/ }).click(); await p.waitForTimeout(700); },
    cropH: 620,
  },
  { id: 'shell-notifications-page', path: '/app/notifications' },
  // Mobile
  { id: 'mobile-dashboard', path: '/app', w: 390, h: 844, mobile: true },
  {
    id: 'mobile-menu', path: '/app', w: 390, h: 844, mobile: true,
    prep: async (p) => { await p.getByRole('button', { name: 'menu' }).click(); await p.waitForTimeout(600); },
  },

  // ── Dashboard ──────────────────────────────────────────────────────────────────────────
  {
    id: 'dash-owner', path: '/app', grow: true, maxH: 1700,
    callouts: [
      (p) => p.getByRole('tablist').first().or(txt(p, 'هذا الشهر')),
      (p) => p.locator('main select').first(),
      (p) => txt(p, 'صافي الإيراد'),
      (p) => link(p, 'عرض التقرير'),
      (p) => txt(p, 'السيارات في المخزون'),
      (p) => txt(p, 'طلبات بانتظار موافقتك'),
    ],
  },
  { id: 'dash-rep', as: REP, path: '/app', grow: true, maxH: 1400 },

  // ── Approvals ──────────────────────────────────────────────────────────────────────────
  {
    id: 'appr-inbox', path: '/app/approvals',
    callouts: [(p) => tab(p, 'الكل'), (p) => p.locator('main tbody tr').first().locator('td').first(), (p) => link(p, 'فتح المستند'), (p) => btn(p, 'اعتماد'), (p) => btn(p, 'رفض')],
  },
  { id: 'appr-dialog', path: '/app/approvals', target: 'dialog', prep: async (p) => { await p.locator('main tbody tr').nth(1).getByRole('button', { name: 'اعتماد' }).click(); await p.locator('dialog[open]').waitFor(); await p.waitForTimeout(500); } },

  // ── Sales ──────────────────────────────────────────────────────────────────────────────
  { id: 'res-list', path: '/app/reservations', callouts: [(p) => btn(p, 'حجز جديد'), (p) => tab(p, 'تنتهي قريبًا'), (p) => p.locator('main input').first()] },
  { id: 'res-new', path: '/app/reservations', target: 'dialog', h: 1100, prep: (p) => openDialog(p, 'حجز جديد') },
  {
    id: 'res-active', path: ({ S }) => `/app/reservations/${S.reservations.active}`, grow: true,
    callouts: [(p) => btn(p, 'إضافة عربون'), (p) => btn(p, 'تمديد'), (p) => btn(p, 'إلغاء الحجز'), (p) => txt(p, 'العربون التزام على المعرض')],
  },
  { id: 'res-cancel', path: ({ S }) => `/app/reservations/${S.reservations.active}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'إلغاء الحجز') },
  { id: 'res-extend', path: ({ S }) => `/app/reservations/${S.reservations.active}`, target: 'dialog', prep: (p) => openDialog(p, 'تمديد') },
  { id: 'res-cancelled', path: ({ S }) => `/app/reservations/${S.reservations.cancelled}`, grow: true },
  { id: 'sale-list', path: '/app/sales', callouts: [(p) => link(p, 'عملية بيع جديدة').or(btn(p, 'عملية بيع جديدة')), (p) => p.locator('main input').first()] },
  {
    id: 'sale-new', as: REP, path: '/app/sales/new', grow: true, maxH: 2000,
    prep: async (p) => {
      await pick(p, 0, 'لاند');
      await pick(p, 1, 'زياد');
      await p.getByLabel('السعر المتفق عليه').first().fill('256000');
      await p.getByText('تقسيط داخلي').first().click();
      await p.waitForTimeout(400);
      const dp = p.getByLabel('الدفعة المقدمة');
      if (await dp.count()) await dp.first().fill('76000');
      const cnt = p.getByLabel('عدد الأقساط');
      if (await cnt.count()) await cnt.first().fill('36');
      const rate = p.getByLabel('نسبة الفائدة السنوية');
      if (await rate.count()) await rate.first().fill('4');
      await p.waitForTimeout(1500);
    },
    callouts: [(p) => p.getByRole('combobox').nth(0), (p) => p.getByRole('combobox').nth(1), (p) => p.getByLabel('السعر المتفق عليه').first(), (p) => txt(p, 'طريقة البيع'), (p) => txt(p, 'ملخص الحساب'), (p) => btn(p, 'حفظ عملية البيع')],
  },
  {
    id: 'sale-cash', path: ({ S }) => `/app/sales/${S.sales.cash}`, grow: true, maxH: 1900,
    callouts: [(p) => txt(p, 'المقبوض للعملية'), (p) => txt(p, 'تفاصيل السعر'), (p) => txt(p, 'المستندات'), (p) => txt(p, 'التكلفة والربح'), (p) => txt(p, 'عمولة البائع'), (p) => btn(p, 'إرجاع السيارة')],
  },
  { id: 'sale-inst', path: ({ S }) => `/app/sales/${S.sales.inst}`, grow: true, maxH: 1300, clipY: [0, 1300] },
  {
    id: 'sale-pending', as: SM, path: ({ S }) => `/app/sales/${S.sales.discount}`, grow: true, maxH: 1300, clipY: [0, 1100],
    callouts: [(p) => txt(p, 'بانتظار اعتماد السعر'), (p) => btn(p, 'اعتماد السعر'), (p) => btn(p, 'رفض')],
  },
  { id: 'sale-approve-dialog', as: SM, path: ({ S }) => `/app/sales/${S.sales.discount}`, target: 'dialog', prep: (p) => openDialog(p, 'اعتماد السعر') },
  { id: 'sale-confirm-dialog', as: SM, path: ({ S }) => `/app/sales/${S.sales.jed}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'تأكيد البيع') },
  {
    id: 'sale-awaiting', as: SM, path: ({ S }) => `/app/sales/${S['sale-awaiting-delivery']}`, grow: true, maxH: 1300, clipY: [0, 1050],
    callouts: [(p) => btn(p, 'تسجيل دفعة'), (p) => btn(p, 'تسليم السيارة'), (p) => btn(p, 'إصدار مستند'), (p) => btn(p, 'إلغاء العملية')],
  },
  { id: 'sale-payment-dialog', as: ACC, path: ({ S }) => `/app/sales/${S['sale-awaiting-delivery']}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'تسجيل دفعة') },
  { id: 'sale-deliver-dialog', as: SM, path: ({ S }) => `/app/sales/${S['sale-awaiting-delivery']}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'تسليم السيارة') },
  { id: 'sale-document-dialog', as: ACC, path: ({ S }) => `/app/sales/${S['sale-awaiting-delivery']}`, target: 'dialog', prep: (p) => openDialog(p, 'إصدار مستند') },
  { id: 'sale-return-dialog', as: OWNER, path: ({ S }) => `/app/sales/${S.sales.cash}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'إرجاع السيارة') },
  { id: 'inst-list', path: '/app/installments' },
  {
    id: 'inst-plan', as: ACC, path: ({ S }) => `/app/installments/${S['installment-payment']}`, grow: true, maxH: 2200, clipY: [0, 1160],
    callouts: [(p) => btn(p, 'تحصيل قسط'), (p) => txt(p, 'جدول الأقساط'), (p) => txt(p, 'السداد المبكر')],
  },
  { id: 'inst-collect', as: ACC, path: ({ S }) => `/app/installments/${S['installment-payment']}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'تحصيل قسط') },
  { id: 'comm-list', as: ACC, path: '/app/commissions', callouts: [(p) => btn(p, 'صرف العمولة'), (p) => btn(p, 'اعتماد')] },
  { id: 'comm-own', as: REP, path: '/app/commissions' },

  // ── Customers / CRM ────────────────────────────────────────────────────────────────────
  { id: 'cust-list', path: '/app/customers', callouts: [(p) => link(p, 'عميل جديد').or(btn(p, 'عميل جديد')), (p) => p.locator('main input').first()] },
  {
    id: 'cust-new', as: REP, path: '/app/customers/new', grow: true, maxH: 2200,
    prep: async (p) => { await p.getByLabel('الاسم الكامل').first().fill('أحمد سالم'); await p.getByLabel('الجوال').first().fill('0551000001'); await p.getByLabel('المدينة').first().click(); await p.waitForTimeout(1800); },
    callouts: [(p) => p.getByLabel('الجوال').first(), (p) => txt(p, 'التحقق من التكرار'), (p) => btn(p, 'حفظ العميل')],
  },
  {
    id: 'cust-360', path: ({ S }) => `/app/customers/${S.customers.ahmad}`, grow: true, maxH: 1500,
    callouts: [(p) => btn(p, 'تسجيل تواصل'), (p) => btn(p, 'فرصة بيعية جديدة').or(link(p, 'فرصة بيعية جديدة')), (p) => btn(p, 'تعديل').or(link(p, 'تعديل')), (p) => btn(p, 'إظهار'), (p) => btn(p, 'تغيير المسؤول'), (p) => btn(p, 'إيقاف العميل')],
  },
  { id: 'cust-interaction', as: REP, path: ({ S }) => `/app/customers/${S.customers.ahmad}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'تسجيل تواصل') },
  {
    id: 'lead-board', path: '/app/leads', w: 1920, h: 1000,
    callouts: [(p) => btn(p, 'فرصة جديدة'), (p) => txt(p, 'قائمة'), (p) => txt(p, 'اسحب البطاقة')],
  },
  { id: 'lead-list', path: '/app/leads/list' },
  { id: 'lead-new', path: '/app/leads', target: 'dialog', h: 1100, prep: (p) => openDialog(p, 'فرصة جديدة') },
  {
    id: 'lead-detail', path: ({ S }) => `/app/leads/${S.leads.hind}`, grow: true, maxH: 1500,
    callouts: [(p) => btn(p, 'نقل إلى مرحلة'), (p) => btn(p, 'تسجيل كبيع ناجح'), (p) => btn(p, 'تسجيل كخسارة'), (p) => btn(p, 'تحديد موعد').or(btn(p, 'إعادة الجدولة'))],
  },
  { id: 'lead-lost', path: ({ S }) => `/app/leads/${S.leads.hind}`, target: 'dialog', prep: (p) => openDialog(p, 'تسجيل كخسارة') },
  { id: 'follow-ups', as: REP, path: '/app/follow-ups' },
  {
    id: 'appt-calendar', path: '/app/appointments', grow: true, maxH: 1300,
    callouts: [(p) => btn(p, 'موعد جديد'), (p) => btn(p, 'تجربة قيادة'), (p) => btn(p, 'اليوم'), (p) => txt(p, 'أسبوع')],
  },
  { id: 'appt-new', path: '/app/appointments', target: 'dialog', h: 1100, prep: (p) => openDialog(p, 'موعد جديد') },
  { id: 'appt-testdrive-new', path: '/app/appointments', target: 'dialog', h: 1100, prep: (p) => openDialog(p, 'تجربة قيادة') },
  {
    id: 'appt-detail', path: async ({ api }) => {
      const from = new Date(Date.now() - 3 * 864e5).toISOString(); const to = new Date(Date.now() + 10 * 864e5).toISOString();
      const list = items(await api('/appointments', { from, to }));
      const a = list.find((x) => x.type === 'test_drive' && x.status === 'completed') ?? list[0];
      return `/app/appointments/${a.id}`;
    }, grow: true, maxH: 1400,
  },
  {
    id: 'appt-upcoming', path: async ({ api }) => {
      const from = new Date(Date.now() - 3 * 864e5).toISOString(); const to = new Date(Date.now() + 10 * 864e5).toISOString();
      const list = items(await api('/appointments', { from, to }));
      const a = list.find((x) => x.type === 'test_drive' && x.status === 'confirmed') ?? list[0];
      return `/app/appointments/${a.id}`;
    }, grow: true, maxH: 1400,
    callouts: [(p) => btn(p, 'بدء التجربة'), (p) => btn(p, 'إعادة جدولة / تعديل'), (p) => btn(p, 'لم يحضر'), (p) => btn(p, 'إلغاء الموعد')],
  },
  { id: 'wish-list', path: '/app/wishes' },
  { id: 'wish-new', as: REP, path: '/app/wishes/new', grow: true, maxH: 1800 },
  {
    id: 'wish-detail', path: async ({ api }) => { const l = items(await api('/wishes')); return `/app/wishes/${l.find((w) => (w.matchCount ?? w.matches ?? 0) > 0)?.id ?? l[l.length - 1].id}`; }, grow: true, maxH: 1400,
    callouts: [(p) => btn(p, 'تحقق من التطابق'), (p) => btn(p, 'استبعاد'), (p) => btn(p, 'تم التنفيذ'), (p) => btn(p, 'إلغاء الطلب')],
  },
  { id: 'inquiries', path: '/app/showroom/inquiries', callouts: [(p) => tab(p, 'تحتاج مراجعة'), (p) => link(p, 'فتح الفرصة البيعية')] },

  // ── Inventory ──────────────────────────────────────────────────────────────────────────
  {
    id: 'veh-grid', path: '/app/vehicles',
    prep: async (p) => { const b = p.getByRole('button', { name: 'عرض شبكي' }); if (await b.count()) await b.first().click(); },
    callouts: [(p) => btn(p, 'إضافة سيارة').or(link(p, 'إضافة سيارة')), (p) => p.locator('main input').first(), (p) => btn(p, 'في المخزون').or(tab(p, 'في المخزون')), (p) => btn(p, 'عرض جدولي')],
  },
  { id: 'veh-table', path: '/app/vehicles', prep: async (p) => { await p.getByRole('button', { name: 'عرض جدولي' }).first().click(); } },
  { id: 'veh-new', as: INV, path: '/app/vehicles/new', grow: true, maxH: 3200, clipY: [0, 1560] },
  {
    id: 'veh-360', path: ({ S }) => `/app/vehicles/${V(S, 'lc')}`, grow: true, maxH: 1300,
    callouts: [(p) => btn(p, 'تعديل').or(link(p, 'تعديل')), (p) => btn(p, 'تغيير الحالة'), (p) => btn(p, 'تحديث الأسعار'), (p) => btn(p, 'نقل لفرع آخر'), (p) => btn(p, 'بدء فحص'), (p) => p.getByRole('tablist').first()],
  },
  ...[
    ['media', 'الصور والفيديو', 'lexus'], ['documents', 'المستندات', 'lexus'], ['pricing', 'التسعير', 'lexus'], ['history', 'السجل', 'camry'],
    ['costs', 'التكاليف', 'lexus'], ['reservation', 'الحجز', 'patrol'], ['interested', 'عملاء مهتمون', 'lc'], ['listing', 'إعلان المعرض', 'sportage'],
  ].map(([key, name, car]) => ({ id: `veh-tab-${key}`, path: ({ S }) => `/app/vehicles/${V(S, car)}`, grow: true, maxH: 1800, from: (p) => p.getByRole('tablist').first(), prep: (p) => clickTab(p, name) })),
  { id: 'veh-status-dialog', as: INV, path: ({ S }) => `/app/vehicles/${V(S, 'lc')}`, target: 'dialog', prep: (p) => openDialog(p, 'تغيير الحالة') },
  { id: 'veh-pricing-dialog', path: ({ S }) => `/app/vehicles/${V(S, 'lc')}`, target: 'dialog', prep: (p) => openDialog(p, 'تحديث الأسعار') },
  { id: 'veh-transfer-dialog', as: INV, path: ({ S }) => `/app/vehicles/${V(S, 'lc')}`, target: 'dialog', prep: (p) => openDialog(p, 'نقل لفرع آخر') },
  { id: 'veh-cost-dialog', as: ACC, path: ({ S }) => `/app/vehicles/${V(S, 'lc')}`, target: 'dialog', h: 1100, prep: async (p) => { await clickTab(p, 'التكاليف'); await openDialog(p, 'إضافة تكلفة'); } },
  { id: 'inspection', as: 'insp@demo.test', path: ({ S }) => `/app/inspections/${S['inspections-pricing'].yukonDraft}`, grow: true, maxH: 2400, clipY: [0, 1120] },
  { id: 'inv-transfers', path: '/app/inventory/transfers', callouts: [(p) => btn(p, 'تأكيد الاستلام'), (p) => btn(p, 'إلغاء النقل')] },
    { id: 'inv-stockcount', path: ({ S }) => `/app/inventory/stock-counts/${S['stock-count']}`, grow: true, maxH: 1600, callouts: [(p) => p.locator('main input').first(), (p) => btn(p, 'تسجيل'), (p) => btn(p, 'إنهاء الجرد')] },
  { id: 'wo-list', path: '/app/work-orders' },
  {
    id: 'wo-detail', as: INV, path: ({ S }) => `/app/work-orders/${S['work-orders'].yukon}`, grow: true, maxH: 1500,
    callouts: [(p) => btn(p, 'إضافة بند'), (p) => btn(p, 'إنهاء وإرسال للاعتماد'), (p) => btn(p, 'إلغاء الأمر')],
  },
  { id: 'wo-item-dialog', as: INV, path: ({ S }) => `/app/work-orders/${S['work-orders'].yukon}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'إضافة بند') },
  { id: 'wo-approve-dialog', as: OWNER, path: ({ S }) => `/app/work-orders/${S['work-orders'].lc}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'اعتماد وترحيل التكاليف') },
  { id: 'inv-aging', path: '/app/inventory/aging' },

  // ── Purchasing ─────────────────────────────────────────────────────────────────────────
  { id: 'acq-list', path: '/app/purchasing/acquisitions', callouts: [(p) => link(p, 'شراء سيارة').or(btn(p, 'شراء سيارة'))] },
  { id: 'acq-new', as: INV, path: '/app/purchasing/acquisitions/new', grow: true, maxH: 3000 },
  {
    id: 'acq-pending', as: OWNER, path: ({ S }) => `/app/purchasing/acquisitions/${A(S, 'taurus')}`, grow: true, maxH: 1500,
    callouts: [(p) => btn(p, 'اعتماد'), (p) => btn(p, 'رفض'), (p) => btn(p, 'إلغاء الشراء')],
  },
  { id: 'acq-approve-dialog', as: OWNER, path: ({ S }) => `/app/purchasing/acquisitions/${A(S, 'taurus')}`, target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'اعتماد') },
  { id: 'acq-self', as: INV, path: ({ S }) => `/app/purchasing/acquisitions/${A(S, 'taurus')}`, cropH: 700 },
  { id: 'sup-list', path: '/app/purchasing/suppliers', callouts: [(p) => btn(p, 'إضافة مورد')] },
  { id: 'sup-new', path: '/app/purchasing/suppliers', target: 'dialog', h: 1100, prep: (p) => openDialog(p, 'إضافة مورد') },
  { id: 'sup-detail', path: ({ S }) => `/app/purchasing/suppliers/${S.suppliers.auction}`, grow: true, maxH: 1300 },
  { id: 'sup-statement', path: ({ S }) => `/app/purchasing/suppliers/${S.suppliers.auction}?tab=statement`, grow: true, maxH: 1300 },
  { id: 'ap-open', path: '/app/purchasing/payables' },
  { id: 'ap-aging', path: '/app/purchasing/payables?tab=aging', grow: true, maxH: 1300 },
  { id: 'sp-list', path: '/app/purchasing/payments' },
  {
    id: 'sp-new', as: ACC, path: '/app/purchasing/payments/new', grow: true, maxH: 1800,
    prep: async (p) => {
      await pick(p, 0, 'مزاد');
      const sel = p.locator('main select').first();
      const opts = await sel.locator('option').allTextContents();
      const o = opts.find((x) => x.includes('الراجحي'));
      if (o) await sel.selectOption({ label: o });
      await p.waitForTimeout(800);
      const auto = p.getByRole('button', { name: 'توزيع تلقائي (الأقدم أولًا)' });
      await p.getByLabel(/المبلغ المدفوع/).first().fill('100000').catch(() => {});
      await p.waitForTimeout(500);
      if (await auto.count()) { await auto.first().click({ timeout: 5000 }).catch(() => {}); await p.waitForTimeout(700); }
    },
  },
  { id: 'cost-allocate', as: ACC, path: '/app/costs/allocate', grow: true, maxH: 1600 },

  // ── Finance ────────────────────────────────────────────────────────────────────────────
  { id: 'cash-accounts', path: '/app/cash/accounts', callouts: [(p) => btn(p, 'حساب جديد'), (p) => txt(p, 'إجمالي النقدية والبنوك')] },
  { id: 'cash-account-new', as: ACC, path: '/app/cash/accounts', target: 'dialog', h: 1100, prep: (p) => openDialog(p, 'حساب جديد') },
  { id: 'cash-book', path: ({ S }) => `/app/cash/accounts/${S.cash.mainBox}`, grow: true, maxH: 1800 },
  { id: 'cash-transfers', path: '/app/cash/transfers', callouts: [(p) => btn(p, 'تحويل جديد')] },
  {
    id: 'cash-transfer-new', as: ACC, path: '/app/cash/transfers', target: 'dialog', h: 1100,
    prep: async (p) => {
      await openDialog(p, 'تحويل جديد');
      const d = p.locator('dialog[open]');
      const sels = d.locator('select');
      const pick = async (i, t) => { const opts = await sels.nth(i).locator('option').allTextContents(); const o = opts.find((x) => x.includes(t)); if (o) await sels.nth(i).selectOption({ label: o }); };
      await pick(0, 'الدولار'); await p.waitForTimeout(300); await pick(1, 'الراجحي'); await p.waitForTimeout(500); await d.getByLabel('المبلغ المحوَّل').first().fill('1000'); await p.waitForTimeout(600);
    },
  },
  { id: 'cash-transfer-detail', path: async ({ api }) => { const l = items(await api('/cash/transfers')); const t = l.find((x) => JSON.stringify(x).includes('USD')) ?? l[0]; return `/app/cash/transfers/${t.transferId ?? t.id}`; }, grow: true, maxH: 1400 },
  { id: 'cash-closing', as: ACC, path: ({ S }) => `/app/cash-closing?account=${S.cash.mainBox}`, grow: true, maxH: 1500 },
  { id: 'receipts', path: '/app/receipts', callouts: [(p) => btn(p, 'سند قبض جديد')] },
  { id: 'receipt-new', as: ACC, path: '/app/receipts', target: 'dialog', h: 1100, prep: (p) => openDialog(p, 'سند قبض جديد') },
  { id: 'receipt-detail', path: async ({ api }) => { const l = items(await api('/receipts')); return `/app/receipts/${l[l.length - 1].id}`; }, grow: true, maxH: 1300 },
  { id: 'refunds', path: '/app/refunds', prep: (p) => clickTab(p, 'الكل') },
  { id: 'refund-new', as: ACC, path: '/app/refunds', target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'طلب استرداد') },
  { id: 'expenses', path: '/app/expenses', grow: true, maxH: 1400, callouts: [(p) => btn(p, 'تسجيل مصروف')] },
  { id: 'expense-new', as: 'cashier@demo.test', path: '/app/expenses', target: 'dialog', h: 1100, prep: (p) => openDialog(p, 'تسجيل مصروف') },
  { id: 'expense-pending', as: OWNER, path: async ({ api }) => { const l = items(await api('/expenses', { status: 'pending_approval' })); return `/app/expenses/${l[0].id}`; }, grow: true, maxH: 1200, callouts: [(p) => btn(p, 'اعتماد وترحيل'), (p) => btn(p, 'رفض')] },
  { id: 'expense-posted', path: async ({ api }) => { const l = items(await api('/expenses', { status: 'posted' })); return `/app/expenses/${(l.find((e) => e.description?.includes('إيجار')) ?? l[0]).id}`; }, grow: true, maxH: 1400 },
  ...['accounts', 'trial', 'journal', 'statement', 'income', 'balance', 'reconciliation'].map((k) => ({
    id: `ledger-${k}`, as: ACC, path: `/app/accounting?tab=${k}`, grow: true, maxH: 1700, clipY: [0, 1500],
    prep: k !== 'statement' ? undefined : async (p) => {
      for (const sel of await p.locator('main select').all()) {
        const opts = await sel.locator('option').allTextContents();
        const o = opts.find((x) => x.includes('2100'));
        if (o) { await sel.selectOption({ label: o }); await p.waitForTimeout(1200); break; }
      }
    },
  })),
  { id: 'ledger-entry', as: ACC, path: async ({ api }) => { const l = items(await api('/ledger/entries')); return `/app/accounting/entries/${l[0].id}`; }, grow: true, maxH: 1300 },
  { id: 'reports-hub', path: '/app/reports' },
  { id: 'report-sales', path: '/app/reports/sales', grow: true, maxH: 1400, callouts: [(p) => txt(p, 'الفترة'), (p) => link(p, 'Excel').or(btn(p, 'Excel')), (p) => txt(p, 'المطابقة مع دفتر الأستاذ')] },
  { id: 'report-inventory', path: '/app/reports/inventory', grow: true, maxH: 1400, clipY: [0, 1200] },
  { id: 'report-receivables', path: '/app/reports/receivables', grow: true, maxH: 1400, clipY: [0, 1100] },

  // ── Showroom ───────────────────────────────────────────────────────────────────────────
  { id: 'show-listings', as: SM, path: '/app/showroom', callouts: [(p) => btn(p, 'فتح المعرض العام').or(link(p, 'فتح المعرض العام')), (p) => link(p, 'الاستفسارات').or(btn(p, 'الاستفسارات')), (p) => link(p, 'إعدادات المعرض').or(btn(p, 'إعدادات المعرض'))] },
  {
    id: 'show-editor', as: SM, path: ({ S }) => `/app/showroom/vehicles/${V(S, 'sportage')}`, grow: true, maxH: 2400,
    callouts: [(p) => btn(p, 'اقتراح وصف'), (p) => btn(p, 'حفظ المحتوى'), (p) => btn(p, 'إلغاء النشر'), (p) => btn(p, 'نسخ الرابط'), (p) => txt(p, 'رمز QR')],
  },
  { id: 'show-public', as: null, path: '/showroom/demo-e', target: 'page', grow: true, maxH: 1500 },
  { id: 'show-public-vehicle', as: null, path: async () => '/showroom/demo-e', target: 'page', grow: true, maxH: 2200, prep: async (p) => { await p.getByRole('link', { name: /سبورتاج|التفاصيل/ }).first().click(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(1200); } },
  { id: 'mobile-public', as: null, path: '/showroom/demo-e', w: 390, h: 844, mobile: true },
  { id: 'integrations', path: '/app/settings/integrations', grow: true, maxH: 2400 },

  // ── Settings ───────────────────────────────────────────────────────────────────────────
  { id: 'set-company-1', path: '/app/settings/company', grow: true, maxH: 7000, clipY: [0, 1110] },
  { id: 'set-company-2', path: '/app/settings/company', grow: true, maxH: 7000, clipY: [1100, 2380] },
  { id: 'set-company-3', path: '/app/settings/company', grow: true, maxH: 7000, clipY: [2360, 3048] },
  { id: 'set-branches', path: '/app/settings/branches', callouts: [(p) => btn(p, 'إضافة فرع')] },
  { id: 'set-branch-dialog', path: '/app/settings/branches', target: 'dialog', h: 1000, prep: (p) => openDialog(p, 'إضافة فرع') },
  { id: 'set-users', path: '/app/settings/users', grow: true, maxH: 1300, callouts: [(p) => btn(p, 'إضافة مستخدم')] },
  { id: 'set-user-dialog', path: '/app/settings/users', target: 'dialog', h: 1100, prep: (p) => openDialog(p, 'إضافة مستخدم') },
  { id: 'set-roles', path: '/app/settings/roles', grow: true, maxH: 1400, callouts: [(p) => btn(p, 'دور جديد')] },
  { id: 'set-role-dialog', path: '/app/settings/roles', target: 'dialog', h: 1200, prep: (p) => openDialog(p, 'دور جديد') },
  { id: 'set-audit', path: '/app/settings/audit', grow: true, maxH: 1400, prep: async (p) => { await clickBtn(p, 'التحقق من سلامة السجل'); await p.waitForTimeout(1200); const f = p.locator('main input').first(); await f.fill('sale'); await f.press('Enter'); await p.waitForTimeout(1500); } },
  {
    id: 'set-privacy', path: '/app/settings/privacy', grow: true, maxH: 1500,
    prep: async (p) => { await p.locator('main input').first().fill('+966559000002'); await clickBtn(p, 'بحث'); await p.waitForTimeout(1200); },
  },
  { id: 'set-pipeline', path: '/app/settings/pipeline', grow: true, maxH: 1300 },
  { id: 'emp-list', path: '/app/employees' },
  { id: 'emp-profile', path: ({ S }) => `/app/employees/${S.users.rep}`, grow: true, maxH: 1400 },
  { id: 'comm-policies', path: '/app/commission-policies', grow: true, maxH: 1500 },
  { id: 'comm-policy', path: '/app/commission-policies/sales_std', grow: true, maxH: 1600 },
  { id: 'platform', as: 'admin@sandbox.test', path: '/platform', target: 'page', grow: true, maxH: 1400 },
];
