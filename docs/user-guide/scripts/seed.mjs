// Seeds clearly fictional demo data into a FRESH sandbox (scripts/dev-sandbox.sh start e 3105 5205)
// through the real API, so the screenshots show a realistic dealership. Every name, phone number and
// company below is made up. Resumable: finished steps are remembered in build/.seed-state.json.
//
//   node docs/user-guide/build/seed.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Client, WEB } from './client.mjs';
import { renderPhotos } from './demo-photos.mjs';

const STATE_FILE = new URL('./.seed-state.json', import.meta.url);
const PHOTO_DIR = new URL('./.demo-photos/', import.meta.url).pathname;
const S = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(S, null, 2));
async function step(name, fn) {
  if (S[name] !== undefined) return S[name];
  process.stdout.write(`• ${name} … `);
  const r = await fn();
  S[name] = r ?? true;
  save();
  console.log('ok');
  return S[name];
}

const TZ = 'Asia/Riyadh';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
const inMinutes = (m) => new Date(Date.now() + m * 6e4).toISOString();
/** An ISO instant at hh:mm Riyadh time, n days from today. */
const riyadhAt = (dayOffset, hh, mm = 0) => {
  const d = new Date(Date.now() + dayOffset * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
  return new Date(`${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+03:00`).toISOString();
};

const PW = 'SandboxPassw0rd!';
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
function vin(seed) {
  // Deterministic VIN with a valid ISO 3779 check digit.
  const map = Object.fromEntries([...'0123456789'].map((c) => [c, +c]).concat(
    Object.entries({ A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 })));
  const w = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  let x = seed * 7919 + 13;
  const b = Array.from({ length: 17 }, () => VIN_CHARS[(x = (x * 48271) % 2147483647) % VIN_CHARS.length]);
  b[0] = 'J'; b[1] = 'T'; b[9] = 'N';
  const sum = b.reduce((s, c, i) => s + map[c] * w[i], 0) % 11;
  b[8] = sum === 10 ? 'X' : String(sum);
  return b.join('');
}

const owner = await Client.login('owner@demo.test');

// ── Company, branches ──────────────────────────────────────────────────────────────────────
const branches = await step('branches', async () => {
  const [main] = await owner.get('/branches');
  await owner.put(`/branches/${main.id}`, { name: 'فرع الرياض — طريق الملك فهد', city: 'الرياض', address: 'طريق الملك فهد، حي العليا (عنوان توضيحي)', phone: '+966110000001' });
  const jed = await owner.post('/branches', { name: 'فرع جدة — طريق المدينة', code: 'JED', city: 'جدة', address: 'طريق المدينة المنورة (عنوان توضيحي)', phone: '+966120000002' });
  return { main: main.id, jed: jed.id };
});

await step('company', async () => {
  await owner.patch('/company', {
    name: 'معرض الواحة للسيارات (بيانات تجريبية)',
    settings: {
      tax: { mode: 'standard', ratePct: '15', pricesIncludeTax: true, taxNumber: '300000000000003' },
      fx: { referenceRates: { USD: '3.75' }, maxDeviationPct: '2' },
      installments: { enabled: true },
      reservation: { defaultDays: 7, defaultRefundPolicy: 'refundable', defaultRefundablePct: '100' },
      documents: {
        legalNameAr: 'شركة الواحة لتجارة السيارات (اسم تجريبي)',
        legalNameEn: 'Al Waha Motors Trading Co. (demo)',
        commercialRegistration: '1010000000',
        addressAr: 'الرياض، طريق الملك فهد (عنوان توضيحي)',
        addressEn: 'King Fahd Road, Riyadh (demo address)',
        phone: '+966110000001',
        email: 'info@alwaha-demo.test',
        contractTermsAr: 'تُسلَّم السيارة بحالتها الموضحة في تقرير الفحص. (شروط تجريبية)',
        invoiceFooterAr: 'شكرًا لتعاملكم معنا. (فاتورة تجريبية)',
      },
      showroom: {
        enabled: true, showReserved: true, showPrices: true, acknowledgeInquiries: false,
        whatsappNumber: '+966500000000', headlineAr: 'سيارات مفحوصة بضمان المعرض', headlineEn: 'Inspected cars with dealer warranty',
      },
      privacy: { inquiryRetentionDays: 365 },
    },
  });
  // Rename the owner (the sandbox provisions "Demo Owner").
  const users = await owner.get('/users');
  const me = users.find((u) => u.email === 'owner@demo.test');
  await owner.patch(`/users/${me.membershipId ?? me.id}`, { fullName: 'خالد العتيبي (المالك)' }).catch((e) => console.log('rename owner skipped:', e.message.slice(0, 120)));
});

// ── Roles & users ──────────────────────────────────────────────────────────────────────────
const users = await step('users', async () => {
  const roles = await owner.get('/roles');
  const role = (k) => roles.find((r) => r.key === k).id;
  const cashier = await owner.post('/roles', {
    name: 'أمين الصندوق', description: 'دور مخصص: تحصيل المبالغ وتسجيل المصروفات دون اعتمادها',
    permissions: ['dashboard.view', 'cash.read', 'payments.read', 'payments.receive', 'expenses.read', 'expenses.create', 'customers.read', 'customers.read_all', 'sales.read', 'reservations.read', 'installments.read', 'installments.collect'],
    maxDiscountPct: '0',
  });
  const add = async (email, fullName, roleId, allBranches, branchIds = []) =>
    (await owner.post('/users', { email, fullName, password: PW, roleId, allBranches, branchIds, phone: null })).userId;
  return {
    bm: await add('bm@demo.test', 'سعد الحربي', role('branch_manager'), true),
    sm: await add('sm@demo.test', 'فهد القحطاني', role('sales_manager'), true),
    rep: await add('rep@demo.test', 'ريم الشهري', role('sales_rep'), false, [branches.main]),
    rep2: await add('rep2@demo.test', 'عمر الزهراني', role('sales_rep'), false, [branches.jed]),
    acc: await add('acc@demo.test', 'نورة الدوسري', role('accountant'), true),
    inv: await add('inv@demo.test', 'تركي المطيري', role('inventory_manager'), true),
    insp: await add('insp@demo.test', 'ماجد السبيعي', role('inspector'), false, [branches.main]),
    cashier: await add('cashier@demo.test', 'سلمى العنزي', cashier.id, false, [branches.main]),
  };
});

const bm = await Client.login('bm@demo.test');
const sm = await Client.login('sm@demo.test');
const rep = await Client.login('rep@demo.test');
const acc = await Client.login('acc@demo.test');
const inv = await Client.login('inv@demo.test');

// ── Commission policies & employee profiles ───────────────────────────────────────────────
await step('commissions', async () => {
  const std = await owner.post('/commission-policies', {
    code: 'sales_std', name: 'عمولة المندوبين الأساسية',
    rule: { type: 'pct_of_profit', ratePct: '10', requirePositiveProfit: true, minAmount: '300.00', earnOn: 'delivery' },
  });
  await owner.post('/commission-policies', {
    code: 'managers_tiered', name: 'شرائح مديري المبيعات',
    rule: { type: 'tiered', tierBase: 'sale', tierMode: 'marginal', tiers: [{ from: '0.00', ratePct: '0.5' }, { from: '500000.00', ratePct: '0.75' }], earnOn: 'full_payment' },
  });
  const prof = (uid, b) => owner.put(`/employees/${uid}/profile`, b);
  await prof(users.rep, { employeeCode: 'S-101', jobTitle: 'مندوبة مبيعات', hireDate: '2025-03-01', monthlyTargetUnits: 6, monthlyTargetAmount: '600000.00', commissionPolicyId: std.id });
  await prof(users.rep2, { employeeCode: 'S-102', jobTitle: 'مندوب مبيعات', hireDate: '2025-06-15', monthlyTargetUnits: 5, monthlyTargetAmount: '450000.00', commissionPolicyId: std.id });
  await prof(users.sm, { employeeCode: 'M-201', jobTitle: 'مدير المبيعات', hireDate: '2024-01-10', monthlyTargetUnits: 15 });
  await prof(users.acc, { employeeCode: 'F-301', jobTitle: 'محاسبة أولى', hireDate: '2024-05-20' });
  return { std: std.id };
});

// ── Suppliers ──────────────────────────────────────────────────────────────────────────────
const sup = await step('suppliers', async () => {
  const add = (b) => inv.post('/suppliers', b).then((r) => r.id);
  return {
    dealer: await add({ type: 'dealer', name: 'مؤسسة الريان لتجارة السيارات', phone: '+966500000101', city: 'الرياض', taxNumber: '300000000100003' }),
    auction: await add({ type: 'auction', name: 'مزاد الخليج للسيارات', phone: '+966500000102', city: 'الدمام' }),
    person: await add({ type: 'individual', name: 'عبدالله الغامدي', phone: '+966500000103', city: 'الرياض', nationalId: '1000000001' }),
    workshop: await add({ type: 'workshop', name: 'ورشة الإتقان للسمكرة والدهان', phone: '+966500000104', city: 'الرياض' }),
    transport: await add({ type: 'company', name: 'شركة النقل السريع', phone: '+966500000105', city: 'جدة' }),
    landlord: await acc.post('/suppliers', { type: 'company', name: 'مكتب الندى للعقارات', phone: '+966500000106', city: 'الرياض' }).then((r) => r.id),
  };
});

// ── Cash & bank accounts ───────────────────────────────────────────────────────────────────
const cash = await step('cash', async () => {
  const add = (b) => acc.post('/cash-accounts', b, { idem: true }).then((r) => r.id);
  return {
    mainBox: await add({ type: 'cashbox', name: 'الخزينة الرئيسية — الرياض', currency: 'SAR', branchId: branches.main, openingBalance: '150000.00', openingDate: '2026-07-01' }),
    jedBox: await add({ type: 'cashbox', name: 'خزينة فرع جدة', currency: 'SAR', branchId: branches.jed, openingBalance: '40000.00', openingDate: '2026-07-01' }),
    bank: await add({ type: 'bank', name: 'بنك الراجحي — الحساب الجاري (تجريبي)', currency: 'SAR', bankName: 'مصرف الراجحي', accountNumber: '000000000001', iban: 'SA0000000000000000000001', openingBalance: '1800000.00', openingDate: '2026-07-01' }),
    usd: await add({ type: 'bank', name: 'حساب الدولار — البنك الأهلي (تجريبي)', currency: 'USD', bankName: 'البنك الأهلي السعودي', accountNumber: '000000000002', openingBalance: '20000.00', exchangeRate: '3.75', openingDate: '2026-07-01' }),
  };
});

// ── Vehicles via acquisitions ─────────────────────────────────────────────────────────────
const catalog = await step('catalog', async () => {
  const makes = await owner.get('/catalog/makes');
  const out = {};
  const pick = async (mk, md) => {
    const m = makes.find((x) => x.nameEn === mk);
    const models = await owner.get('/catalog/models', { makeId: m.id });
    const mod = models.find((x) => x.nameEn === md) ?? models[0];
    out[`${mk}|${md}`] = { makeId: m.id, modelId: mod.id, modelAr: mod.nameAr, makeAr: m.nameAr };
  };
  for (const [a, b] of [['Toyota', 'Camry'], ['Hyundai', 'Tucson'], ['Nissan', 'Patrol'], ['Kia', 'Sportage'], ['Lexus', 'ES'], ['Toyota', 'Land Cruiser'], ['GMC', 'Yukon'], ['Hyundai', 'Elantra'], ['Ford', 'Taurus'], ['Mercedes-Benz', 'C-Class'], ['Chevrolet', 'Tahoe'], ['Mazda', 'CX-5']])
    await pick(a, b);
  return out;
});

const CARS = [
  // key, make|model, year, color(ar), price, date, supplier, branch, odometer, extra
  ['camry', 'Toyota|Camry', 2023, 'أبيض لؤلؤي', '92000.00', daysAgo(70), 'dealer', 'main', 38000, { trim: 'GLE', bodyType: 'sedan', fuelType: 'petrol', transmission: 'automatic' }],
  ['tucson', 'Hyundai|Tucson', 2022, 'رمادي', '78000.00', daysAgo(65), 'auction', 'main', 52000, { trim: 'Smart', bodyType: 'suv', fuelType: 'petrol', transmission: 'automatic' }],
  ['patrol', 'Nissan|Patrol', 2021, 'أسود', '185000.00', daysAgo(50), 'dealer', 'main', 64000, { trim: 'LE Platinum', bodyType: 'suv', fuelType: 'petrol', transmission: 'automatic' }],
  ['sportage', 'Kia|Sportage', 2023, 'أزرق', '84000.00', daysAgo(45), 'auction', 'main', 21000, { trim: 'GT-Line', bodyType: 'suv', fuelType: 'petrol', transmission: 'automatic' }],
  ['lexus', 'Lexus|ES', 2022, 'عنابي', '138000.00', daysAgo(40), 'person', 'main', 41000, { trim: '350 Platinum', bodyType: 'sedan', fuelType: 'petrol', transmission: 'automatic' }],
  ['lc', 'Toyota|Land Cruiser', 2020, 'فضي', '210000.00', daysAgo(105), 'dealer', 'main', 98000, { trim: 'GXR', bodyType: 'suv', fuelType: 'petrol', transmission: 'automatic' }],
  ['yukon', 'GMC|Yukon', 2021, 'أبيض', '160000.00', daysAgo(30), 'auction', 'main', 73000, { trim: 'Denali', bodyType: 'suv', fuelType: 'petrol', transmission: 'automatic' }],
  ['taurus', 'Ford|Taurus', 2022, 'أحمر', '72000.00', daysAgo(12), 'person', 'main', 47000, { trim: 'Limited', bodyType: 'sedan', fuelType: 'petrol', transmission: 'automatic' }],
  ['merc', 'Mercedes-Benz|C-Class', 2021, 'رمادي داكن', '128000.00', daysAgo(35), 'dealer', 'main', 56000, { trim: 'C200', bodyType: 'sedan', fuelType: 'petrol', transmission: 'automatic' }],
  ['tahoe', 'Chevrolet|Tahoe', 2022, 'أسود', '175000.00', daysAgo(25), 'dealer', 'jed', 39000, { trim: 'LT', bodyType: 'suv', fuelType: 'petrol', transmission: 'automatic' }],
  ['cx5', 'Mazda|CX-5', 2023, 'أحمر ناري', '88000.00', daysAgo(20), 'auction', 'jed', 18000, { trim: 'Signature', bodyType: 'suv', fuelType: 'petrol', transmission: 'automatic' }],
];

const veh = await step('acquisitions', async () => {
  const out = {};
  let i = 1;
  for (const [key, mm, year, color, price, date, supplier, br, odo, extra] of CARS) {
    const c = catalog[mm];
    const acq = await inv.post('/acquisitions', {
      branchId: branches[br], supplierId: sup[supplier], sourceType: supplier === 'person' ? 'individual' : supplier === 'auction' ? 'auction' : 'company',
      purchaseDate: date, purchasePrice: price, currency: 'SAR', paymentMethod: 'bank_transfer', dueDate: daysAgo(-15 + i), submit: true,
      notes: 'عملية شراء تجريبية لأغراض الدليل',
      vehicle: { makeId: c.makeId, modelId: c.modelId, modelYear: year, odometerValue: odo, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: color, interiorColor: 'بيج', condition: 'used', vin: vin(i), plateNumber: `${1000 + i} أ ب ح`, locationLabel: `صف ${String.fromCharCode(64 + ((i % 4) + 1))}-${i}`, ...extra },
    }, { idem: true });
    out[key] = { acqId: acq.id, vehicleId: acq.vehicleId ?? acq.vehicle.id, number: acq.number, version: acq.version, label: `${c.makeAr} ${c.modelAr} ${year}` };
    i++;
  }
  return out;
});

await step('approve-acquisitions', async () => {
  for (const [key, v] of Object.entries(veh)) {
    if (key === 'taurus') continue; // stays pending approval (shows in the approvals inbox)
    const cur = await bm.get(`/acquisitions/${v.acqId}`);
    await bm.post(`/acquisitions/${v.acqId}/approve`, { version: cur.version, note: 'تمت المراجعة' }, { idem: true });
  }
  // One draft acquisition (not submitted), for the list.
  const c = catalog['Hyundai|Elantra'];
  const d = await inv.post('/acquisitions', {
    branchId: branches.main, supplierId: sup.person, sourceType: 'individual', purchaseDate: today(), purchasePrice: '54000.00', currency: 'SAR', submit: false,
    vehicle: { makeId: c.makeId, modelId: c.modelId, modelYear: 2024, odometerValue: 9000, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'أبيض', vin: vin(40), bodyType: 'sedan' },
  }, { idem: true });
  return { draft: d.id };
});

// Supplier payments for some purchases (accountant).
await step('supplier-payments', async () => {
  const pay = async (key, amount, account = cash.bank) => {
    const a = await acc.get(`/acquisitions/${veh[key].acqId}`);
    await acc.post('/supplier-payments', {
      supplierId: a.supplierId, cashAccountId: account, paidAt: daysAgo(10), method: 'bank_transfer', reference: `TRF-${key.toUpperCase()}`, amount,
      allocations: [{ targetType: 'acquisition', targetId: a.id, amountBase: amount }],
    }, { idem: true });
  };
  for (const k of ['camry', 'tucson', 'patrol', 'lexus', 'lc', 'merc', 'tahoe']) {
    const a = await acc.get(`/acquisitions/${veh[k].acqId}`);
    await pay(k, a.purchasePriceBase ?? a.purchasePrice);
  }
  await pay('sportage', '40000.00'); // partly paid
});

// ── Inspections, pricing, availability ────────────────────────────────────────────────────
const insp = await Client.login('insp@demo.test');
async function inspect(vehicleId, { complete = true, notes = 'لا توجد ملاحظات جوهرية', by = insp } = {}) {
  const insp = by;
  const st = await insp.post(`/vehicles/${vehicleId}/inspections`, { type: 'acquisition' });
  const d = await insp.get(`/inspections/${st.id}`);
  const items = d.items.map((it, n) => ({ sectionKey: it.sectionKey, itemKey: it.itemKey, result: complete ? (n % 9 === 4 ? 'attention' : 'ok') : n < 6 ? 'ok' : 'not_checked', ...(complete && n % 9 === 4 ? { severity: 'low', notes: 'خدوش سطحية بسيطة' } : {}) }));
  const v = (await insp.get(`/vehicles/${vehicleId}`)).vehicle;
  await insp.put(`/inspections/${st.id}`, {
    items, overallResult: complete ? 'pass_with_notes' : undefined, summary: notes, recommendations: 'تلميع خارجي قبل العرض',
    odometerValue: (v.odometerValue ?? 0) + 40, odometerUnit: 'km',
  });
  if (complete) await insp.post(`/inspections/${st.id}/complete`);
  return st.id;
}

const PRICES = {
  camry: ['116500.00', '111000.00'], tucson: ['99000.00', '94000.00'], patrol: ['234000.00', '222000.00'], sportage: ['106500.00', '101000.00'],
  lexus: ['174500.00', '165000.00'], lc: ['265500.00', '252000.00'], merc: ['162000.00', '154000.00'], tahoe: ['221500.00', '210000.00'], cx5: ['111500.00', '106000.00'],
};

await step('inspections-pricing', async () => {
  const out = {};
  for (const k of ['camry', 'tucson', 'patrol', 'sportage', 'lexus', 'lc', 'merc', 'tahoe', 'cx5']) {
    const id = veh[k].vehicleId;
    const cur = (await inv.get(`/vehicles/${id}`)).vehicle;
    if (cur.status === 'available') continue;
    out[k] = await inspect(id, { by: ['tahoe', 'cx5'].includes(k) ? inv : insp });
    const [ask, min] = PRICES[k];
    const first = (Number(ask) + 6000).toFixed(2);
    await owner.put(`/vehicles/${id}/pricing`, { askingPrice: first, minPrice: min, targetMarginPct: '12', reason: 'تسعير مبدئي عند الاستلام' });
    await owner.put(`/vehicles/${id}/pricing`, { askingPrice: ask, minPrice: min, targetMarginPct: '12', reason: 'تعديل حسب السوق' });
    if ((await inv.get(`/vehicles/${id}`)).vehicle.status !== 'available') await inv.post(`/vehicles/${id}/status`, { to: 'available' });
  }
  // Yukon: in preparation (work order); Taurus pending; an in-progress inspection on the Yukon.
  await inv.post(`/vehicles/${veh.yukon.vehicleId}/status`, { to: 'in_inspection' });
  out.yukonDraft = await inspect(veh.yukon.vehicleId, { complete: false, notes: 'جارٍ الفحص' });
  return out;
});

await step('features', async () => {
  const feats = await owner.get('/catalog/features');
  const ids = feats.slice(0, 8).map((f) => f.id);
  for (const k of ['lexus', 'patrol', 'lc', 'camry']) await inv.put(`/vehicles/${veh[k].vehicleId}/features`, { featureIds: ids.slice(0, k === 'lexus' ? 8 : 5) });
});

// ── Photos ─────────────────────────────────────────────────────────────────────────────────
await step('photos', async () => {
  const colors = { lexus: '#7a1f2b', sportage: '#1d4f91', lc: '#a7adb4', patrol: '#1f1f22', merc: '#4a4f55', camry: '#f1f1ee', cx5: '#b3121b', tahoe: '#202124' };
  const files = await renderPhotos(PHOTO_DIR, Object.entries(colors).map(([key, color]) => ({ key, color, label: veh[key].label })));
  for (const [key, list] of Object.entries(files)) {
    if (key === 'lc') continue; // the aging page recommends adding photos for this one
    for (const [n, f] of list.entries()) {
      const fd = new FormData();
      fd.append('file', new Blob([readFileSync(f)], { type: 'image/jpeg' }), `${key}-${n + 1}.jpg`);
      fd.append('category', 'general');
      fd.append('isPublic', 'true');
      fd.append('caption', n === 0 ? 'منظر جانبي' : 'صورة إضافية');
      await inv.post(`/vehicles/${veh[key].vehicleId}/media`, fd);
    }
  }
});

// ── Vehicle costs, work orders ────────────────────────────────────────────────────────────
const cats = await step('categories', async () => Object.fromEntries((await owner.get('/cost-categories')).map((c) => [c.code, c.id])));

await step('costs', async () => {
  await acc.post('/vehicle-costs', { vehicleId: veh.camry.vehicleId, categoryId: cats.transport, description: 'نقل السيارة من المورد إلى المعرض', amount: '650.00', currency: 'SAR', costDate: daysAgo(68), supplierId: sup.transport }, { idem: true });
  await acc.post('/vehicle-costs', { vehicleId: veh.camry.vehicleId, categoryId: cats.detailing, description: 'تلميع وتنظيف داخلي', amount: '450.00', currency: 'SAR', costDate: daysAgo(66), payNow: { cashAccountId: cash.mainBox, method: 'cash' } }, { idem: true });
  await acc.post('/vehicle-costs', { vehicleId: veh.lexus.vehicleId, categoryId: cats.registration, description: 'تجديد الاستمارة', amount: '300.00', currency: 'SAR', costDate: daysAgo(30), payNow: { cashAccountId: cash.mainBox, method: 'cash' } }, { idem: true });
  // Pending (inventory manager cannot approve costs).
  await inv.post('/vehicle-costs', { vehicleId: veh.lexus.vehicleId, categoryId: cats.detailing, description: 'تلميع خارجي وحماية نانو', amount: '1200.00', currency: 'SAR', costDate: daysAgo(3) }, { idem: true });
  // Shared cost split between two vehicles.
  await acc.post('/vehicle-costs/allocate', {
    vehicleIds: [veh.patrol.vehicleId, veh.lc.vehicleId], method: 'by_purchase_price', categoryId: cats.transport,
    description: 'شحن سيارتين من ميناء الدمام', totalAmount: '2400.00', currency: 'SAR', costDate: daysAgo(44), supplierId: sup.transport,
  }, { idem: true });
});

const wo = await step('work-orders', async () => {
  const a = await inv.post('/work-orders', { vehicleId: veh.yukon.vehicleId, type: 'bodywork', priority: 'high', title: 'إصلاح صدمة الباب الخلفي ودهان', description: 'حسب تقرير الفحص', supplierId: sup.workshop, estimatedCost: '3500.00', assignedUserId: users.inv });
  await inv.post(`/work-orders/${a.id}/items`, { kind: 'labor', description: 'أجرة سمكرة ودهان الباب الخلفي الأيمن', quantity: '1', unitCost: '1800.00', hours: '6', categoryId: cats.bodywork });
  await inv.post(`/work-orders/${a.id}/items`, { kind: 'part', description: 'مقبض باب أصلي', quantity: '1', unitCost: '420.00', categoryId: cats.parts });
  await inv.post(`/work-orders/${a.id}/start`);
  const b = await inv.post('/work-orders', { vehicleId: veh.lc.vehicleId, type: 'detailing', priority: 'normal', title: 'تلميع شامل وتجديد المقصورة', assignedUserId: users.inv });
  await inv.post(`/work-orders/${b.id}/items`, { kind: 'service', description: 'تلميع خارجي ثلاث مراحل', quantity: '1', unitCost: '900.00', categoryId: cats.detailing });
  await inv.post(`/work-orders/${b.id}/items`, { kind: 'service', description: 'تنظيف وتعقيم المقصورة', quantity: '1', unitCost: '350.00', categoryId: cats.detailing });
  await inv.post(`/work-orders/${b.id}/start`);
  await inv.post(`/work-orders/${b.id}/complete`);
  const c = await inv.post('/work-orders', { vehicleId: veh.camry.vehicleId, type: 'maintenance', priority: 'normal', title: 'صيانة دورية قبل البيع', assignedUserId: users.inv });
  await inv.post(`/work-orders/${c.id}/items`, { kind: 'part', description: 'زيت وفلتر', quantity: '1', unitCost: '380.00', categoryId: cats.maintenance });
  await inv.post(`/work-orders/${c.id}/start`);
  await inv.post(`/work-orders/${c.id}/complete`);
  return { yukon: a.id, lc: b.id, camry: c.id };
});
await step('wo-approve', async () => {
  const cur = await bm.get(`/work-orders/${wo.camry}`);
  await bm.post(`/work-orders/${wo.camry}/approve`, { payNow: { cashAccountId: cash.mainBox, method: 'cash' }, note: 'معتمد', version: cur.version }, { idem: true });
  await inv.post(`/vehicles/${veh.yukon.vehicleId}/status`, { to: 'in_preparation' }).catch(() => {});
});

// ── Transfers (vehicle) and stock count ────────────────────────────────────────────────────
await step('vehicle-transfer', async () => {
  await inv.post(`/vehicles/${veh.merc.vehicleId}/transfers`, { toBranchId: branches.jed, notes: 'طلب عميل في جدة' });
});
await step('stock-count', async () => {
  const sc = await inv.post('/inventory/stock-counts', { branchId: branches.main, notes: 'جرد نهاية الشهر' });
  for (const k of ['camry', 'lexus', 'patrol']) {
    const v = (await inv.get(`/vehicles/${veh[k].vehicleId}`)).vehicle;
    await inv.post(`/inventory/stock-counts/${sc.id}/scan`, { code: v.stockNumber, location: 'الساحة الأمامية' });
  }
  await inv.post(`/inventory/stock-counts/${sc.id}/scan`, { code: 'UNKNOWN-777', notes: 'لوحة غير مقروءة' });
  return sc.id;
});

// ── Customers, leads, interactions ────────────────────────────────────────────────────────
const cust = await step('customers', async () => {
  const add = (c, b) => c.post('/customers', { preferredLanguage: 'ar', ...b }).then((r) => r.id);
  return {
    ahmad: await add(rep, { fullName: 'أحمد سالم المالكي', phone: '+966551000001', whatsapp: '+966551000001', email: 'ahmad.demo@example.test', city: 'الرياض', source: 'walk_in', nationalId: '1000000011', nationality: 'سعودي', marketingConsent: true, tags: ['VIP'], branchId: branches.main }),
    mona: await add(rep, { fullName: 'منى عبدالرحمن الزهراني', phone: '+966551000002', city: 'الرياض', source: 'showroom', branchId: branches.main }),
    yousef: await add(rep, { fullName: 'يوسف ناصر الشمري', phone: '+966551000003', city: 'الرياض', source: 'phone', branchId: branches.main }),
    fleet: await add(sm, { type: 'company', fullName: 'شركة الأفق للمقاولات (عميل تجريبي)', contactName: 'م. بدر', phone: '+966551000004', commercialRegistration: '1010000099', taxNumber: '300000000990003', city: 'الرياض', source: 'referral', tags: ['أسطول'], assignedUserId: users.sm, branchId: branches.main }),
    hind: await add(rep, { fullName: 'هند محمد القرني', phone: '+966551000005', city: 'الرياض', source: 'whatsapp', branchId: branches.main }),
    ziyad: await add(rep, { fullName: 'زياد إبراهيم العمري', phone: '+966551000006', city: 'الرياض', source: 'website', branchId: branches.main }),
    latifa: await add(sm, { fullName: 'لطيفة حمد السهلي', phone: '+966551000007', city: 'الرياض', source: 'social', assignedUserId: users.rep, branchId: branches.main }),
    nawaf: await add(sm, { fullName: 'نواف عادل الحربي', phone: '+966551000008', city: 'جدة', source: 'walk_in', assignedUserId: users.rep2, branchId: branches.jed }),
    sara: await add(sm, { fullName: 'سارة خالد البقمي', phone: '+966551000009', city: 'جدة', source: 'marketplace', assignedUserId: users.rep2, branchId: branches.jed }),
    majed: await add(rep, { fullName: 'ماجد فيصل العنزي', phone: '+966551000010', city: 'الرياض', source: 'campaign', branchId: branches.main }),
  };
});

const leads = await step('leads', async () => {
  const stages = await sm.get('/pipeline-stages');
  const st = (code) => stages.find((s) => s.code === code)?.id;
  const mk = (c, b) => c.post('/leads', { branchId: branches.main, ...b });
  const L = {};
  L.ahmad = await mk(rep, { customerId: cust.ahmad, source: 'walk_in', vehicleId: veh.camry.vehicleId, budgetMin: '105000.00', budgetMax: '118000.00', paymentPreference: 'cash', interestNotes: 'يفضّل سيدان اقتصادية بلون فاتح', nextFollowUpAt: riyadhAt(0, 18) });
  L.mona = await mk(rep, { customerId: cust.mona, source: 'showroom', vehicleId: veh.lexus.vehicleId, budgetMax: '175000.00', paymentPreference: 'bank_finance', interestNotes: 'طلبت تجربة قيادة', nextFollowUpAt: riyadhAt(-1, 11) });
  L.yousef = await mk(rep, { customerId: cust.yousef, source: 'phone', vehicleId: veh.tucson.vehicleId, budgetMax: '100000.00', paymentPreference: 'installments', nextFollowUpAt: riyadhAt(1, 10) });
  L.fleet = await mk(sm, { customerId: cust.fleet, source: 'referral', budgetMax: '900000.00', paymentPreference: 'bank_finance', interestNotes: 'أسطول 5 سيارات دفع رباعي', assignedUserId: users.sm, expectedCloseDate: daysAgo(-30) });
  L.hind = await mk(rep, { customerId: cust.hind, source: 'whatsapp', vehicleId: veh.patrol.vehicleId, budgetMax: '235000.00', paymentPreference: 'cash' });
  L.ziyad = await mk(rep, { customerId: cust.ziyad, source: 'website', vehicleId: veh.sportage.vehicleId, budgetMax: '100000.00' });
  L.latifa = await mk(sm, { customerId: cust.latifa, source: 'social', assignedUserId: users.rep, budgetMax: '120000.00', interestNotes: 'تبحث عن سيارة عائلية' });
  L.majed = await mk(rep, { customerId: cust.majed, source: 'campaign', budgetMax: '80000.00', paymentPreference: 'cash' });
  const move = async (key, code) => {
    if (!st(code)) return;
    const l = await sm.get(`/leads/${L[key].id}`);
    await sm.post(`/leads/${L[key].id}/stage`, { stageId: st(code), version: l.version, note: 'تحديث المرحلة' });
  };
  for (const [k, code] of [['mona', 'test_drive'], ['ahmad', 'negotiation'], ['yousef', 'qualified'], ['fleet', 'proposal'], ['hind', 'negotiation'], ['ziyad', 'contacted'], ['latifa', 'contacted']]) await move(k, code).catch((e) => console.log('stage', k, code, e.message.slice(0, 100)));
  const lm = await sm.get(`/leads/${L.majed.id}`);
  await sm.post(`/leads/${L.majed.id}/lost`, { reason: 'price', notes: 'وجد سعرًا أقل لدى معرض آخر', version: lm.version });
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.id]));
});

await step('interactions', async () => {
  await rep.post('/interactions', { customerId: cust.ahmad, leadId: leads.ahmad, type: 'visit', direction: 'inbound', summary: 'زار المعرض وعاين الكامري، وطلب عرض سعر نهائي', outcome: 'مهتم جدًا', occurredAt: riyadhAt(-2, 17) });
  await rep.post('/interactions', { customerId: cust.ahmad, leadId: leads.ahmad, type: 'call', direction: 'outbound', summary: 'اتصال لتأكيد السعر وطريقة الدفع النقدي', outcome: 'سيحضر للتوقيع', occurredAt: riyadhAt(-1, 12) });
  await rep.post('/interactions', { customerId: cust.yousef, leadId: leads.yousef, type: 'whatsapp', direction: 'outbound', summary: 'إرسال تفاصيل خطة التقسيط المقترحة', occurredAt: riyadhAt(-1, 15) });
});

// ── Wishes ─────────────────────────────────────────────────────────────────────────────────
await step('wishes', async () => {
  const lc = catalog['Toyota|Land Cruiser'];
  await rep.post('/wishes', { customerId: cust.yousef, makeId: lc.makeId, modelId: lc.modelId, yearFrom: 2019, maxPrice: '270000.00', notes: 'يفضّل اللون الفضي' });
  const tesla = (await owner.get('/catalog/makes')).find((m) => m.nameEn === 'Tesla');
  await rep.post('/wishes', { customerId: cust.hind, makeId: tesla.id, yearFrom: 2022, maxPrice: '200000.00', fuelType: 'electric', expiresAt: daysAgo(-60) });
});

// ── Appointments & test drive ─────────────────────────────────────────────────────────────
await step('appointments', async () => {
  const mk = (c, b) => c.post('/appointments', { branchId: branches.main, ...b });
  await mk(rep, { type: 'visit', customerId: cust.ahmad, leadId: leads.ahmad, startsAt: riyadhAt(1, 17), endsAt: riyadhAt(1, 17, 30), title: 'توقيع عقد الكامري', assignedUserId: users.rep });
  await mk(rep, { type: 'follow_up', customerId: cust.yousef, startsAt: riyadhAt(2, 11), endsAt: riyadhAt(2, 11, 30), title: 'مراجعة عرض التقسيط', assignedUserId: users.rep });
  await mk(sm, { type: 'visit', customerId: cust.fleet, startsAt: riyadhAt(3, 10), endsAt: riyadhAt(3, 11), title: 'اجتماع مع مدير المشتريات', assignedUserId: users.sm });
  const td2 = await mk(rep, { type: 'test_drive', customerId: cust.ziyad, vehicleId: veh.sportage.vehicleId, startsAt: riyadhAt(1, 19), endsAt: riyadhAt(1, 19, 45), assignedUserId: users.rep, driverLicenseNumber: 'DL-55001', driverLicenseExpiry: '2028-05-01' });
  await rep.post(`/appointments/${td2.id}/confirm`, {});
  // A test drive done now (start + finish) for the Lexus.
  const td = await mk(rep, { type: 'test_drive', customerId: cust.mona, leadId: leads.mona, vehicleId: veh.lexus.vehicleId, startsAt: inMinutes(3), endsAt: inMinutes(48), assignedUserId: users.rep });
  const v = (await rep.get(`/vehicles/${veh.lexus.vehicleId}`)).vehicle;
  const odo = Number(v.odometerValue ?? 41000) + 50;
  await rep.post(`/appointments/${td.id}/start-test-drive`, { odometerOut: odo, driverLicenseNumber: 'DL-44012', driverLicenseExpiry: '2029-02-01' });
  await rep.post(`/appointments/${td.id}/finish-test-drive`, { odometerIn: odo + 14, outcome: 'أعجبتها السيارة؛ تنتظر موافقة البنك على التمويل' });
});

// ── Reservations ───────────────────────────────────────────────────────────────────────────
await step('reservations', async () => {
  // Active reservation with deposit (Patrol, customer Hind).
  const r1 = await sm.post('/reservations', { vehicleId: veh.patrol.vehicleId, customerId: cust.hind, leadId: leads.hind, days: 7, agreedPrice: '230000.00', depositAmount: '10000.00', deposit: { cashAccountId: cash.mainBox, amount: '5000.00', method: 'cash', reference: 'إيصال يدوي 0091' } }, { idem: true });
  const c = await Client.login('cashier@demo.test');
  await c.post(`/reservations/${r1.id}/deposits`, { cashAccountId: cash.mainBox, amount: '5000.00', method: 'card', reference: 'مدى 7781' }, { idem: true });
  // Reservation cancelled with a refund (Sportage, customer Ziyad) — refund requested, approved and paid.
  const r2 = await sm.post('/reservations', { vehicleId: veh.sportage.vehicleId, customerId: cust.ziyad, leadId: leads.ziyad, days: 5, agreedPrice: '104000.00', depositAmount: '3000.00', deposit: { cashAccountId: cash.mainBox, amount: '3000.00', method: 'cash' } }, { idem: true });
  const cancelled = await sm.post(`/reservations/${r2.id}/cancel`, { reason: 'العميل غيّر رأيه بعد تجربة القيادة', refund: 'per_policy' }, { idem: true });
  const refunds = await acc.get('/refunds', { sourceId: r2.id });
  const refund = (refunds.items ?? refunds.data ?? refunds)[0];
  await acc.post(`/refunds/${refund.id}/approve`, { note: 'مطابق لسياسة الحجز' }, { idem: true });
  await acc.post(`/refunds/${refund.id}/pay`, { cashAccountId: cash.mainBox, method: 'cash', reference: 'سند صرف 0145' }, { idem: true });
  return { active: r1.id, cancelled: r2.id, refund: refund.id, cancelledResult: !!cancelled };
});

// ── Sales ──────────────────────────────────────────────────────────────────────────────────
await step('sales', async () => {
  // 1) Cash sale delivered: Camry to Ahmad by Reem (rep).
  const s1 = await rep.post('/sales', { vehicleId: veh.camry.vehicleId, customerId: cust.ahmad, leadId: leads.ahmad, paymentType: 'cash', agreedPrice: '114000.00', notes: 'بيع نقدي' });
  let cur = await sm.get(`/sales/${s1.id}`);
  if (cur.status === 'pending_approval') { await sm.post(`/sales/${s1.id}/approve`, { note: 'خصم مقبول', version: cur.version }, { idem: true }); cur = await sm.get(`/sales/${s1.id}`); }
  const conf = await sm.post(`/sales/${s1.id}/confirm`, { version: cur.version }, { idem: true });
  const due = conf.money.outstandingBeforeDelivery;
  await acc.post('/receipts', { customerId: cust.ahmad, cashAccountId: cash.bank, amount: due, method: 'bank_transfer', reference: 'حوالة 55120', allocations: [{ targetType: 'sale', targetId: s1.id, amountBase: due }] }, { idem: true });
  await acc.post(`/sales/${s1.id}/documents`, { type: 'contract' }).catch(() => {});
  await acc.post(`/sales/${s1.id}/documents`, { type: 'invoice' });
  cur = await sm.get(`/sales/${s1.id}`);
  await sm.post(`/sales/${s1.id}/deliver`, { version: cur.version, odometerValue: 38200 }, { idem: true }).catch(async () => sm.post(`/sales/${s1.id}/deliver`, { version: cur.version }, { idem: true }));
  await acc.post(`/sales/${s1.id}/documents`, { type: 'delivery_note' }).catch(() => {});

  // 2) Installment sale: Tucson to Yousef.
  const s2 = await rep.post('/sales', {
    vehicleId: veh.tucson.vehicleId, customerId: cust.yousef, leadId: leads.yousef, paymentType: 'installments', agreedPrice: '97000.00', downPayment: '25000.00',
    installmentTerms: { method: 'flat', annualRatePct: '5', count: 24, frequencyMonths: 1, firstDueDate: daysAgo(3), feesTotal: '600.00' },
  });
  cur = await sm.get(`/sales/${s2.id}`);
  if (cur.status === 'pending_approval') { await sm.post(`/sales/${s2.id}/approve`, { version: cur.version }, { idem: true }); cur = await sm.get(`/sales/${s2.id}`); }
  const c2 = await sm.post(`/sales/${s2.id}/confirm`, { version: cur.version }, { idem: true });
  const due2 = c2.money.outstandingBeforeDelivery;
  await acc.post('/receipts', { customerId: cust.yousef, cashAccountId: cash.mainBox, amount: due2, method: 'cash', allocations: [{ targetType: 'sale', targetId: s2.id, amountBase: due2 }] }, { idem: true });
  await acc.post(`/sales/${s2.id}/documents`, { type: 'invoice' });
  cur = await sm.get(`/sales/${s2.id}`);
  const del2 = await sm.post(`/sales/${s2.id}/deliver`, { version: cur.version }, { idem: true });

  // 3) Draft sale with a discount above the rep's limit → waits for price approval.
  const s3 = await rep.post('/sales', { vehicleId: veh.lexus.vehicleId, customerId: cust.mona, leadId: leads.mona, paymentType: 'external_finance', agreedPrice: '168000.00', externalFinance: { provider: 'بنك التمويل التجريبي', reference: 'APP-2026-118', amount: '130000.00' } });

  // 4) Draft cash sale in Jeddah (Tahoe) by rep2.
  const rep2 = await Client.login('rep2@demo.test');
  const s4 = await rep2.post('/sales', { vehicleId: veh.tahoe.vehicleId, customerId: cust.nawaf, paymentType: 'cash', agreedPrice: '218000.00' });
  return { cash: s1.id, inst: s2.id, discount: s3.id, jed: s4.id, plan: del2.installmentPlan?.id ?? null };
});

await step('installment-payment', async () => {
  const plans = await acc.get('/installment-plans');
  const plan = (plans.items ?? plans.data ?? plans)[0];
  const p = await acc.get(`/installment-plans/${plan.id}`);
  const first = (p.lines ?? p.schedule ?? [])[0];
  const amount = first.totalDue;
  await acc.post('/receipts', { customerId: cust.yousef, cashAccountId: cash.mainBox, amount, method: 'cash', reference: 'القسط الأول', allocations: [{ targetType: 'installment', targetId: plan.id, amountBase: amount }] }, { idem: true });
  return plan.id;
});

await step('commission-approve', async () => {
  const list = await acc.get('/commissions');
  const items = list.items ?? list.data ?? list;
  const earned = items.find((c) => c.status === 'earned');
  if (earned) await acc.post(`/commissions/${earned.id}/approve`, {}, { idem: true });
});

// ── Expenses ───────────────────────────────────────────────────────────────────────────────
await step('expenses', async () => {
  const ex = Object.fromEntries((await acc.get('/expense-categories')).map((c) => [c.code, c.id]));
  await acc.post('/expenses', { branchId: branches.main, categoryId: ex.rent, description: 'إيجار المعرض — أكتوبر', amount: '25000.00', currency: 'SAR', expenseDate: daysAgo(24), supplierId: sup.landlord, payNow: { cashAccountId: cash.bank, method: 'bank_transfer', reference: 'TRF-RENT-10' } }, { idem: true });
  await acc.post('/expenses', { branchId: branches.main, categoryId: ex.salaries, description: 'رواتب سبتمبر', amount: '68000.00', currency: 'SAR', expenseDate: daysAgo(25), payNow: { cashAccountId: cash.bank, method: 'bank_transfer' } }, { idem: true });
  await acc.post('/expenses', { branchId: branches.main, categoryId: ex.marketing, description: 'حملة إعلانية على منصات التواصل', amount: '1200.00', currency: 'USD', exchangeRate: '3.75', expenseDate: daysAgo(9), payNow: null }, { idem: true });
  await acc.post('/expenses', { branchId: branches.jed, categoryId: ex.utilities, description: 'فاتورة الكهرباء — فرع جدة', amount: '2350.00', currency: 'SAR', expenseDate: daysAgo(6), payNow: { cashAccountId: cash.jedBox, method: 'cash' } }, { idem: true });
  const cashier = await Client.login('cashier@demo.test');
  await cashier.post('/expenses', { branchId: branches.main, categoryId: ex.fuel, description: 'وقود سيارات تجربة القيادة', amount: '480.00', currency: 'SAR', expenseDate: daysAgo(1) }, { idem: true });
  await cashier.post('/expenses', { branchId: branches.main, categoryId: ex.office, description: 'قرطاسية ومستلزمات مكتبية', amount: '315.00', currency: 'SAR', expenseDate: daysAgo(2) }, { idem: true });
});

// ── Cash transfers ─────────────────────────────────────────────────────────────────────────
await step('cash-transfers', async () => {
  await acc.post('/cash/transfers', { fromAccountId: cash.bank, toAccountId: cash.mainBox, amount: '30000.00', date: daysAgo(5), reference: 'سحب نقدي', notes: 'تغذية الخزينة الرئيسية' }, { idem: true });
});
await step('cash-transfer-fx', async () => {
  await acc.post('/cash/transfers', { fromAccountId: cash.usd, toAccountId: cash.bank, amount: '5000.00', exchangeRate: '3.752', amountTo: '18760.00', date: daysAgo(4), reference: 'FX-0042', notes: 'تحويل دولار إلى ريال' }, { idem: true });
});
await step('cash-transfer-jed', async () => {
  await acc.post('/cash/transfers', { fromAccountId: cash.mainBox, toAccountId: cash.jedBox, amount: '10000.00', date: daysAgo(3), notes: 'دعم سيولة فرع جدة' }, { idem: true });
});

// ── Cash closing (yesterday, main cash box) ─────────────────────────────────────────────────
await step('cash-closing', async () => {
  const d = daysAgo(2);
  const exp = await acc.get(`/cash-accounts/${cash.mainBox}/closings/expected`, { date: d });
  const expected = exp.expectedBalance;
  if (!expected) throw new Error('no expected balance: ' + JSON.stringify(exp));
  await acc.post(`/cash-accounts/${cash.mainBox}/closings`, { businessDate: d, countedBalance: expected, notes: 'إغلاق يومي — العد مطابق' }, { idem: true });
  return { date: d, expected };
});

// ── Showroom listings & public inquiries ──────────────────────────────────────────────────
await step('listings', async () => {
  const pub = async (key, titleAr, descAr) => {
    const id = veh[key].vehicleId;
    await sm.put(`/vehicles/${id}/listing`, { titleAr, descriptionAr: descAr, titleEn: null, descriptionEn: null, descriptionSource: 'manual' });
    await sm.post(`/vehicles/${id}/listing/publish`);
  };
  await sm.put(`/vehicles/${veh.lexus.vehicleId}/listing`, { titleAr: 'لكزس ES 350 بلاتينيوم 2022 — صيانة وكالة', descriptionAr: 'سيارة بحالة ممتازة، فحص شامل في المعرض، مواصفات خليجية. (وصف تجريبي)' });
  await pub('sportage', 'كيا سبورتاج GT-Line 2023', 'ممشى قليل، شاشة كبيرة وكاميرا 360. (وصف تجريبي)');
  await pub('patrol', 'نيسان باترول بلاتينيوم 2021', 'فل كامل، سيارة عائلية فاخرة. (وصف تجريبي)');
  await pub('cx5', 'مازدا CX-5 سيجنتشر 2023', 'استهلاك وقود ممتاز وتجهيزات كاملة. (وصف تجريبي)');
  // Saved but not published:
  await sm.put(`/vehicles/${veh.tahoe.vehicleId}/listing`, { titleAr: 'شفروليه تاهو LT 2022', descriptionAr: 'مسودة إعلان (تجريبي)' }).catch(() => {});
});

await step('inquiries', async () => {
  const listings = await fetch(`${WEB}/api/v1/public/showroom/demo-e/vehicles`, { headers: { Origin: WEB } }).then((r) => r.json());
  const items = listings.items ?? listings.data ?? listings;
  const lexus = items.find((x) => JSON.stringify(x).includes('سبورتاج')) ?? items[0];
  const post = (b) => fetch(`${WEB}/api/v1/public/showroom/demo-e/inquiries`, { method: 'POST', headers: { Origin: WEB, 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true, ...b }) }).then(async (r) => { if (r.status >= 300) throw new Error(`inquiry ${r.status} ${await r.text()}`); return r.json(); });
  await post({ kind: 'test_drive', listingId: lexus.id, name: 'فيصل عبدالعزيز (زائر تجريبي)', phone: '+966559000001', message: 'أرغب في تجربة السيارة مساء الخميس', preferredDate: daysAgo(-3) });
  await post({ kind: 'inquiry', name: 'نوف سعد (زائرة تجريبية)', phone: '+966559000002', email: 'nouf.demo@example.test', message: 'هل يتوفر لديكم تمويل بدون دفعة أولى؟' });
  await post({ kind: 'inquiry', listingId: lexus.id, name: 'منى عبدالرحمن', phone: '+966551000002', message: 'هل السعر قابل للتفاوض؟' });
});

// ── Second company + invitations (login / company selection screens) ──────────────────────
await step('second-company', async () => {
  const admin = await Client.login('admin@sandbox.test');
  await admin.post('/platform/tenants', { name: 'معرض النخبة للسيارات (تجريبي)', slug: 'nukhba-demo', market: 'SA', branchName: 'فرع الدمام', planCode: 'enterprise', owner: { email: 'owner2@demo.test', fullName: 'بندر الشهراني', password: PW } }).catch((e) => console.log('tenant exists?', e.message.slice(0, 80)));
  const o2 = await Client.login('owner2@demo.test');
  const roles = await o2.get('/roles');
  const r = (k) => roles.find((x) => x.key === k).id;
  // An existing account is invited (no access until they accept): bm accepts, owner keeps it pending.
  await o2.post('/users', { email: 'bm@demo.test', fullName: 'سعد الحربي', password: PW, roleId: r('auditor'), allBranches: true, branchIds: [] }).catch(() => {});
  await o2.post('/users', { email: 'owner@demo.test', fullName: 'خالد العتيبي', password: PW, roleId: r('sales_manager'), allBranches: true, branchIds: [] }).catch(() => {});
  const bm2 = await Client.login('bm@demo.test');
  const invs = await bm2.get('/me/invitations');
  for (const i of invs.items ?? invs) await bm2.post(`/me/invitations/${i.membershipId}/accept`);
});

// A confirmed sale awaiting delivery (partly paid, no invoice yet) — shows the delivery blockers.
await step('sale-awaiting-delivery', async () => {
  const rep2 = await Client.login('rep2@demo.test');
  const s5 = await rep2.post('/sales', { vehicleId: veh.cx5.vehicleId, customerId: cust.sara, paymentType: 'cash', agreedPrice: '110000.00', notes: 'العميلة تستلم بعد إكمال المبلغ' });
  let cur = await sm.get(`/sales/${s5.id}`);
  if (cur.status === 'pending_approval') { await sm.post(`/sales/${s5.id}/approve`, { version: cur.version }, { idem: true }); cur = await sm.get(`/sales/${s5.id}`); }
  await sm.post(`/sales/${s5.id}/confirm`, { version: cur.version }, { idem: true });
  await acc.post('/receipts', { customerId: cust.sara, cashAccountId: cash.jedBox, amount: '30000.00', method: 'cash', reference: 'دفعة أولى', allocations: [{ targetType: 'sale', targetId: s5.id, amountBase: '30000.00' }] }, { idem: true });
  return s5.id;
});

// ── Back-date "days in stock" ────────────────────────────────────────────────────────────────
// The API stamps vehicles.stocked_at with the real creation time; a fresh sandbox would show every
// car as 0 days old. For the aging screens we back-date it to the purchase date (sandbox only).
await step('backdate-stock', async () => {
  const { execFileSync } = await import('node:child_process');
  const url = process.env.GUIDE_DB_OWNER_URL ?? 'postgres://autohub_owner:autohub_owner_dev@localhost:5432/autohub_test_e';
  execFileSync('psql', [url, '-qc', "UPDATE vehicles SET stocked_at = acquired_at::timestamp + interval '9 hours' WHERE acquired_at IS NOT NULL AND acquired_at < current_date"]);
});

console.log('\nSeed complete. State:', STATE_FILE.pathname);
