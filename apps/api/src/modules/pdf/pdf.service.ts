import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';
import { getEnv } from '../../config/env';
import { AppError } from '../../common/errors';

/** Fonts embedded in every PDF (Arabic + Latin), so output never depends on server fonts. */
function fontFaces(): string {
  const dir = join(require.resolve('@fontsource/ibm-plex-sans-arabic/package.json'), '..', 'files');
  const face = (subset: string, weight: number, range: string) => {
    const data = readFileSync(join(dir, `ibm-plex-sans-arabic-${subset}-${weight}-normal.woff2`)).toString('base64');
    return `@font-face{font-family:'Plex';font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${range};}`;
  };
  const arabic = 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC';
  const latin = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
  return [face('arabic', 400, arabic), face('arabic', 700, arabic), face('latin', 400, latin), face('latin', 700, latin)].join('');
}

/**
 * Renders HTML to PDF with headless Chromium (CHROMIUM_PATH). One browser is started lazily and
 * reused; each document gets its own page. Rendering failures surface as 503 pdf_unavailable.
 */
@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfService.name);
  private browser: Promise<Browser> | null = null;
  private fonts: string | null = null;

  get fontCss(): string {
    this.fonts ??= fontFaces();
    return this.fonts;
  }

  private launch(): Promise<Browser> {
    const executablePath = getEnv().CHROMIUM_PATH;
    if (!executablePath) throw new AppError('pdf_unavailable', 503, 'PDF rendering is not configured (CHROMIUM_PATH)');
    this.browser ??= chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] }).catch((e: Error) => {
      this.browser = null;
      throw e;
    });
    return this.browser;
  }

  async render(html: string, opts: { landscape?: boolean } = {}): Promise<Buffer> {
    let browser: Browser;
    try {
      browser = await this.launch();
    } catch (e) {
      this.logger.error(`chromium launch failed: ${(e as Error).message}`);
      throw new AppError('pdf_unavailable', 503, 'PDF rendering is temporarily unavailable');
    }
    const page = await browser.newPage();
    try {
      // No network: everything (fonts, styles) is inline.
      await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      await page.setContent(html, { waitUntil: 'load' });
      // Text in a web font stays invisible until the face is decoded, and printing does not wait
      // for it: load every face, then wait for the font set, before printing.
      await page.evaluate('Promise.all([...document.fonts].map((f) => f.load().catch(() => null))).then(() => document.fonts.ready).then(() => true)');
      return await page.pdf({ format: 'A4', landscape: !!opts.landscape, printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' } });
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b.catch(() => null))?.close().catch(() => undefined);
  }
}
