import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { SaleDocumentType, todayInZone } from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { receiptAllocations, receipts, saleDocuments, sales, tenants, tradeIns } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { PdfService } from '../pdf/pdf.service';

registerUniqueConstraint('sale_documents_live_uq', 'document_already_issued', 'A document of this type is already issued for this sale; void it first');

type SaleRow = typeof sales.$inferSelect;
type DocRow = typeof saleDocuments.$inferSelect;
type Locale = 'ar' | 'en';

const NUMBER_KIND = { contract: 'contract', invoice: 'invoice', delivery_note: 'delivery', credit_note: 'credit_note' } as const;

/**
 * Sale documents (contract, invoice, delivery note, credit note). Issuing freezes a snapshot of
 * everything printed — numbers are gapless per type and a document is never edited, only voided
 * (and re-issued where allowed). PDFs are rendered on demand from the snapshot, so a re-print is
 * identical to the original. Not a certified e-invoice (B-009, EXT-01).
 */
@Injectable()
export class SaleDocumentsService {
  constructor(
    private readonly dbs: DbService,
    private readonly numbering: NumberingService,
    private readonly pdf: PdfService,
    private readonly audit: AuditService,
  ) {}

  async liveDocument(saleId: string, type: SaleDocumentType): Promise<DocRow | null> {
    const [d] = await this.dbs.db
      .select()
      .from(saleDocuments)
      .where(and(eq(saleDocuments.saleId, saleId), eq(saleDocuments.type, type), eq(saleDocuments.status, 'issued')));
    return d ?? null;
  }

  async forSale(saleId: string) {
    return this.dbs.db
      .select({
        id: saleDocuments.id,
        type: saleDocuments.type,
        number: saleDocuments.number,
        issueDate: saleDocuments.issueDate,
        status: saleDocuments.status,
        issuedAt: saleDocuments.issuedAt,
        voidedAt: saleDocuments.voidedAt,
        voidReason: saleDocuments.voidReason,
      })
      .from(saleDocuments)
      .where(eq(saleDocuments.saleId, saleId))
      .orderBy(asc(saleDocuments.issuedAt));
  }

  private allowed(s: SaleRow, type: SaleDocumentType): boolean {
    if (type === 'contract' || type === 'invoice') return s.status === 'confirmed' || s.status === 'delivered';
    if (type === 'delivery_note') return s.status === 'delivered';
    return s.status === 'cancelled' || s.status === 'returned';
  }

  /** Everything the document shows, frozen at issue. */
  private async snapshot(ctx: TenantContext, s: SaleRow, type: SaleDocumentType, locale: Locale, extra: Record<string, unknown> = {}) {
    const [t] = await this.dbs.db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, ctx.tenant.id));
    const docs = ctx.tenant.settings.documents;
    const tax = ctx.tenant.settings.tax;
    const payments = await this.dbs.db
      .select({ number: receipts.number, receivedAt: receipts.receivedAt, method: receipts.method, amountBase: receiptAllocations.amountBase })
      .from(receiptAllocations)
      .innerJoin(receipts, eq(receipts.id, receiptAllocations.receiptId))
      .where(and(eq(receiptAllocations.targetType, 'sale'), eq(receiptAllocations.targetId, s.id), eq(receipts.status, 'posted')))
      .orderBy(asc(receipts.receivedAt));
    const trades = await this.dbs.db.select({ agreedValue: tradeIns.agreedValue, vehicle: tradeIns.vehicleInput, status: tradeIns.status }).from(tradeIns).where(and(eq(tradeIns.saleId, s.id), eq(tradeIns.status, 'received')));
    let schedule: Array<{ seq: number; dueDate: string; total: string }> = [];
    if (s.paymentType === 'installments' && type === 'contract') {
      const rows = await this.dbs.query<{ seq: number; due_date: string; total_due: string }>(
        `SELECT i.seq, i.due_date::text, i.total_due::text FROM installments i JOIN installment_plans p ON p.id = i.plan_id WHERE p.sale_id = $1 ORDER BY i.seq`,
        [s.id],
      );
      schedule = rows.map((r) => ({ seq: r.seq, dueDate: r.due_date, total: r.total_due }));
    }
    return {
      type,
      locale,
      currency: ctx.tenant.baseCurrency,
      company: {
        name: (locale === 'ar' ? docs.legalNameAr : docs.legalNameEn) ?? t?.name ?? '',
        commercialRegistration: docs.commercialRegistration ?? null,
        taxNumber: tax.taxNumber ?? null,
        address: (locale === 'ar' ? docs.addressAr : docs.addressEn) ?? null,
        phone: docs.phone ?? null,
        email: docs.email ?? null,
      },
      sale: {
        number: s.number,
        saleDate: s.saleDate,
        paymentType: s.paymentType,
        status: s.status,
        deliveredAt: s.deliveredAt,
      },
      customer: s.customerSnapshot,
      vehicle: s.vehicleSnapshot,
      pricing: {
        askingPrice: s.askingPrice,
        agreedPrice: s.agreedPrice,
        discountAmount: s.discountAmount,
        netAmount: s.netAmount,
        taxLabel: locale === 'ar' ? tax.labelAr : tax.labelEn,
        taxMode: s.taxMode,
        taxRatePct: s.taxRatePct,
        taxAmount: s.taxAmount,
        grossAmount: s.grossAmount,
        tradeInCredit: s.tradeInCredit,
        depositTransferred: s.depositTransferred,
        downPayment: s.downPayment,
        financedAmount: s.financedAmount,
      },
      tradeIns: trades,
      payments,
      schedule,
      terms: type === 'contract' ? ((locale === 'ar' ? docs.contractTermsAr : docs.contractTermsEn) ?? null) : null,
      footer: (locale === 'ar' ? docs.invoiceFooterAr : docs.invoiceFooterEn) ?? null,
      ...extra,
    };
  }

  private async insert(ctx: TenantContext, s: SaleRow, type: SaleDocumentType, locale: Locale, extra: Record<string, unknown> = {}): Promise<DocRow> {
    const number = await this.numbering.next(NUMBER_KIND[type]);
    const [doc] = await this.dbs.db
      .insert(saleDocuments)
      .values({
        tenantId: ctx.tenant.id,
        saleId: s.id,
        type,
        number,
        issueDate: todayInZone(ctx.tenant.settings.timezone),
        snapshot: await this.snapshot(ctx, s, type, locale, extra),
        issuedBy: ctx.userId,
      })
      .returning();
    await this.audit.record({ action: `sale_document.issued`, entityType: 'sale', entityId: s.id, summary: `${type} ${number}`, after: { documentId: doc!.id, type, number } });
    return doc!;
  }

  async issue(ctx: TenantContext, saleId: string, input: { type: 'contract' | 'invoice' | 'delivery_note'; locale?: Locale }) {
    assertPermission(ctx, 'documents.issue');
    const [s] = await this.dbs.db.select().from(sales).where(eq(sales.id, saleId)).for('update');
    if (!s) throw notFound('Sale');
    assertBranchAccess(ctx, s.branchId);
    if (!this.allowed(s, input.type)) throw conflict('document_not_allowed', `A ${input.type.replace('_', ' ')} cannot be issued for a ${s.status} sale`, { status: s.status });
    if (await this.liveDocument(s.id, input.type)) throw conflict('document_already_issued', 'A document of this type is already issued for this sale; void it first');
    const doc = await this.insert(ctx, s, input.type, input.locale ?? ctx.tenant.settings.documents.defaultLocale);
    return this.present(doc);
  }

  /** System issue (delivery note at delivery); no-op when one is already live. */
  async issueInternal(ctx: TenantContext, s: SaleRow, type: SaleDocumentType, extra: Record<string, unknown> = {}): Promise<void> {
    if (await this.liveDocument(s.id, type)) return;
    await this.insert(ctx, s, type, ctx.tenant.settings.documents.defaultLocale, extra);
  }

  async void(ctx: TenantContext, documentId: string, reason: string) {
    assertPermission(ctx, 'documents.void');
    const [doc] = await this.dbs.db.select().from(saleDocuments).where(eq(saleDocuments.id, documentId)).for('update');
    if (!doc) throw notFound('Document');
    const [s] = await this.dbs.db.select().from(sales).where(eq(sales.id, doc.saleId));
    assertBranchAccess(ctx, s!.branchId);
    if (doc.status !== 'issued') throw conflict('document_voided', 'This document is already voided');
    // Once delivered, the invoice and delivery note stand; corrections are returns (credit notes).
    if (s!.status !== 'confirmed' || doc.type === 'credit_note') {
      throw conflict('document_locked', 'This document can no longer be voided; process a return instead', { status: s!.status });
    }
    const [after] = await this.dbs.db
      .update(saleDocuments)
      .set({ status: 'voided', voidedBy: ctx.userId, voidedAt: new Date(), voidReason: reason })
      .where(eq(saleDocuments.id, documentId))
      .returning();
    await this.audit.record({ action: 'sale_document.voided', entityType: 'sale', entityId: s!.id, summary: `${doc.type} ${doc.number}`, after: { documentId, reason } });
    return this.present(after!);
  }

  /** Cancellation/return: the contract is voided and an issued invoice gets a credit note. */
  async closeOut(ctx: TenantContext, s: SaleRow, reason: string): Promise<void> {
    const invoice = await this.liveDocument(s.id, 'invoice');
    if (invoice) {
      const closed = { ...s, status: s.status === 'delivered' ? 'returned' : 'cancelled' } as SaleRow;
      await this.insert(ctx, closed, 'credit_note', ctx.tenant.settings.documents.defaultLocale, { reference: { invoiceNumber: invoice.number, reason } });
    }
    const contract = await this.liveDocument(s.id, 'contract');
    if (contract && s.status === 'confirmed') {
      await this.dbs.db.update(saleDocuments).set({ status: 'voided', voidedBy: ctx.userId, voidedAt: new Date(), voidReason: reason }).where(eq(saleDocuments.id, contract.id));
    }
  }

  private present(doc: DocRow) {
    return { id: doc.id, saleId: doc.saleId, type: doc.type, number: doc.number, issueDate: doc.issueDate, status: doc.status, issuedAt: doc.issuedAt };
  }

  async get(ctx: TenantContext, documentId: string) {
    const [doc] = await this.dbs.db.select().from(saleDocuments).where(eq(saleDocuments.id, documentId));
    if (!doc) throw notFound('Document');
    const [s] = await this.dbs.db.select({ branchId: sales.branchId, salespersonId: sales.salespersonId }).from(sales).where(eq(sales.id, doc.saleId));
    assertBranchAccess(ctx, s!.branchId);
    const ownOnly = !hasPermission(ctx, 'leads.assign') && !hasPermission(ctx, 'customers.read_all');
    if (ownOnly && s!.salespersonId !== ctx.userId) throw notFound('Document');
    return doc;
  }

  async renderPdf(ctx: TenantContext, documentId: string): Promise<{ filename: string; body: Buffer }> {
    const doc = await this.get(ctx, documentId);
    const html = renderDocumentHtml(doc.snapshot as DocSnapshot, doc.number, doc.issueDate, doc.status, this.pdf.fontCss);
    return { filename: `${doc.number}.pdf`, body: await this.pdf.render(html) };
  }
}

// ── HTML template ─────────────────────────────────────────────────────────────────────────

interface DocSnapshot {
  type: SaleDocumentType;
  locale: Locale;
  currency: string;
  company: { name: string; commercialRegistration: string | null; taxNumber: string | null; address: string | null; phone: string | null; email: string | null };
  sale: { number: string; saleDate: string; paymentType: string };
  customer: { fullName: string; phone: string | null; email: string | null; city: string | null; address: string | null; nationalIdLast4: string | null; commercialRegistration: string | null; taxNumber: string | null };
  vehicle: Record<string, string | number | null>;
  pricing: Record<string, string | null>;
  tradeIns: Array<{ agreedValue: string; vehicle: Record<string, unknown> }>;
  payments: Array<{ number: string; receivedAt: string; method: string; amountBase: string }>;
  schedule: Array<{ seq: number; dueDate: string; total: string }>;
  terms: string | null;
  footer: string | null;
  reference?: { invoiceNumber: string; reason: string };
  /** Delivery note: the odometer reading taken at handover (the vehicle snapshot is from confirmation). */
  deliveryOdometer?: { value: number; unit: string };
}

const L = {
  ar: {
    contract: 'عقد بيع سيارة',
    invoice: 'فاتورة بيع',
    delivery_note: 'محضر تسليم سيارة',
    credit_note: 'إشعار دائن',
    number: 'الرقم',
    date: 'التاريخ',
    sale: 'رقم عملية البيع',
    seller: 'البائع',
    buyer: 'المشتري',
    cr: 'السجل التجاري',
    vat: 'الرقم الضريبي',
    nid: 'رقم الهوية (آخر 4)',
    vehicle: 'بيانات السيارة',
    stock: 'رقم المخزون',
    vin: 'رقم الشاسيه',
    plate: 'رقم اللوحة',
    makeModel: 'الماركة والموديل',
    year: 'سنة الصنع',
    color: 'اللون',
    odometer: 'العداد',
    pricing: 'السعر والمبالغ',
    asking: 'سعر العرض',
    agreed: 'السعر المتفق عليه',
    discount: 'الخصم',
    net: 'الصافي قبل الضريبة',
    gross: 'الإجمالي',
    tradeIn: 'قيمة سيارة الاستبدال',
    deposit: 'العربون المحوّل',
    downPayment: 'الدفعة المقدمة',
    financed: 'المبلغ المقسط',
    payments: 'المدفوعات المستلمة',
    receipt: 'سند القبض',
    method: 'الطريقة',
    amount: 'المبلغ',
    schedule: 'جدول الأقساط',
    seq: 'القسط',
    due: 'تاريخ الاستحقاق',
    terms: 'الشروط والأحكام',
    signSeller: 'توقيع البائع',
    signBuyer: 'توقيع المشتري',
    received: 'استلمت السيارة الموضحة أعلاه بحالة جيدة.',
    reference: 'مرجع الفاتورة',
    reason: 'السبب',
    voided: 'ملغى',
    disclaimer: 'مستند صادر من نظام أوتوهب برو. ليس فاتورة إلكترونية معتمدة لدى هيئة الزكاة والضريبة والجمارك أو هيئة الضرائب أو مصلحة الضرائب.',
    paymentType: { cash: 'نقدًا', installments: 'بالتقسيط', external_finance: 'تمويل خارجي' } as Record<string, string>,
    methods: { cash: 'نقدًا', bank_transfer: 'تحويل بنكي', card: 'بطاقة', cheque: 'شيك', finance_company: 'شركة تمويل', other: 'أخرى' } as Record<string, string>,
  },
  en: {
    contract: 'Vehicle sale contract',
    invoice: 'Sales invoice',
    delivery_note: 'Vehicle delivery note',
    credit_note: 'Credit note',
    number: 'Number',
    date: 'Date',
    sale: 'Sale',
    seller: 'Seller',
    buyer: 'Buyer',
    cr: 'C.R.',
    vat: 'Tax no.',
    nid: 'ID (last 4)',
    vehicle: 'Vehicle',
    stock: 'Stock no.',
    vin: 'VIN',
    plate: 'Plate',
    makeModel: 'Make & model',
    year: 'Year',
    color: 'Colour',
    odometer: 'Odometer',
    pricing: 'Price & amounts',
    asking: 'Asking price',
    agreed: 'Agreed price',
    discount: 'Discount',
    net: 'Net before tax',
    gross: 'Total',
    tradeIn: 'Trade-in value',
    deposit: 'Deposit transferred',
    downPayment: 'Down payment',
    financed: 'Financed amount',
    payments: 'Payments received',
    receipt: 'Receipt',
    method: 'Method',
    amount: 'Amount',
    schedule: 'Installment schedule',
    seq: 'No.',
    due: 'Due date',
    terms: 'Terms & conditions',
    signSeller: 'Seller signature',
    signBuyer: 'Buyer signature',
    received: 'I received the vehicle described above in good condition.',
    reference: 'Invoice reference',
    reason: 'Reason',
    voided: 'VOID',
    disclaimer: 'Issued by AutoHub Pro. Not a certified e-invoice under ZATCA, FTA or ETA rules.',
    paymentType: { cash: 'Cash', installments: 'Installments', external_finance: 'External finance' } as Record<string, string>,
    methods: { cash: 'Cash', bank_transfer: 'Bank transfer', card: 'Card', cheque: 'Cheque', finance_company: 'Finance company', other: 'Other' } as Record<string, string>,
  },
};

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function fmt(amount: string | null | undefined, currency: string, locale: Locale): string {
  if (amount === null || amount === undefined) return '—';
  const [i, f = '00'] = amount.replace('-', '').split('.');
  const grouped = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount.startsWith('-') ? '-' : ''}${grouped}.${f.padEnd(2, '0')} ${locale === 'ar' ? { SAR: 'ر.س', EGP: 'ج.م', AED: 'د.إ' }[currency] ?? currency : currency}`;
}

export function renderDocumentHtml(s: DocSnapshot, number: string, issueDate: string, status: string, fontCss: string): string {
  const l = L[s.locale];
  const m = (v: string | null | undefined) => `<span dir="ltr" class="num">${esc(fmt(v, s.currency, s.locale))}</span>`;
  const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  const v = s.vehicle;
  const p = s.pricing;
  const showMoney = s.type !== 'delivery_note';
  const parts: string[] = [];
  parts.push(`<header><div><h1>${esc(s.company.name)}</h1><p>${[s.company.commercialRegistration && `${l.cr}: ${esc(s.company.commercialRegistration)}`, s.company.taxNumber && `${l.vat}: ${esc(s.company.taxNumber)}`, esc(s.company.address), esc(s.company.phone), esc(s.company.email)].filter(Boolean).join(' · ')}</p></div>
    <div class="title"><h2>${esc(l[s.type])}</h2><table class="meta">${row(l.number, `<span dir="ltr">${esc(number)}</span>`)}${row(l.date, `<span dir="ltr">${esc(issueDate)}</span>`)}${row(l.sale, `<span dir="ltr">${esc(s.sale.number)}</span>`)}</table></div></header>`);
  if (status === 'voided') parts.push(`<div class="void">${esc(l.voided)}</div>`);
  if (s.reference) parts.push(`<p class="ref">${esc(l.reference)}: <span dir="ltr">${esc(s.reference.invoiceNumber)}</span> — ${esc(l.reason)}: ${esc(s.reference.reason)}</p>`);
  const c = s.customer;
  parts.push(`<section class="grid"><div><h3>${esc(l.seller)}</h3><p>${esc(s.company.name)}</p></div><div><h3>${esc(l.buyer)}</h3><p>${esc(c.fullName)}<br>${[c.phone && `<span dir="ltr">+${esc(c.phone)}</span>`, c.nationalIdLast4 && `${l.nid}: ${esc(c.nationalIdLast4)}`, c.taxNumber && `${l.vat}: ${esc(c.taxNumber)}`, c.commercialRegistration && `${l.cr}: ${esc(c.commercialRegistration)}`, esc([c.address, c.city].filter(Boolean).join(', '))].filter(Boolean).join('<br>')}</p></div></section>`);
  const makeModel = s.locale === 'ar' ? `${v.makeAr ?? ''} ${v.modelAr ?? ''}` : `${v.makeEn ?? ''} ${v.modelEn ?? ''}`;
  parts.push(`<h3>${esc(l.vehicle)}</h3><table class="kv">${row(l.makeModel, `${esc(makeModel)} ${esc(v.trim ?? '')}`)}${row(l.year, esc(v.modelYear))}${row(l.vin, `<span dir="ltr">${esc(v.vin ?? '—')}</span>`)}${row(l.stock, `<span dir="ltr">${esc(v.stockNumber)}</span>`)}${row(l.plate, esc(v.plateNumber ?? '—'))}${row(l.color, esc(v.exteriorColor ?? '—'))}${row(l.odometer, `<span dir="ltr">${esc(s.deliveryOdometer?.value ?? v.odometerValue)} ${esc(s.deliveryOdometer?.unit ?? v.odometerUnit)}</span>`)}</table>`);
  if (showMoney) {
    const rows = [
      p.askingPrice && p.discountAmount !== '0.00' ? row(l.asking, m(p.askingPrice)) : '',
      row(l.agreed, m(p.agreedPrice)),
      p.discountAmount && p.discountAmount !== '0.00' ? row(l.discount, m(p.discountAmount)) : '',
      row(l.net, m(p.netAmount)),
      row(`${p.taxLabel ?? ''} (${Number(p.taxRatePct ?? 0)}%)${p.taxMode === 'margin' ? ' — margin' : ''}`, m(p.taxAmount)),
      `<tr class="total"><th>${esc(l.gross)}</th><td>${m(p.grossAmount)}</td></tr>`,
      p.tradeInCredit && p.tradeInCredit !== '0.00' ? row(l.tradeIn, m(p.tradeInCredit)) : '',
      p.depositTransferred && p.depositTransferred !== '0.00' ? row(l.deposit, m(p.depositTransferred)) : '',
      p.downPayment ? row(l.downPayment, m(p.downPayment)) : '',
      p.financedAmount ? row(l.financed, m(p.financedAmount)) : '',
    ];
    parts.push(`<h3>${esc(l.pricing)} — ${esc(l.paymentType[s.sale.paymentType] ?? s.sale.paymentType)}</h3><table class="kv">${rows.join('')}</table>`);
    if (s.payments.length && s.type !== 'credit_note') {
      parts.push(`<h3>${esc(l.payments)}</h3><table class="list"><tr><th>${esc(l.receipt)}</th><th>${esc(l.date)}</th><th>${esc(l.method)}</th><th>${esc(l.amount)}</th></tr>${s.payments.map((x) => `<tr><td dir="ltr">${esc(x.number)}</td><td dir="ltr">${esc(x.receivedAt)}</td><td>${esc(l.methods[x.method] ?? x.method)}</td><td>${m(x.amountBase)}</td></tr>`).join('')}</table>`);
    }
    if (s.schedule.length) {
      parts.push(`<h3>${esc(l.schedule)}</h3><table class="list"><tr><th>${esc(l.seq)}</th><th>${esc(l.due)}</th><th>${esc(l.amount)}</th></tr>${s.schedule.map((x) => `<tr><td>${x.seq}</td><td dir="ltr">${esc(x.dueDate)}</td><td>${m(x.total)}</td></tr>`).join('')}</table>`);
    }
  }
  if (s.terms) parts.push(`<h3>${esc(l.terms)}</h3><p class="terms">${esc(s.terms).replace(/\n/g, '<br>')}</p>`);
  if (s.type === 'delivery_note') parts.push(`<p class="terms">${esc(l.received)}</p>`);
  if (s.type === 'contract' || s.type === 'delivery_note') {
    parts.push(`<section class="sign"><div>${esc(l.signSeller)}</div><div>${esc(l.signBuyer)}</div></section>`);
  }
  parts.push(`<footer>${s.footer ? `<p>${esc(s.footer)}</p>` : ''}<p class="disc">${esc(l.disclaimer)}</p></footer>`);
  return `<!doctype html><html lang="${s.locale}" dir="${s.locale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${fontCss}
    *{box-sizing:border-box} body{font-family:'Plex','DejaVu Sans',sans-serif;color:#111827;font-size:11.5px;line-height:1.55;margin:0}
    header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #111827;padding-bottom:10px;margin-bottom:14px}
    h1{font-size:18px;margin:0 0 4px} h2{font-size:17px;margin:0 0 6px} h3{font-size:12.5px;margin:16px 0 6px;color:#374151}
    header p{margin:0;color:#4b5563;max-width:320px} .title{text-align:end}
    table{width:100%;border-collapse:collapse} .meta{width:auto;margin-inline-start:auto} .meta th,.meta td{padding:1px 6px;text-align:start}
    .kv th{width:38%;text-align:start;font-weight:500;color:#4b5563;padding:5px 8px;border-bottom:1px solid #e5e7eb}
    .kv td{padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:end}
    .kv tr.total th,.kv tr.total td{font-weight:700;font-size:13px;border-top:2px solid #111827}
    .list th{background:#f3f4f6;text-align:start;padding:5px 8px;font-weight:600} .list td{padding:5px 8px;border-bottom:1px solid #e5e7eb}
    .grid{display:flex;gap:24px} .grid>div{flex:1;border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px} .grid p{margin:0}
    .num{font-variant-numeric:tabular-nums;white-space:nowrap}
    .terms{white-space:normal;color:#374151}
    .sign{display:flex;gap:48px;margin-top:48px} .sign div{flex:1;border-top:1px solid #9ca3af;padding-top:6px;text-align:center;color:#4b5563}
    .void{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:96px;color:rgba(220,38,38,.18);transform:rotate(-20deg);font-weight:700}
    .ref{background:#fef3c7;padding:6px 10px;border-radius:6px}
    footer{margin-top:28px;border-top:1px solid #e5e7eb;padding-top:8px;color:#6b7280;font-size:10px} .disc{font-style:italic}
  </style></head><body>${parts.join('\n')}</body></html>`;
}
