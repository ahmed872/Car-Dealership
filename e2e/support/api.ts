import { randomUUID } from 'node:crypto';
import { type APIRequestContext, type APIResponse, request } from '@playwright/test';
import { WEB_URL } from './env';

/**
 * Cookie-session API client for fast test-data setup, behaving like apps/api/test/helpers.ts
 * `Client`: it sends the Origin of the SPA, echoes the `ah_csrf` cookie in X-CSRF-Token on every
 * mutation and adds an Idempotency-Key where the route requires one (`idem()`). Requests go through
 * the web origin (vite preview proxies /api), the same path the browser uses.
 */
export class ApiClient {
  private constructor(
    readonly ctx: APIRequestContext,
    readonly csrf: string,
  ) {}

  /** Re-uses a signed-in browser session (a storageState file or object). */
  static async fromStorageState(
    storageState: string | Awaited<ReturnType<APIRequestContext['storageState']>>,
  ) {
    const ctx = await request.newContext({
      baseURL: WEB_URL,
      storageState,
      extraHTTPHeaders: { Origin: WEB_URL },
    });
    return new ApiClient(ctx, await csrfOf(ctx));
  }

  /** POST /auth/login with a fresh cookie jar (like Client.login). */
  static async login(email: string, password: string): Promise<ApiClient> {
    const ctx = await request.newContext({ baseURL: WEB_URL, extraHTTPHeaders: { Origin: WEB_URL } });
    const res = await ctx.post('/api/v1/auth/login', { data: { email, password } });
    if (res.status() !== 200)
      throw new Error(`login failed for ${email}: ${res.status()} ${await res.text()}`);
    return new ApiClient(ctx, await csrfOf(ctx));
  }

  get(path: string, params?: Record<string, string | number | boolean>) {
    return this.ctx.get(`/api/v1${path}`, { params });
  }
  post(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.ctx.post(`/api/v1${path}`, {
      data: body ?? {},
      headers: { 'X-CSRF-Token': this.csrf, ...headers },
    });
  }
  put(path: string, body?: unknown) {
    return this.ctx.put(`/api/v1${path}`, { data: body ?? {}, headers: { 'X-CSRF-Token': this.csrf } });
  }
  patch(path: string, body?: unknown) {
    return this.ctx.patch(`/api/v1${path}`, { data: body ?? {}, headers: { 'X-CSRF-Token': this.csrf } });
  }
  delete(path: string) {
    return this.ctx.delete(`/api/v1${path}`, { headers: { 'X-CSRF-Token': this.csrf } });
  }

  /** GET that must succeed; returns the JSON body. */
  async json<T = unknown>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    return expectStatus<T>(await this.get(path, params), 200, `GET ${path}`);
  }

  /** Cookies (and nothing else) of this session, to open a browser context signed in as this user. */
  storageState() {
    return this.ctx.storageState();
  }

  dispose() {
    return this.ctx.dispose();
  }
}

async function csrfOf(ctx: APIRequestContext): Promise<string> {
  const state = await ctx.storageState();
  const cookie = state.cookies.find((c) => c.name === 'ah_csrf' || c.name === '__Host-ah_csrf');
  if (!cookie) throw new Error('no ah_csrf cookie in the session');
  return decodeURIComponent(cookie.value);
}

/** Throws (with the API's error body) unless the response has the expected status. */
export async function expectStatus<T = unknown>(res: APIResponse, status: number, what: string): Promise<T> {
  if (res.status() !== status) throw new Error(`${what} failed: ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

export const idem = () => ({ 'Idempotency-Key': `e2e-${randomUUID()}` });
export const uniq = (prefix = 't') => `${prefix}${randomUUID().slice(0, 8)}`;
