import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PdfService } from '../src/modules/pdf/pdf.service';
import { closeApp, getApp } from './helpers';

// CHROMIUM_PATH comes from vitest.config.ts (overridable from the environment), like every PDF test.
const CHROMIUM = process.env.CHROMIUM_PATH;
const HAVE_CHROMIUM = !!CHROMIUM && existsSync(CHROMIUM);

/** The browser the service has cached (null when none is running). */
const cached = (pdf: PdfService) => (pdf as unknown as { browser: Promise<Browser> | null }).browser;

const isPdf = (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-';

/** Chromium processes started by this test process (playwright launches them as direct children). */
function chromiumChildren(): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((pid) => {
        try {
          return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).includes(CHROMIUM!);
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!HAVE_CHROMIUM)('PDF renderer: Chromium crash recovery', () => {
  let app: INestApplication;
  let pdf: PdfService;

  beforeAll(async () => {
    app = await getApp();
    pdf = app.get(PdfService);
  });
  afterAll(() => closeApp());

  it('a render after Chromium was killed starts a new browser and succeeds', async () => {
    expect(isPdf(await pdf.render('<p>first</p>'))).toBe(true);
    const first = await cached(pdf)!;
    const pids = chromiumChildren();
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    await until(() => !first.isConnected());
    // The 'disconnected' event dropped the dead browser.
    expect(cached(pdf)).toBeNull();

    expect(isPdf(await pdf.render('<p>second</p>'))).toBe(true);
    const second = await cached(pdf)!;
    expect(second).not.toBe(first);
    expect(second.isConnected()).toBe(true);
  });

  it('a render that finds a dead browser still cached (event not seen yet) relaunches once', async () => {
    expect(isPdf(await pdf.render('<p>warm</p>'))).toBe(true);
    // Swap in a browser that is already closed, as if Chromium died a moment ago.
    const dead = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    await dead.close();
    const live = await cached(pdf)!;
    (pdf as unknown as { browser: Promise<Browser> }).browser = Promise.resolve(dead);
    try {
      expect(isPdf(await pdf.render('<p>after</p>'))).toBe(true);
      const now = await cached(pdf)!;
      expect(now).not.toBe(dead);
      expect(now.isConnected()).toBe(true);
    } finally {
      await live.close().catch(() => undefined);
    }
  });

  it('a browser closed through the service (e.g. on shutdown) is relaunched on the next render', async () => {
    await pdf.onModuleDestroy();
    expect(cached(pdf)).toBeNull();
    expect(isPdf(await pdf.render('<p>again</p>'))).toBe(true);
  });

  it('launch failures answer 503 pdf_unavailable, and the next render tries again', async () => {
    await pdf.onModuleDestroy();
    const spy = vi.spyOn(chromium, 'launch').mockRejectedValueOnce(new Error('spawn ENOENT'));
    try {
      await expect(pdf.render('<p>x</p>')).rejects.toMatchObject({ code: 'pdf_unavailable', status: 503 });
      expect(cached(pdf)).toBeNull();
      expect(isPdf(await pdf.render('<p>y</p>'))).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('the render gate still answers 503 pdf_busy when saturated', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => pdf.render(`<p>${i}</p>`)));
    const busy = results.filter((r) => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    for (const b of busy) expect((b as PromiseRejectedResult).reason).toMatchObject({ code: 'pdf_busy', status: 503 });
  });
});
