// Minimal cookie-session API client for seeding demo data through the real API
// (same behaviour as e2e/support/api.ts: Origin header, CSRF echo, Idempotency-Key).
import { randomUUID } from 'node:crypto';

export const WEB = process.env.GUIDE_WEB_URL ?? 'http://localhost:5205';
export const PASSWORD = process.env.GUIDE_PASSWORD ?? 'SandboxPassw0rd!';

export class Client {
  constructor() { this.cookies = new Map(); }
  static async login(email, password = PASSWORD) {
    const c = new Client();
    c.email = email;
    await c.req('POST', '/auth/login', { email, password }, { expect: 200 });
    return c;
  }
  get csrf() { return this.cookies.get('ah_csrf') ?? this.cookies.get('__Host-ah_csrf'); }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, body, { expect, idem = false, raw = false, headers = {} } = {}) {
    const h = { Origin: WEB, Cookie: this.cookieHeader(), ...headers };
    if (method !== 'GET' && this.csrf) h['X-CSRF-Token'] = decodeURIComponent(this.csrf);
    if (idem) h['Idempotency-Key'] = `guide-${randomUUID()}`;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined && method !== 'GET') { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let url = `${WEB}/api/v1${path}`;
    if (method === 'GET' && body) url += '?' + new URLSearchParams(body).toString();
    const res = await fetch(url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    if (raw) return res;
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    const ok = expect ? (Array.isArray(expect) ? expect.includes(res.status) : res.status === expect) : res.status < 300;
    if (!ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 600)}`);
    return json;
  }
  get(p, q) { return this.req('GET', p, q); }
  post(p, b = {}, o = {}) { return this.req('POST', p, b, o); }
  put(p, b = {}, o = {}) { return this.req('PUT', p, b, o); }
  patch(p, b = {}, o = {}) { return this.req('PATCH', p, b, o); }
}
