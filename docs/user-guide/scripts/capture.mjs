// Captures the guide's screenshots from the running sandbox (Arabic UI, light theme) and records the
// positions of numbered callouts. Output: docs/user-guide/images/<id>.jpg + images/shots.json.
//
//   node docs/user-guide/scripts/capture.mjs            # all shots
//   node docs/user-guide/scripts/capture.mjs veh- sale- # only ids starting with these prefixes
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { launch, contextFor, settle } from './lib-browser.mjs';
import { SHOTS } from './shots.mjs';

const OUT = new URL('../images/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const META_FILE = `${OUT}shots.json`;
const META = existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, 'utf8')) : {};
const S = JSON.parse(readFileSync(new URL('./.seed-state.json', import.meta.url), 'utf8'));
const filters = process.argv.slice(2);

const browser = await launch();
const contexts = new Map();
async function ctxFor(user, opts) {
  const key = `${user}|${JSON.stringify(opts)}`;
  if (!contexts.has(key)) contexts.set(key, await contextFor(browser, user, opts));
  return contexts.get(key);
}

/** JSON GET through the signed-in context (to look up ids). */
const api = (page) => async (path, params) => {
  const url = new URL(`/api/v1${path}`, 'http://x');
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const r = await page.request.get(url.pathname + url.search);
  if (!r.ok()) throw new Error(`GET ${path} ${r.status()}`);
  const j = await r.json();
  return j;
};

let failed = 0;
for (const shot of SHOTS) {
  if (filters.length && !filters.some((f) => shot.id.startsWith(f))) continue;
  const w = shot.w ?? 1440;
  const h = shot.h ?? 900;
  const mobile = !!shot.mobile;
  const ctx = await ctxFor(shot.as === undefined ? 'owner@demo.test' : shot.as, { width: w, height: h, mobile });
  const page = await ctx.newPage();
  try {
    const helpers = { S, api: api(page), page };
    const path = typeof shot.path === 'function' ? await shot.path(helpers) : shot.path;
    await page.goto(path);
    await settle(page);
    if (shot.prep) {
      await shot.prep(page, helpers);
      await settle(page, 500);
    }
    // Grow the viewport to the content when asked (tall pages), so nothing is cut.
    if (shot.grow) {
      const ch = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: w, height: Math.min(Math.max(ch, h), shot.maxH ?? 2400) });
      await settle(page, 600);
    }
    let clip;
    const target = shot.target ?? (mobile ? 'page' : 'content');
    if (target === 'dialog') {
      clip = await page.locator('dialog[open]').last().boundingBox();
      clip = pad(clip, 0);
    } else if (target === 'content') {
      const vp = page.viewportSize();
      clip = { x: 0, y: 0, width: vp.width - 264, height: vp.height }; // RTL: sidebar on the right
    } else if (target === 'page') {
      const vp = page.viewportSize();
      clip = { x: 0, y: 0, width: vp.width, height: vp.height };
    } else if (typeof target === 'function') {
      clip = pad(await target(page).boundingBox(), shot.pad ?? 12);
    }
    if (!clip) throw new Error('no clip target');
    if (shot.cropH) clip.height = Math.min(clip.height, shot.cropH);
    if (shot.from) { const fb = await shot.from(page).boundingBox(); if (fb) { const y0 = Math.max(0, fb.y - 14); clip.height -= y0 - clip.y; clip.y = y0; } }
    if (shot.clipX) { clip.x = shot.clipX[0]; clip.width = shot.clipX[1] - shot.clipX[0]; }
    if (shot.clipY) { clip.y = shot.clipY[0]; clip.height = shot.clipY[1] - shot.clipY[0]; }
    const boxes = [];
    for (const [i, c] of (shot.callouts ?? []).entries()) {
      const loc = typeof c === 'function' ? c(page) : c.loc(page);
      const b = await loc.first().boundingBox().catch(() => null);
      if (!b) {
        console.log(`  ! ${shot.id}: callout ${i + 1} not found`);
        continue;
      }
      boxes.push({ n: i + 1, x: b.x - clip.x, y: b.y - clip.y, w: b.width, h: b.height });
    }
    const file = `${OUT}${shot.id}.jpg`;
    await page.screenshot({ path: file, type: 'jpeg', quality: 80, clip, scale: 'device' });
    const dpr = mobile ? 2 : 1;
    META[shot.id] = { w: Math.round(clip.width * dpr), h: Math.round(clip.height * dpr), cw: clip.width, ch: clip.height, boxes };
    console.log(`✓ ${shot.id} ${Math.round(clip.width)}x${Math.round(clip.height)} callouts:${boxes.length}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${shot.id}: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: `${OUT}../scripts/.capture-error-${shot.id}.png` }).catch(() => {});
  } finally {
    await page.close();
  }
  writeFileSync(META_FILE, JSON.stringify(META, null, 1));
}
await browser.close();
console.log(failed ? `${failed} shot(s) failed` : 'all shots captured');

function pad(b, p) {
  if (!b) return null;
  return { x: Math.max(0, b.x - p), y: Math.max(0, b.y - p), width: b.width + 2 * p, height: b.height + 2 * p };
}
