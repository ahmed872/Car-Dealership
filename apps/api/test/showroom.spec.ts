import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contentDisposition } from '../src/common/content-disposition';
import { AiTextService, templateDescription } from '../src/modules/integrations/ai-text.service';
import { MessagingService } from '../src/modules/integrations/messaging.service';
import { VinDecoderService } from '../src/modules/integrations/vin-decoder.service';
import {
  assertLedgerIntegrity,
  addMemberWithPermissions,
  createAcquisition,
  createBranch,
  createCashAccount,
  createCustomer,
  createSupplier,
  createVehicle,
  JPEG,
  makeAvailable,
  secondApprover,
  sellVehicle,
} from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ORIGIN, ownerPool, TestTenant } from './helpers';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

/** A local HTTP stub standing in for a third-party API (no real provider is ever called). */
async function stub(handler: Handler): Promise<{ url: string; server: Server; calls: Array<{ path: string; headers: IncomingMessage['headers']; body: string }> }> {
  const calls: Array<{ path: string; headers: IncomingMessage['headers']; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      calls.push({ path: req.url ?? '', headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, calls };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * Phase 7: the public digital showroom (never leaks internal data, only published listable
 * vehicles), inquiries into leads, integration settings with encrypted secrets, and adapters whose
 * failures and timeouts never break the core flow. Third-party APIs are local stubs.
 */
describe('digital showroom and integrations', () => {
  let app: INestApplication;
  let t: TestTenant;
  let pool: Pool;
  let owner: Client;
  let checker: Client;
  let supplier: { id: string };
  let cash: { id: string };
  let slug: string;
  const servers: Server[] = [];

  const pub = (path: string) => request(app.getHttpServer()).get(`/api/v1/public/showroom/${slug}${path}`).set('Origin', ORIGIN);
  const inquire = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`/api/v1/public/showroom/${slug}/inquiries`).set('Origin', ORIGIN).send({ consent: true, ...body });

  async function vehicle(price = '60000.00', asking = '95000.00', floor = '88000.00', vin?: string) {
    const acq = await createAcquisition(owner, t.branchId, supplier.id, { price, approver: checker, vehicle: vin ? { vin } : {} });
    await makeAvailable(owner, acq.vehicleId, asking, floor);
    return acq.vehicleId;
  }

  async function publish(vehicleId: string) {
    const put = await owner.put(`/vehicles/${vehicleId}/listing`, { titleEn: 'Clean Camry', titleAr: 'كامري نظيفة', descriptionEn: 'One owner, full service history.', descriptionAr: 'مالك واحد.' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const pubRes = await owner.post(`/vehicles/${vehicleId}/listing/publish`);
    expect(pubRes.status, JSON.stringify(pubRes.body)).toBe(200);
    return pubRes.body.listing.id as string;
  }

  async function showroomSettings(extra: Record<string, unknown> = {}) {
    const res = await owner.patch('/company', {
      settings: { showroom: { enabled: true, showReserved: false, showPrices: true, whatsappNumber: '+966500000001', headlineAr: 'سيارات موثوقة', headlineEn: 'Trusted cars', ...extra } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    pool = ownerPool();
    owner = t.owner;
    checker = await secondApprover(owner);
    supplier = await createSupplier(owner);
    cash = await createCashAccount(owner, { name: 'Safe', openingBalance: '10000.00' });
    slug = t.slug;
  });
  afterEach(async () => assertLedgerIntegrity(pool, t.tenantId));
  afterAll(async () => {
    for (const s of servers) s.close();
    await pool.end();
    await closeApp();
  });

  describe('public showroom', () => {
    it('shows only published, listable vehicles and only public fields', async () => {
      const vin = 'JTDBR32E720123456';
      const v1 = await vehicle('60000.00', '95000.00', '88000.00', vin);
      const v2 = await vehicle();
      const before = await owner.get(`/vehicles/${v1}/listing`);
      expect(before.body).toMatchObject({ listing: null, visibility: { public: false } });
      expect(before.body.visibility.reasons).toEqual(expect.arrayContaining(['showroom_disabled', 'not_published']));

      // Showroom switched off: the slug does not resolve at all.
      expect((await pub('')).status).toBe(404);
      await showroomSettings();
      const listingId = await publish(v1);
      const photo = await owner.upload(`/vehicles/${v1}/media`, { buffer: JPEG, name: 'front.jpg' });
      const damage = await owner.upload(`/vehicles/${v1}/media`, { buffer: JPEG, name: 'dent.jpg' }, { category: 'damage' });
      expect([photo.status, damage.status]).toEqual([201, 201]);
      expect(damage.body.isPublic).toBe(false);

      const company = await pub('');
      expect(company.status).toBe(200);
      expect(company.body).toMatchObject({ headlineEn: 'Trusted cars', currency: 'SAR', showPrices: true });

      const list = await pub('/vehicles');
      expect(list.status).toBe(200);
      expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([listingId]);
      const card = list.body.items[0];
      expect(card).toMatchObject({ titleEn: 'Clean Camry', status: 'available', price: { amount: '95000.00', currency: 'SAR' } });
      expect(card.share.url).toContain(`/showroom/${slug}/vehicles/${listingId}`);
      expect(card.share.whatsappUrl).toMatch(/^https:\/\/wa\.me\/966500000001\?text=/);
      // The chat text exists in both languages (the page picks the viewer's); the plain link uses the company's document language.
      const text = (u: string) => decodeURIComponent(new URL(u).searchParams.get('text') ?? '');
      expect(text(card.share.whatsappUrls.en)).toBe(`Clean Camry — ${card.share.url}`);
      expect(text(card.share.whatsappUrls.ar)).toBe(`كامري نظيفة — ${card.share.url}`);
      const docLocale = (await owner.get('/company')).body.settings.documents.defaultLocale as 'ar' | 'en';
      expect(card.share.whatsappUrl).toBe(card.share.whatsappUrls[docLocale]);
      const staff = (await owner.get(`/vehicles/${v1}/listing`)).body.links;
      expect(text(staff.whatsappUrls.ar)).toBe(`كامري نظيفة — ${staff.url}`);
      expect(text(staff.whatsappUrls.en)).toBe(`Clean Camry — ${staff.url}`);

      const detail = await pub(`/vehicles/${listingId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.photos).toHaveLength(1);
      // Nothing internal leaves: no VIN, floor price, cost, ids of internal records.
      const raw = JSON.stringify(detail.body) + JSON.stringify(list.body);
      for (const secret of [vin, '88000', '60000', v1, 'minPrice', 'cost', 'notes', 'plate', 'vin']) expect(raw).not.toContain(secret);

      // Public photo is served; the private damage photo is not reachable through the showroom.
      const img = await request(app.getHttpServer()).get(detail.body.photos[0].url).buffer(true);
      expect(img.status).toBe(200);
      expect(img.headers['content-type']).toBe('image/jpeg');
      expect(img.headers['cache-control']).toBe('public, max-age=300');
      expect((await pub(`/media/${damage.body.id}`)).status).toBe(404);

      // Unpublished vehicles are invisible; so is anything not in a listable status.
      expect((await pub(`/vehicles/${v2}`)).status).toBe(404);
      await owner.post(`/vehicles/${v2}/listing/publish`);
      const v2Listing = (await owner.get(`/vehicles/${v2}/listing`)).body.listing.id;
      expect((await pub(`/vehicles/${v2Listing}`)).status).toBe(200);
      const cust = (await createCustomer(owner, { fullName: 'Reserving customer' })).id;
      expect((await owner.post('/reservations', { vehicleId: v2, customerId: cust }, idem())).status).toBe(201);
      expect((await pub(`/vehicles/${v2Listing}`)).status).toBe(404);
      await showroomSettings({ showReserved: true });
      expect((await pub(`/vehicles/${v2Listing}`)).body.status).toBe('reserved');
      await showroomSettings();

      // Sold: gone from the public showroom, photo included.
      await sellVehicle(owner, { vehicleId: v1, customerId: cust, cashAccountId: cash.id, agreedPrice: '95000.00' });
      expect((await pub(`/vehicles/${listingId}`)).status).toBe(404);
      expect((await request(app.getHttpServer()).get(detail.body.photos[0].url)).status).toBe(404);
      expect((await pub('/vehicles')).body.items).toEqual([]);

      // Hidden prices: no amount anywhere and the price filter is ignored.
      const v3 = await vehicle();
      const l3 = await publish(v3);
      await showroomSettings({ showPrices: false });
      const noPrice = await pub(`/vehicles/${l3}`);
      expect(noPrice.body.price).toBeNull();
      expect(JSON.stringify(noPrice.body)).not.toContain('95000');
      expect((await pub('/vehicles?priceMax=1')).body.total).toBe(1);
      await showroomSettings();

      // Another company's slug never reaches this company's listings.
      const other = await createTenant(app, await createPlatformAdmin(app));
      expect((await request(app.getHttpServer()).get(`/api/v1/public/showroom/${other.slug}/vehicles/${l3}`)).status).toBe(404);
      expect((await request(app.getHttpServer()).get('/api/v1/public/showroom/no-such-company')).status).toBe(404);
    });

    it('publishing rules, permissions, QR codes and plan gating', async () => {
      const v = await vehicle();
      const rep = await addMember(app, t, 'sales_rep');
      expect((await rep.client.put(`/vehicles/${v}/listing`, { titleEn: 'x' })).status).toBe(403);
      expect((await rep.client.post(`/vehicles/${v}/listing/publish`)).status).toBe(403);
      expect((await rep.client.get(`/vehicles/${v}/listing`)).status).toBe(200);
      // A vehicle that is not available cannot be published.
      const incoming = (await createAcquisition(owner, t.branchId, supplier.id, { approver: checker })).vehicleId;
      const bad = await owner.post(`/vehicles/${incoming}/listing/publish`);
      expect(bad.status).toBe(409);
      expect(bad.body.error.code).toBe('vehicle_not_listable');
      await publish(v);
      const svg = await owner.get(`/vehicles/${v}/listing/qr`);
      expect(svg.status).toBe(200);
      expect(svg.headers['content-type']).toContain('image/svg+xml');
      // Downloads are named after the stock number.
      const stock = (await owner.get(`/vehicles/${v}`)).body.vehicle.stockNumber as string;
      expect(svg.headers['content-disposition']).toBe(`attachment; filename="listing-${stock}-qr.svg"; filename*=UTF-8''listing-${stock}-qr.svg`);
      expect((await rep.client.get(`/vehicles/${v}/listing/qr`)).status).toBe(200);
      const noVehicles = await addMemberWithPermissions(app, t, ['customers.read']);
      expect((await noVehicles.client.get(`/vehicles/${v}/listing/qr`)).status).toBe(403);
      expect(String(svg.body)).toContain('<svg');
      const png = await owner.get(`/vehicles/${v}/listing/qr?format=png`).responseType('blob');
      expect((png.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
      expect(png.headers['content-disposition']).toContain(`filename="listing-${stock}-qr.png"`);
      const stale = await owner.put(`/vehicles/${v}/listing`, { titleEn: 'y', version: 1 });
      expect(stale.status).toBe(409);
      // A plan without the showroom feature cannot publish.
      const starter = await createTenant(app, await createPlatformAdmin(app), { planCode: 'starter' });
      const sv = await createVehicle(starter.owner, starter.branchId);
      await makeAvailable(starter.owner, sv.id);
      const gated = await starter.owner.post(`/vehicles/${sv.id}/listing/publish`);
      expect(gated.status).toBe(402);
      expect(gated.body.error.code).toBe('plan_feature_missing');
      expect((await starter.owner.put('/integrations/vin_decoder', { enabled: true })).status).toBe(402);
    });

    it('download names: ASCII fallback plus the exact UTF-8 name, never a path or a quote', () => {
      expect(contentDisposition('attachment', 'listing-STK-2026-000012-qr.png')).toBe(
        `attachment; filename="listing-STK-2026-000012-qr.png"; filename*=UTF-8''listing-STK-2026-000012-qr.png`,
      );
      expect(contentDisposition('attachment', 'listing-سيارة-7-qr.svg')).toBe(
        `attachment; filename="listing-_-7-qr.svg"; filename*=UTF-8''listing-%D8%B3%D9%8A%D8%A7%D8%B1%D8%A9-7-qr.svg`,
      );
      expect(contentDisposition('inline', 'Café "A"/../b.pdf')).toBe(`inline; filename="Cafe_A_.._b.pdf"; filename*=UTF-8''Caf%C3%A9%20%22A%22_.._b.pdf`);
      expect(contentDisposition('attachment', '')).toBe(`attachment; filename="download"; filename*=UTF-8''download`);
    });

    it('the listings list reports no description source for a listing without a description', async () => {
      const bare = await vehicle();
      expect((await owner.put(`/vehicles/${bare}/listing`, { titleEn: 'Title only', titleAr: 'عنوان فقط' })).status).toBe(200);
      const described = await vehicle();
      expect((await owner.put(`/vehicles/${described}/listing`, { titleEn: 'Described', descriptionEn: 'Typed by staff.' })).status).toBe(200);
      const rows = (await owner.get('/showroom/listings?pageSize=100')).body.items as Array<{ vehicleId: string; descriptionSource: string | null }>;
      expect(rows.find((r) => r.vehicleId === bare)?.descriptionSource).toBeNull();
      expect(rows.find((r) => r.vehicleId === described)?.descriptionSource).toBe('manual');
    });

    it('only general photos are public: recategorising a photo withdraws it, and other categories cannot be made public', async () => {
      await showroomSettings();
      const v = await vehicle();
      const listingId = await publish(v);
      const photo = await owner.upload(`/vehicles/${v}/media`, { buffer: JPEG, name: 'front.jpg' });
      expect(photo.body).toMatchObject({ category: 'general', isPublic: true });
      const before = await pub(`/vehicles/${listingId}`);
      expect(before.body.photos).toHaveLength(1);
      const moved = await owner.patch(`/vehicles/${v}/media/${photo.body.id}`, { category: 'document' });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body.isPublic).toBe(false);
      expect((await pub(`/vehicles/${listingId}`)).body.photos).toEqual([]);
      expect((await request(app.getHttpServer()).get(before.body.photos[0].url)).status).toBe(404);
      const refused = await owner.patch(`/vehicles/${v}/media/${photo.body.id}`, { isPublic: true });
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('media_not_publishable');
      const declared = await owner.upload(`/vehicles/${v}/media`, { buffer: JPEG, name: 'card.jpg' }, { category: 'document', isPublic: 'true' });
      expect(declared.body.isPublic).toBe(false);
    });
  });

  describe('inquiries', () => {
    // Every test request comes from 127.0.0.1, so each test starts with a fresh per-client budget.
    beforeEach(() => app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear());

    it('an inquiry becomes a customer and an unassigned showroom lead; repeats attach to it; bots are ignored', async () => {
      await showroomSettings();
      const v = await vehicle();
      const listingId = await publish(v);
      const first = await inquire({ listingId, name: 'Saud Al-Mutairi', phone: '0551234567', message: 'Is it still available?' });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body).toEqual({ status: 'received' });
      const lead = await pool.query(
        `SELECT l.id, l.source, l.assigned_user_id, l.vehicle_id, c.full_name, c.phone, c.assigned_user_id AS customer_owner
           FROM leads l JOIN customers c ON c.id = l.customer_id WHERE l.tenant_id = $1 AND l.vehicle_id = $2`,
        [t.tenantId, v],
      );
      expect(lead.rows).toEqual([
        expect.objectContaining({ source: 'showroom', assigned_user_id: null, customer_owner: null, full_name: 'Saud Al-Mutairi', phone: '966551234567' }),
      ]);
      const note = await pool.query(`SELECT summary FROM customer_interactions WHERE tenant_id = $1 AND lead_id = $2`, [t.tenantId, lead.rows[0].id]);
      expect(note.rows[0].summary).toContain('(unverified contact) from “Saud Al-Mutairi”');
      const n = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND type = 'showroom.inquiry'`, [t.tenantId]);
      expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
      // Acknowledgements to the unverified number are off unless the company turns them on.
      expect((await pool.query(`SELECT count(*)::int AS n FROM message_log WHERE tenant_id = $1 AND recipient = '0551234567'`, [t.tenantId])).rows[0].n).toBe(0);

      // Same phone, same vehicle, same day: attached to the first inquiry, nothing new created.
      const again = await inquire({ listingId, kind: 'test_drive', name: 'Saud', phone: '+966 55 123 4567', preferredDate: '2026-11-01' });
      expect(again.status).toBe(201);
      const leads = await pool.query(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1 AND vehicle_id = $2`, [t.tenantId, v]);
      expect(leads.rows[0].n).toBe(1);
      const inquiries = await pool.query(`SELECT kind, lead_id, unlinked_reason, consent_at FROM showroom_inquiries WHERE tenant_id = $1 ORDER BY created_at`, [t.tenantId]);
      expect(inquiries.rows.map((r) => [r.kind, r.unlinked_reason])).toEqual([
        ['inquiry', null],
        ['test_drive', 'repeat'],
      ]);
      expect(new Set(inquiries.rows.map((r) => r.lead_id)).size).toBe(1);
      expect(inquiries.rows.every((r) => r.consent_at instanceof Date)).toBe(true);

      const bot = await inquire({ listingId, name: 'Spam Bot', phone: '0559999999', website: 'http://spam.example' });
      expect(bot.status).toBe(201);
      expect((await pool.query(`SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1 AND full_name = 'Spam Bot'`, [t.tenantId])).rows[0].n).toBe(0);
      expect((await inquire({ name: 'No consent', phone: '0550000000', consent: false })).status).toBe(422);
      expect((await inquire({ listingId: '00000000-0000-4000-8000-000000000000', name: 'Ghost', phone: '0550000001' })).status).toBe(404);
    });

    it('a deactivated customer\'s number gets the same answer and is queued for staff, not linked', async () => {
      await showroomSettings();
      const c = await createCustomer(owner, { fullName: 'Former customer', phone: '0557770001' });
      const off = await owner.post(`/customers/${c.id}/deactivate`, { reason: 'Moved abroad', version: c.version });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      const res = await inquire({ name: 'Someone', phone: '0557770001', message: 'hello' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ status: 'received' });
      const row = await pool.query(`SELECT customer_id, lead_id, unlinked_reason FROM showroom_inquiries WHERE tenant_id = $1 AND phone = '0557770001'`, [t.tenantId]);
      expect(row.rows).toEqual([{ customer_id: null, lead_id: null, unlinked_reason: 'customer_inactive' }]);
      expect((await pool.query(`SELECT count(*)::int AS n FROM leads WHERE customer_id = $1`, [c.id])).rows[0].n).toBe(0);
      const queue = await owner.get('/showroom/inquiries?unlinked=true');
      expect(queue.status).toBe(200);
      expect(queue.body.items.map((x: { phone: string }) => x.phone)).toContain('0557770001');
      const rep = await addMember(app, t, 'sales_rep');
      expect((await rep.client.get('/showroom/inquiries')).status).toBe(403);
    });

    it('stops storing inquiries past the daily limit while answering the same way', async () => {
      const co = await createTenant(app, await createPlatformAdmin(app));
      expect((await co.owner.patch('/company', { settings: { showroom: { enabled: true, showReserved: false, showPrices: true } } })).status).toBe(200);
      await pool.query(
        `INSERT INTO showroom_inquiries (tenant_id, kind, name, phone, consent_at) SELECT $1, 'inquiry', 'x', '0550000000', now() FROM generate_series(1, 200)`,
        [co.tenantId],
      );
      const res = await request(app.getHttpServer()).post(`/api/v1/public/showroom/${co.slug}/inquiries`).set('Origin', ORIGIN).send({ consent: true, name: 'Late', phone: '0551231231' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ status: 'received' });
      expect((await pool.query(`SELECT count(*)::int AS n FROM showroom_inquiries WHERE tenant_id = $1`, [co.tenantId])).rows[0].n).toBe(200);
      expect((await pool.query(`SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1 AND full_name = 'Late'`, [co.tenantId])).rows[0].n).toBe(0);
    });

    it('acknowledgements go out after commit: a failing gateway never blocks the inquiry, a working one gets a signed message, redirects are not followed', async () => {
      await showroomSettings({ acknowledgeInquiries: true });
      const dead = await owner.put('/integrations/messaging', { enabled: true, config: { provider: 'webhook', url: 'http://127.0.0.1:9/hook' }, secret: 'whsec_test_123456' });
      expect(dead.status, JSON.stringify(dead.body)).toBe(200);
      app.get(MessagingService).timeoutMs = 1_000;
      const r1 = await inquire({ name: 'Gateway down', phone: '0551112223' });
      expect(r1.status).toBe(201);
      const failed = await pool.query(`SELECT provider, status, error FROM message_log WHERE tenant_id = $1 AND recipient = '0551112223'`, [t.tenantId]);
      expect(failed.rows[0]).toMatchObject({ provider: 'webhook', status: 'failed' });

      const gw = await stub((_req, _body, res) => json(res, 200, { ok: true }));
      servers.push(gw.server);
      expect((await owner.put('/integrations/messaging', { enabled: true, config: { provider: 'webhook', url: `${gw.url}/hook` } })).status).toBe(200);
      expect((await inquire({ name: 'Gateway up', phone: '0551112224' })).status).toBe(201);
      expect(gw.calls).toHaveLength(1);
      expect(JSON.parse(gw.calls[0]!.body)).toMatchObject({ channel: 'whatsapp', to: '0551112224' });
      expect(gw.calls[0]!.headers['x-autohub-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      const sent = await pool.query(`SELECT status FROM message_log WHERE tenant_id = $1 AND recipient = '0551112224'`, [t.tenantId]);
      expect(sent.rows[0].status).toBe('sent');

      // A gateway that redirects elsewhere is a failure; the redirect target is never contacted.
      const target = await stub((_req, _body, res) => json(res, 200, { ok: true }));
      const bouncer = await stub((_req, _body, res) => {
        res.writeHead(307, { location: `${target.url}/internal` });
        res.end();
      });
      servers.push(target.server, bouncer.server);
      expect((await owner.put('/integrations/messaging', { enabled: true, config: { provider: 'webhook', url: `${bouncer.url}/hook` } })).status).toBe(200);
      expect((await inquire({ name: 'Redirected', phone: '0551112225' })).status).toBe(201);
      expect(bouncer.calls).toHaveLength(1);
      expect(target.calls).toHaveLength(0);
      const redirected = await pool.query(`SELECT status, error FROM message_log WHERE tenant_id = $1 AND recipient = '0551112225'`, [t.tenantId]);
      expect(redirected.rows[0]).toMatchObject({ status: 'failed', error: 'gateway answered HTTP 307' });
      await owner.put('/integrations/messaging', { enabled: false });
      await showroomSettings();
    });

    it('inquiries are rate limited per client', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await inquire({ name: `Burst ${i}`, phone: `05520000${10 + i}` })).status);
      expect(statuses).toContain(429);
    });
  });

  describe('integrations and adapters', () => {
    it('secrets are encrypted at rest and never returned', async () => {
      const put = await owner.put('/integrations/ai_text', { enabled: false, secret: 'sk-ant-test-key-ABCD' });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ provider: 'ai_text', hasSecret: true, secretLast4: 'ABCD' });
      const list = await owner.get('/integrations');
      expect(JSON.stringify(list.body)).not.toContain('sk-ant-test-key');
      const row = await pool.query(`SELECT secret_encrypted FROM integration_settings WHERE tenant_id = $1 AND provider = 'ai_text'`, [t.tenantId]);
      expect(row.rows[0].secret_encrypted).not.toContain('sk-ant');
      expect(list.body.find((x: { provider: string }) => x.provider === 'ocr')).toMatchObject({ available: false });
      expect((await owner.put('/integrations/ocr', { enabled: true })).body.error.code).toBe('integration_not_available');
      const rep = await addMember(app, t, 'sales_rep');
      expect((await rep.client.get('/integrations')).status).toBe(403);
      const audit = await pool.query(`SELECT after FROM audit_logs WHERE tenant_id = $1 AND action = 'integration.updated' ORDER BY seq DESC LIMIT 1`, [t.tenantId]);
      expect(JSON.stringify(audit.rows[0].after)).not.toContain('sk-ant');
    });

    it('VIN decoding suggests catalog matches, and a slow or failing provider only returns 503', async () => {
      const decoder = app.get(VinDecoderService);
      expect((await owner.get('/integrations/vin-decode/JTDBR32E720123456')).body.error.code).toBe('integration_disabled');
      expect((await owner.put('/integrations/vin_decoder', { enabled: true })).status).toBe(200);
      expect((await owner.get('/integrations/vin-decode/NOTAVIN')).status).toBe(422);
      const vpic = await stub((_req, _body, res) =>
        json(res, 200, { Results: [{ Make: 'TOYOTA', Model: 'Camry', ModelYear: '2022', BodyClass: 'Sedan/Saloon', FuelTypePrimary: 'Gasoline', ErrorCode: '0' }] }),
      );
      servers.push(vpic.server);
      decoder.baseUrl = vpic.url;
      const ok = await owner.get('/integrations/vin-decode/JTDBR32E720123456');
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ source: 'nhtsa_vpic', make: 'TOYOTA', model: 'Camry', modelYear: 2022 });
      expect(ok.body.makeId).toBeTruthy();
      expect(ok.body.modelId).toBeTruthy();
      expect(vpic.calls[0]!.path).toBe('/vehicles/DecodeVinValues/JTDBR32E720123456?format=json');

      const slow = await stub(() => undefined); // never answers
      servers.push(slow.server);
      decoder.baseUrl = slow.url;
      decoder.timeoutMs = 300;
      const started = Date.now();
      const timeout = await owner.get('/integrations/vin-decode/JTDBR32E720123456');
      expect(timeout.status).toBe(503);
      expect(timeout.body.error.code).toBe('integration_unavailable');
      expect(Date.now() - started).toBeLessThan(5_000);
      // Vehicle creation does not depend on the decoder.
      expect((await vehicle()).length).toBe(36);
    });

    it('AI descriptions are suggestions: template when off; Claude when enabled; template on refusal, errors or garbage', async () => {
      const v = await vehicle();
      const ai = app.get(AiTextService);
      const off = await owner.post(`/vehicles/${v}/listing/generate-description`);
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body.generation).toMatchObject({ source: 'template', fallbackReason: 'not_enabled' });
      expect(off.body.suggestion.descriptionAr).toContain('تويوتا');
      expect(off.body.suggestion.descriptionEn).toContain('Toyota');
      expect(off.body.suggestion.descriptionEn).toMatch(/\.$/);
      expect(off.body.suggestion.descriptionAr).toMatch(/\.$/);
      // Every sentence of the template ends with a full stop, the specification line included.
      const facts = { makeEn: 'Toyota', makeAr: 'تويوتا', modelEn: 'Camry', modelAr: 'كامري', modelYear: 2022, trim: null, bodyType: 'sedan', fuelType: 'petrol', transmission: 'automatic', exteriorColor: null, odometerValue: null, odometerUnit: 'km', condition: null, specRegion: null, features: [] };
      expect(templateDescription(facts)).toEqual({ en: 'Toyota Camry 2022. Sedan, Automatic transmission, Petrol.', ar: 'تويوتا كامري 2022. سيدان، ناقل حركة أوتوماتيك، وقود بنزين.' });
      expect(templateDescription({ ...facts, bodyType: null, fuelType: null, transmission: null }).en).toBe('Toyota Camry 2022.');
      // Nothing is saved until staff accept the suggestion.
      expect((await owner.get(`/vehicles/${v}/listing`)).body.listing).toBeNull();

      let mode: 'ok' | 'refusal' | 'error' | 'garbage' = 'ok';
      const claude = await stub((_req, _body, res) => {
        if (mode === 'error') return json(res, 500, { type: 'error', error: { type: 'api_error', message: 'boom' } });
        const text = mode === 'garbage' ? 'no tags here' : '<ar>سيارة مميزة بحالة ممتازة.</ar><en>A well-kept car.</en>';
        json(res, 200, {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text }],
          stop_reason: mode === 'refusal' ? 'refusal' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        });
      });
      servers.push(claude.server);
      ai.baseURL = claude.url;
      expect((await owner.put('/integrations/ai_text', { enabled: true, secret: 'sk-ant-test-key-WXYZ' })).status).toBe(200);
      const good = await owner.post(`/vehicles/${v}/listing/generate-description`);
      expect(good.body.generation).toMatchObject({ source: 'ai', model: 'claude-opus-5-5' });
      expect(good.body.suggestion).toEqual({ descriptionAr: 'سيارة مميزة بحالة ممتازة.', descriptionEn: 'A well-kept car.' });
      const saved = await owner.put(`/vehicles/${v}/listing`, { ...good.body.suggestion, descriptionSource: 'ai' });
      expect(saved.status).toBe(200);
      expect(saved.body.listing).toMatchObject({ descriptionEn: 'A well-kept car.', descriptionSource: 'ai' });
      const sent = JSON.parse(claude.calls[0]!.body);
      expect(sent).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'low' } });
      expect(claude.calls[0]!.headers['x-api-key']).toBe('sk-ant-test-key-WXYZ');
      expect(claude.calls[0]!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
      // Only specifications are sent: no price, cost or VIN.
      expect(claude.calls[0]!.body).not.toMatch(/95000|60000|88000|"vin"/);

      for (const [m, reason] of [['refusal', 'refused'], ['error', 'error:500'], ['garbage', 'unparseable']] as const) {
        mode = m;
        const r = await owner.post(`/vehicles/${v}/listing/generate-description`);
        expect(r.status).toBe(200);
        expect(r.body.generation, m).toMatchObject({ source: 'template', fallbackReason: reason });
      }
      await owner.put('/integrations/ai_text', { enabled: false });
    });
  });

  describe('insights', () => {
    it('price guidance comes only from the company own sales and needs three comparables', async () => {
      const target = await vehicle('60000.00', '120000.00', '100000.00');
      const thin = await owner.get(`/vehicles/${target}/price-guidance`);
      expect(thin.status).toBe(200);
      expect(thin.body).toMatchObject({ estimate: true, basis: 'own_sales', sufficient: false, agreedPrice: null });
      const cust = (await createCustomer(owner, { fullName: 'Repeat buyer' })).id;
      for (const price of ['100000.00', '104000.00', '110000.00']) {
        const v = await vehicle('60000.00', '120000.00', '90000.00');
        await sellVehicle(owner, { vehicleId: v, customerId: cust, cashAccountId: cash.id, agreedPrice: price });
      }
      const g = await owner.get(`/vehicles/${target}/price-guidance`);
      expect(g.body.sufficient).toBe(true);
      expect(g.body.comparableCount).toBeGreaterThanOrEqual(3);
      expect(g.body.agreedPrice.median).toBeDefined();
      expect(Number(g.body.askingVsMedianPct)).toBeGreaterThan(0);
      const rep = await addMember(app, t, 'sales_rep');
      expect((await rep.client.get(`/vehicles/${target}/price-guidance`)).status).toBe(403);

      // Aging: once past the thresholds, the vehicle gets actionable, rule-based suggestions.
      const inv = (await owner.get('/company')).body.settings.inventory;
      expect((await owner.patch('/company', { settings: { inventory: { ...inv, staleDaysWarning: 5, staleDaysCritical: 10 } } })).status).toBe(200);
      await pool.query(`UPDATE vehicles SET stocked_at = now() - interval '20 days' WHERE id = $1`, [target]);
      const rec = await owner.get('/inventory/aging-recommendations');
      const item = rec.body.items.find((x: { vehicleId: string }) => x.vehicleId === target);
      expect(item.daysInStock).toBeGreaterThanOrEqual(19);
      expect(item.actions.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(['critical_age', 'add_photos', 'review_price']));
      // Each item names the vehicle (make, model, year, stock number) in both languages.
      const v = (await owner.get(`/vehicles/${target}`)).body.vehicle;
      expect(item).toMatchObject({ stockNumber: v.stockNumber, makeEn: 'Toyota', makeAr: 'تويوتا', modelEn: 'Camry', modelAr: 'كامري', modelYear: v.modelYear });
      expect((await rep.client.get('/inventory/aging-recommendations')).status).toBe(403);
      // Branch scope and tenant isolation: other branches' and other companies' vehicles never appear.
      const dammam = await createBranch(owner, 'Dammam aging');
      const limited = await addMemberWithPermissions(app, t, ['vehicles.read', 'pricing.update'], { allBranches: false, branchIds: [dammam.id] });
      const lim = await limited.client.get('/inventory/aging-recommendations');
      expect(lim.status).toBe(200);
      expect(lim.body.items.some((x: { vehicleId: string }) => x.vehicleId === target)).toBe(false);
      const otherCo = await createTenant(app, await createPlatformAdmin(app));
      expect((await otherCo.owner.get('/inventory/aging-recommendations')).body.items.some((x: { vehicleId: string }) => x.vehicleId === target)).toBe(false);
    });

    it('price guidance uses only sales the user may see, and lists individual sales only with sales.read', async () => {
      const other = await createBranch(owner, 'Dammam');
      const target = (await createAcquisition(owner, other.id, supplier.id, { price: '60000.00', approver: checker })).vehicleId;
      await makeAvailable(owner, target, '120000.00', '100000.00');
      const limited = await addMemberWithPermissions(app, t, ['vehicles.read', 'pricing.update'], { allBranches: false, branchIds: [other.id] });
      const own = await limited.client.get(`/vehicles/${target}/price-guidance`);
      expect(own.status).toBe(200);
      // All earlier comparable sales were made in the main branch, which this user cannot see.
      expect(own.body).toMatchObject({ comparableCount: 0, sufficient: false, comparables: [] });
      const all = await owner.get(`/vehicles/${target}/price-guidance`);
      expect(all.body.comparableCount).toBeGreaterThanOrEqual(3);
      expect(all.body.comparables.length).toBeGreaterThanOrEqual(3);
      const noSales = await addMemberWithPermissions(app, t, ['vehicles.read', 'pricing.update']);
      const agg = await noSales.client.get(`/vehicles/${target}/price-guidance`);
      expect(agg.body.sufficient).toBe(true);
      expect(agg.body.comparables).toEqual([]);
    });
  });
});
