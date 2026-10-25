// Builds the Arabic user guide: src/*.html (content) + images/shots.json (callout positions)
// → guide.html → AutoHub-Pro-User-Guide-AR.pdf (A4, Chromium, page numbers, table of contents).
//
//   node docs/user-guide/scripts/build.mjs           # HTML + PDF
//   node docs/user-guide/scripts/build.mjs --html    # HTML only
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch } from './lib-browser.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const META = JSON.parse(readFileSync(`${ROOT}images/shots.json`, 'utf8'));
const PDF = `${ROOT}AutoHub-Pro-User-Guide-AR.pdf`;
const CONTENT_W = 1176; // px width of a full content screenshot; others scale relative to it

// ── Content assembly ───────────────────────────────────────────────────────────────────────
const srcFiles = readdirSync(`${ROOT}src`).filter((f) => f.endsWith('.html')).sort();
let body = srcFiles.map((f) => readFileSync(`${ROOT}src/${f}`, 'utf8')).join('\n');

let figNo = 0;
const missing = [];
// Shots inside <div class="two"> are sized relative to the column.
body = (() => {
  // Find each <div class="two"> and its matching </div> by depth, and mark the shots inside.
  let out = '';
  let i = 0;
  for (;;) {
    const start = body.indexOf('<div class="two">', i);
    if (start < 0) return out + body.slice(i);
    let depth = 0;
    let j = start;
    const re = /<div\b|<\/div>/g;
    re.lastIndex = start;
    let m;
    while ((m = re.exec(body))) {
      depth += m[0] === '</div>' ? -1 : 1;
      if (depth === 0) { j = m.index + 6; break; }
    }
    out += body.slice(i, start) + body.slice(start, j).replace(/<shot /g, '<shot col="1" ');
    i = j;
  }
})();
// <shot id="x" caption="..." [width="60%"] [nomarks]></shot>
body = body.replace(/<shot\s+([^>]*)><\/shot>/g, (_, attrs) => {
  const a = Object.fromEntries([...attrs.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const m = META[a.id];
  if (!m) {
    missing.push(a.id);
    return `<p class="missing">[صورة غير متوفرة: ${a.id}]</p>`;
  }
  figNo++;
  const mobile = a.id.startsWith('mobile') || a.mobile !== undefined;
  // Keep every figure within one page: at most MAX_H mm tall on a 182 mm wide text block.
  const MAX_H = Math.min(+(a.maxh ?? 165), 232);
  const byHeight = (MAX_H / ((182 * m.ch) / m.cw)) * 100;
  const base = a.width ? parseFloat(a.width) : mobile ? 46 : (m.cw / CONTENT_W) * 100;
  const k = a.col ? 2.03 : 1; // a column is ~half the text width
  const pct = `${Math.min(100, a.width ? base : base * k, byHeight * k).toFixed(1)}%`;
  const marks = a.nomarks !== undefined ? '' : m.boxes
    .map((b) => {
      const left = ((b.x + b.w) / m.cw) * 100;
      const top = (b.y / m.ch) * 100;
      const box = `<span class="hl" style="left:${(b.x / m.cw) * 100}%;top:${top}%;width:${(b.w / m.cw) * 100}%;height:${(b.h / m.ch) * 100}%"></span>`;
      return `${box}<span class="mk" style="left:${Math.min(98.5, Math.max(1.5, left))}%;top:${Math.min(98, Math.max(2, top))}%">${b.n}</span>`;
    })
    .join('');
  return `<figure class="shot${mobile ? ' mobile' : ''}" id="fig-${a.id}"><div class="frame" style="width:${pct}"><img src="images/${a.id}.jpg" alt="${a.caption ?? ''}">${marks}</div><figcaption>شكل ${figNo}: ${a.caption ?? ''}</figcaption></figure>`;
});
if (missing.length) console.warn('missing shots:', missing.join(', '));

// Headings get ids + invisible page markers (found again in the PDF text to number the TOC).
const toc = [];
let hNo = 0;
body = body.replace(/<h([12])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (_, lvl, attrs = '', inner) => {
  hNo++;
  const id = `h${hNo}`;
  const text = inner.replace(/<small>[\s\S]*?<\/small>/g, '').replace(/<[^>]+>/g, '').trim();
  toc.push({ id, lvl: +lvl, text });
  return `<h${lvl}${attrs} id="${id}"><span class="pm">QQ${String(hNo).padStart(3, '0')}QQ</span>${inner}</h${lvl}>`;
});

function render(pages = {}) {
  const tocHtml = toc
    .map((t) => `<li class="l${t.lvl}"><a href="#${t.id}"><span class="t">${t.text}</span><span class="dots"></span><span class="p">${pages[t.id] ?? '00'}</span></a></li>`)
    .join('');
  const tpl = readFileSync(`${ROOT}scripts/template.html`, 'utf8');
  return tpl.replace('{{TOC}}', tocHtml).replace('{{BODY}}', body).replace('{{FIGS}}', String(figNo));
}

writeFileSync(`${ROOT}guide.html`, render());
console.log(`guide.html: ${figNo} figures, ${toc.length} headings`);
if (process.argv.includes('--html')) process.exit(0);

// ── PDF ────────────────────────────────────────────────────────────────────────────────────
const fontData = (w) => readFileSync(`${ROOT}assets/fonts/ibm-plex-sans-arabic-arabic-${w}-normal.woff2`).toString('base64');
const latinData = (w) => readFileSync(`${ROOT}assets/fonts/ibm-plex-sans-arabic-latin-${w}-normal.woff2`).toString('base64');
const hfFont = `<style>@font-face{font-family:P;src:url(data:font/woff2;base64,${fontData(400)})}@font-face{font-family:P;src:url(data:font/woff2;base64,${latinData(400)});unicode-range:U+0000-00FF}</style>`;
const header = `<div dir="rtl" style="font-family:'DejaVu Sans',sans-serif;font-size:7pt;color:#8a8f98;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span>دليل المستخدم — أوتوهب برو</span><span>نظام إدارة معارض السيارات</span></div>`;
const footer = `<div dir="rtl" style="font-family:'DejaVu Sans',sans-serif;font-size:7.5pt;color:#6b7280;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span>صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span><span>بيانات الأمثلة في الصور تجريبية وغير حقيقية</span></div>`;

const browser = await launch();
async function pdf(htmlFile, out, withHF) {
  const page = await browser.newPage();
  await page.goto(`file://${htmlFile}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: out, format: 'A4', printBackground: true, preferCSSPageSize: false,
    margin: withHF ? { top: '17mm', bottom: '17mm', left: '14mm', right: '14mm' } : { top: '0', bottom: '0', left: '0', right: '0' },
    displayHeaderFooter: withHF, headerTemplate: withHF ? header : '<span></span>', footerTemplate: withHF ? footer : '<span></span>',
  });
  await page.close();
}

// Cover (no header/footer) + body. Pass 1 finds heading pages; pass 2 writes them into the TOC.
const coverHtml = readFileSync(`${ROOT}scripts/cover.html`, 'utf8');
writeFileSync(`${ROOT}scripts/.cover.html`, coverHtml.replace(/assets\//g, '../assets/').replace(/images\//g, '../images/'));
await pdf(`${ROOT}scripts/.cover.html`, `${ROOT}scripts/.cover.pdf`, false);
await pdf(`${ROOT}guide.html`, `${ROOT}scripts/.body.pdf`, true);
const pages = {};
const nPages = +execFileSync('pdfinfo', [`${ROOT}scripts/.body.pdf`]).toString().match(/Pages:\s+(\d+)/)[1];
for (let p = 1; p <= nPages; p++) {
  const t = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), '-layout', `${ROOT}scripts/.body.pdf`, '-']).toString();
  for (const m of t.matchAll(/QQ(\d{3})QQ/g)) pages[`h${+m[1]}`] ??= p;
}
writeFileSync(`${ROOT}guide.html`, render(pages));
await pdf(`${ROOT}guide.html`, `${ROOT}scripts/.body.pdf`, true);
await browser.close();
execFileSync('pdfunite', [`${ROOT}scripts/.cover.pdf`, `${ROOT}scripts/.body.pdf`, PDF]);
for (const f of ['.cover.pdf', '.body.pdf', '.cover.html']) if (existsSync(`${ROOT}scripts/${f}`)) unlinkSync(`${ROOT}scripts/${f}`);
const info = execFileSync('pdfinfo', [PDF]).toString();
console.log(`PDF: ${PDF}\n${info.match(/Pages:.*/)[0]}  ${(readFileSync(PDF).length / 1048576).toFixed(1)} MB  (headings without page: ${toc.filter((t) => !pages[t.id]).length})`);
