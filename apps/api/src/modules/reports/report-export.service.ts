import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { ExportFormat, ReportCell, ReportColumn, ReportResult } from '@autohub/shared';
import { PdfService } from '../pdf/pdf.service';

type Locale = 'ar' | 'en';

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Text a spreadsheet would evaluate as a formula is prefixed with an apostrophe (CSV/formula injection). */
export function neutraliseFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

const PARAM_LABELS: Record<string, { en: string; ar: string }> = {
  from: { en: 'From', ar: 'من' },
  to: { en: 'To', ar: 'إلى' },
  asOf: { en: 'As of', ar: 'حتى تاريخ' },
  groupBy: { en: 'Grouped by', ar: 'مجمّع حسب' },
  status: { en: 'Status', ar: 'الحالة' },
  bucket: { en: 'Age', ar: 'العمر' },
  source: { en: 'Source', ar: 'المصدر' },
  paymentType: { en: 'Payment', ar: 'طريقة الدفع' },
};

/** Money with thousands separators for printed output (the value itself is not changed). */
export function groupDigits(v: string): string {
  const neg = v.startsWith('-');
  const [i, f] = (neg ? v.slice(1) : v).split('.');
  return `${neg ? '-' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f !== undefined ? `.${f}` : ''}`;
}

function label(c: { labelEn: string; labelAr: string }, locale: Locale) {
  return locale === 'ar' ? c.labelAr : c.labelEn;
}

/** A cell as display text (enum codes translated); money stays an exact decimal string. */
function text(c: ReportColumn, v: ReportCell, locale: Locale): string {
  if (v === null || v === undefined) return '';
  if (c.type === 'enum') {
    const o = c.options?.[String(v)];
    return o ? (locale === 'ar' ? o.ar : o.en) : String(v);
  }
  if (c.type === 'percent') return `${v}%`;
  return String(v);
}

/**
 * Renders a finished report (already filtered by the column policy) as CSV, XLSX or PDF. The
 * exports carry exactly the columns the user saw on screen.
 */
@Injectable()
export class ReportExportService {
  constructor(private readonly pdf: PdfService) {}

  async render(r: ReportResult, format: ExportFormat, locale: Locale, company: string, currency: string): Promise<{ body: Buffer; contentType: string; ext: string }> {
    if (format === 'csv') return { body: this.csv(r, locale), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
    if (format === 'xlsx') return { body: await this.xlsx(r, locale, company), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    return { body: await this.pdf.render(this.html(r, locale, company, currency), { landscape: r.columns.length > 7 }), contentType: 'application/pdf', ext: 'pdf' };
  }

  private csv(r: ReportResult, locale: Locale): Buffer {
    const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    // Numbers and money are written as plain values (a negative amount is not a formula);
    // free text is neutralised so a spreadsheet never evaluates it.
    const cell = (c: ReportColumn, v: ReportCell) => {
      const t = text(c, v, locale);
      return quote(c.type === 'money' || c.type === 'number' || c.type === 'percent' ? t : neutraliseFormula(t));
    };
    const lines = [r.columns.map((c) => quote(neutraliseFormula(label(c, locale)))).join(',')];
    for (const row of r.rows) lines.push(r.columns.map((c) => cell(c, row[c.key] ?? null)).join(','));
    if (r.totals) lines.push(r.columns.map((c, i) => (i === 0 ? quote(locale === 'ar' ? 'الإجمالي' : 'Total') : cell(c, r.totals![c.key] ?? null))).join(','));
    // BOM so spreadsheet programs read the Arabic text as UTF-8.
    return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  }

  private async xlsx(r: ReportResult, locale: Locale, company: string): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'AutoHub Pro';
    wb.created = new Date(r.generatedAt);
    const ws = wb.addWorksheet((locale === 'ar' ? r.titleAr : r.titleEn).slice(0, 31), { views: [{ rightToLeft: locale === 'ar', state: 'frozen', ySplit: 4 }] });
    ws.addRow([company]).font = { bold: true, size: 13 };
    ws.addRow([`${label({ labelEn: r.titleEn, labelAr: r.titleAr }, locale)} — ${Object.entries(r.params).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ')}`]);
    ws.addRow([]);
    const header = ws.addRow(r.columns.map((c) => label(c, locale)));
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    });
    // Excel cells are binary floating point: money is exact to the cent up to ±90 trillion, far
    // beyond any dealership figure. The source of truth stays the decimal in the database.
    const value = (c: ReportColumn, v: ReportCell): string | number | null => {
      if (v === null || v === undefined) return null;
      if (c.type === 'money' || c.type === 'number') return Number(v);
      if (c.type === 'percent') return Number(v) / 100;
      // A string cell is stored as text and never evaluated as a formula.
      return text(c, v, locale);
    };
    for (const row of r.rows) ws.addRow(r.columns.map((c) => value(c, row[c.key] ?? null)));
    if (r.totals) {
      const t = ws.addRow(r.columns.map((c, i) => (i === 0 ? (locale === 'ar' ? 'الإجمالي' : 'Total') : value(c, r.totals![c.key] ?? null))));
      t.font = { bold: true };
    }
    r.columns.forEach((c, i) => {
      const column = ws.getColumn(i + 1);
      column.width = Math.min(40, Math.max(12, label(c, locale).length + 4));
      if (c.type === 'money') column.numFmt = '#,##0.00';
      if (c.type === 'percent') column.numFmt = '0.00%';
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private html(r: ReportResult, locale: Locale, company: string, currency: string): string {
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    const numeric = (c: { type: string }) => ['money', 'number', 'percent'].includes(c.type);
    const show = (c: { type: string; options?: ReportColumn['options'] }, v: ReportCell) =>
      v === null || v === undefined ? '' : c.type === 'money' ? groupDigits(String(v)) : text(c as ReportColumn, v, locale);
    const td = (c: ReportColumn, v: ReportCell) => `<td class="${numeric(c) ? 'num' : ''}"${numeric(c) || c.type === 'date' ? ' dir="ltr"' : ''}>${esc(show(c, v))}</td>`;
    // Wide reports get a smaller type so every column fits on a landscape page.
    const fontPt = r.columns.length > 14 ? 6.5 : r.columns.length > 9 ? 7.5 : 9;
    const summary = r.summary.length
      ? `<div class="summary">${r.summary.map((s) => `<div><span>${esc(label(s, locale))}</span><b dir="ltr">${esc(s.value === null ? '—' : show(s, s.value))}</b></div>`).join('')}</div>`
      : '';
    const recon = r.reconciliation?.length
      ? `<table class="recon"><tr><th></th><th>${locale === 'ar' ? 'التقرير' : 'Report'}</th><th>${locale === 'ar' ? 'دفتر الأستاذ' : 'Ledger'}</th><th>${locale === 'ar' ? 'الفرق' : 'Difference'}</th></tr>${r.reconciliation
          .map((x) => `<tr><td>${esc(label(x, locale))}</td><td class="num" dir="ltr">${esc(groupDigits(x.report))}</td><td class="num" dir="ltr">${esc(groupDigits(x.ledger))}</td><td class="num" dir="ltr">${esc(groupDigits(x.difference))}</td></tr>`)
          .join('')}</table>`
      : '';
    // Dates and coded filters are printed; id filters (branch, account, salesperson) are noted only.
    const params = [
      ...Object.entries(r.params)
        .filter(([k, v]) => v && PARAM_LABELS[k])
        .map(([k, v]) => `<span>${esc(locale === 'ar' ? PARAM_LABELS[k]!.ar : PARAM_LABELS[k]!.en)}: <bdi dir="ltr">${esc(v)}</bdi></span>`),
      ...(Object.entries(r.params).some(([k, v]) => v && k.endsWith('Id')) ? [`<span>${locale === 'ar' ? 'مع عوامل تصفية إضافية' : 'Additional filters applied'}</span>`] : []),
      `<span>${locale === 'ar' ? 'المبالغ بـ' : 'Amounts in'} <bdi dir="ltr">${esc(currency)}</bdi></span>`,
    ].join(' · ');
    return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><style>${this.pdf.fontCss}
      *{box-sizing:border-box} body{font-family:'Plex',sans-serif;font-size:${fontPt}pt;color:#0f172a;margin:0}
      h1{font-size:14pt;margin:0} h2{font-size:11pt;margin:2px 0 6px;color:#334155} .meta{color:#64748b;font-size:8pt;margin-bottom:8px}
      table{width:100%;border-collapse:collapse} th,td{padding:${fontPt < 8 ? '3px 3px' : '4px 5px'};border-bottom:1px solid #e2e8f0;text-align:start;vertical-align:top}
      th{background:#f1f5f9;font-weight:700} .num{text-align:end;white-space:nowrap} tr.total td{font-weight:700;border-top:2px solid #0f172a}
      thead{display:table-header-group} tr{page-break-inside:avoid}
      .summary{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;font-size:8pt} .summary div{border:1px solid #e2e8f0;border-radius:6px;padding:4px 8px}
      .summary span{color:#64748b;margin-inline-end:6px} .recon{margin-top:10px;width:auto} .note{color:#64748b;font-size:7.5pt;margin-top:8px}
    </style></head><body>
      <h1>${esc(company)}</h1><h2>${esc(label({ labelEn: r.titleEn, labelAr: r.titleAr }, locale))}</h2>
      <div class="meta">${params}</div>${summary}
      <table><thead><tr>${r.columns.map((c) => `<th${numeric(c) ? ' class="num"' : ''}>${esc(label(c, locale))}</th>`).join('')}</tr></thead><tbody>
      ${r.rows.map((row) => `<tr>${r.columns.map((c) => td(c, row[c.key] ?? null)).join('')}</tr>`).join('')}
      ${r.totals ? `<tr class="total">${r.columns.map((c, i) => (i === 0 ? `<td>${locale === 'ar' ? 'الإجمالي' : 'Total'}</td>` : td(c, r.totals![c.key] ?? null))).join('')}</tr>` : ''}
      </tbody></table>${recon}
      ${r.truncated ? `<p class="note">${locale === 'ar' ? 'تم اقتطاع النتائج؛ ضيّق عوامل التصفية.' : 'Results were truncated; narrow the filters.'}</p>` : ''}
      <p class="note">AutoHub Pro · ${esc(r.generatedAt)}</p></body></html>`;
  }
}
