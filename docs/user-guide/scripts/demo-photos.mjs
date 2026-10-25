// Renders simple illustrated "demo photos" of cars (clearly labelled as illustrations) with
// Chromium, so the seeded vehicles have pictures in Vehicle 360 and the public showroom.
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
const FONT_DIR = new URL('../../../apps/web/node_modules/@fontsource/ibm-plex-sans-arabic/files/', import.meta.url);
const fontFace = (w) => `@font-face{font-family:'IBM Plex Sans Arabic';font-weight:${w};src:url(data:font/woff2;base64,${readFileSync(new URL(`ibm-plex-sans-arabic-arabic-${w}-normal.woff2`, FONT_DIR)).toString('base64')}) format('woff2');unicode-range:U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF;}@font-face{font-family:'IBM Plex Sans Arabic';font-weight:${w};src:url(data:font/woff2;base64,${readFileSync(new URL(`ibm-plex-sans-arabic-latin-${w}-normal.woff2`, FONT_DIR)).toString('base64')}) format('woff2');}`;
const require = createRequire(import.meta.url);
const { chromium } = require('/home/user/Car-Dealership/e2e/node_modules/@playwright/test');
export const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const svg = (color, sky, label, variant) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="0.62" stop-color="#d5dde6"/><stop offset="0.62" stop-color="#9aa6b2"/><stop offset="1" stop-color="#6f7a86"/></linearGradient>
<linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<rect width="1200" height="800" fill="url(#bg)"/>
<g transform="${variant === 1 ? 'translate(1200,0) scale(-1,1)' : ''}">
<ellipse cx="600" cy="600" rx="430" ry="28" fill="#000" opacity=".25"/>
<path d="M190 520 Q190 455 260 445 L400 430 Q470 ${variant === 2 ? 360 : 340} 560 330 L760 330 Q840 335 900 420 L990 440 Q1030 452 1030 500 L1030 545 Q1030 565 1005 565 L215 565 Q190 565 190 545 Z" fill="${color}"/>
<path d="M190 520 Q190 455 260 445 L400 430 Q470 340 560 330 L760 330 Q840 335 900 420 L990 440 Q1030 452 1030 500 L1030 545 Q1030 565 1005 565 L215 565 Q190 565 190 545 Z" fill="url(#hl)"/>
<path d="M425 432 Q480 360 565 352 L640 352 L640 432 Z" fill="#22313f" opacity=".85"/>
<path d="M660 352 L755 352 Q820 357 868 432 L660 432 Z" fill="#22313f" opacity=".85"/>
<line x1="650" y1="440" x2="650" y2="555" stroke="#000" stroke-opacity=".25" stroke-width="3"/>
<rect x="960" y="465" width="55" height="18" rx="8" fill="#fff6c8"/><rect x="195" y="470" width="30" height="16" rx="6" fill="#d9363e"/>
<circle cx="340" cy="565" r="70" fill="#1b1b1b"/><circle cx="340" cy="565" r="38" fill="#b8c0c8"/>
<circle cx="870" cy="565" r="70" fill="#1b1b1b"/><circle cx="870" cy="565" r="38" fill="#b8c0c8"/></g>
<text x="600" y="110" font-family="IBM Plex Sans Arabic, sans-serif" font-size="46" font-weight="600" fill="#1f2937" text-anchor="middle">${label}</text>
<text x="600" y="730" font-family="IBM Plex Sans Arabic, sans-serif" font-size="30" fill="#fff" text-anchor="middle">صورة توضيحية لأغراض الدليل — Illustration</text></svg>`;

/** specs: [{ key, color, label }] → { key: [file1, file2, file3] } */
export async function renderPhotos(dir, specs) {
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const out = {};
  for (const s of specs) {
    out[s.key] = [];
    for (const [i, sky] of ['#e8eef5', '#f5efe6', '#e6f2ee'].entries()) {
      const file = `${dir}/${s.key}-${i + 1}.jpg`;
      if (!existsSync(file)) {
        await page.setContent(`<html><head><style>${fontFace(400)}${fontFace(600)}</style></head><body style="margin:0">${svg(s.color, sky, s.label, i)}</body></html>`);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: file, type: 'jpeg', quality: 80 });
      }
      out[s.key].push(file);
    }
  }
  await browser.close();
  return out;
}
