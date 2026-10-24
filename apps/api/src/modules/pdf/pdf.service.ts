import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Browser, Page } from 'playwright-core';
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
 * Bounds concurrent work: up to `limit` tasks run, up to `queue` more wait in order, and anything
 * beyond is refused at once (the caller answers 503 rather than piling requests onto the process).
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: () => number,
    private readonly queue: () => number,
  ) {}

  /** Runs `fn` when a slot is free; returns null (without running it) when the gate is saturated. */
  async run<T>(fn: () => Promise<T>): Promise<{ value: T } | null> {
    if (this.active >= this.limit()) {
      if (this.waiting.length >= this.queue()) return null;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return { value: await fn() };
    } finally {
      // Hand the slot straight to the next waiter (active stays the same) or release it.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/**
 * Renders HTML to PDF with headless Chromium (CHROMIUM_PATH). One browser is started lazily and
 * reused; each document gets its own page. Rendering failures surface as 503 pdf_unavailable.
 * Renders share one process-wide ConcurrencyGate (reports and sale documents alike); when it is full
 * the request gets 503 `pdf_busy` instead of another Chromium page.
 *
 * Crash recovery: when Chromium exits (crash, out-of-memory kill, closed) the cached browser is
 * dropped on its 'disconnected' event, so the next render starts a new one. If a render still finds
 * a dead browser (the event not seen yet), it drops it and relaunches once before giving up.
 */
@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfService.name);
  private browser: Promise<Browser> | null = null;
  private fonts: string | null = null;
  readonly gate = new ConcurrencyGate(
    () => getEnv().PDF_MAX_CONCURRENT,
    () => getEnv().PDF_MAX_QUEUE,
  );

  get fontCss(): string {
    this.fonts ??= fontFaces();
    return this.fonts;
  }

  private launch(): Promise<Browser> {
    const executablePath = getEnv().CHROMIUM_PATH;
    if (!executablePath) throw new AppError('pdf_unavailable', 503, 'PDF rendering is not configured (CHROMIUM_PATH)');
    if (this.browser) return this.browser;
    const launching: Promise<Browser> = chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] }).then(
      (browser) => {
        browser.on('disconnected', () => {
          if (this.browser === launching) {
            this.logger.warn('chromium disconnected; the next render starts a new browser');
            this.browser = null;
          }
        });
        return browser;
      },
      (e: Error) => {
        if (this.browser === launching) this.browser = null;
        throw e;
      },
    );
    this.browser = launching;
    return launching;
  }

  /** Forgets `launching` if it is still the cached browser, and closes it (ends a hung process). */
  private drop(launching: Promise<Browser>, browser: Browser): void {
    if (this.browser === launching) this.browser = null;
    void browser.close().catch(() => undefined);
  }

  /** A fresh page on a live browser: relaunches once when the cached browser turns out to be dead. */
  private async newPage(): Promise<{ browser: Browser; page: Page }> {
    for (let attempt = 1; ; attempt++) {
      let launching: Promise<Browser>;
      let browser: Browser;
      try {
        launching = this.launch();
        browser = await launching;
      } catch (e) {
        if (e instanceof AppError) throw e;
        this.logger.error(`chromium launch failed: ${(e as Error).message}`);
        throw new AppError('pdf_unavailable', 503, 'PDF rendering is temporarily unavailable');
      }
      try {
        return { browser, page: await browser.newPage() };
      } catch (e) {
        const dead = !browser.isConnected() || /closed|disconnected|crash/i.test((e as Error).message);
        if (dead) this.drop(launching, browser);
        if (dead && attempt === 1) {
          this.logger.warn(`chromium was gone (${(e as Error).message}); relaunching`);
          continue;
        }
        this.logger.error(`chromium page failed: ${(e as Error).message}`);
        throw new AppError('pdf_unavailable', 503, 'PDF rendering is temporarily unavailable');
      }
    }
  }

  async render(html: string, opts: { landscape?: boolean } = {}): Promise<Buffer> {
    const done = await this.gate.run(() => this.renderNow(html, opts));
    if (!done) throw new AppError('pdf_busy', 503, 'PDF rendering is busy right now. Please try again in a moment.');
    return done.value;
  }

  private async renderNow(html: string, opts: { landscape?: boolean }): Promise<Buffer> {
    const { browser, page } = await this.newPage();
    try {
      // No network: everything (fonts, styles) is inline.
      await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      await page.setContent(html, { waitUntil: 'load' });
      // Text in a web font stays invisible until the face is decoded, and printing does not wait
      // for it: load every face, then wait for the font set, before printing.
      await page.evaluate('Promise.all([...document.fonts].map((f) => f.load().catch(() => null))).then(() => document.fonts.ready).then(() => true)');
      return await page.pdf({ format: 'A4', landscape: !!opts.landscape, printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' } });
    } catch (e) {
      // Chromium died during this render: the caller may retry (the next render relaunches it).
      if (!browser.isConnected()) {
        this.logger.error(`chromium exited during a render: ${(e as Error).message}`);
        throw new AppError('pdf_unavailable', 503, 'PDF rendering is temporarily unavailable');
      }
      throw e;
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
