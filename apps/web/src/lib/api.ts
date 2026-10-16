export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** Required by the server for financial mutations; pass a stable key per user action. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Raw FormData upload (multipart). */
  form?: FormData;
}

function readCookie(name: string): string | null {
  const parts = document.cookie.split('; ');
  for (const p of parts) {
    const [k, ...v] = p.split('=');
    if (k === name || k === `__Host-${name}`) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, String(v));
    }
  }
  return url.pathname + url.search;
}

const listeners = new Set<(e: ApiError) => void>();
/** Subscribe to authentication failures (e.g. to redirect to the login page). */
export function onAuthError(fn: (e: ApiError) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    const csrf = readCookie('ah_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', 'network_error');
  }
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const err = payload?.error ?? {};
    const apiErr = new ApiError(
      res.status,
      err.code ?? 'http_error',
      err.message ?? res.statusText,
      err.details,
      err.requestId,
    );
    if (res.status === 401) listeners.forEach((l) => l(apiErr));
    throw apiErr;
  }
  return (isJson ? payload : await res.blob()) as T;
}

/** Downloads a binary response (PDF/XLSX/CSV) and triggers a save. */
export async function download(path: string, query?: Query, fallbackName = 'download'): Promise<void> {
  const res = await fetch(buildUrl(path, query), { credentials: 'same-origin' });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      payload?.error?.code ?? 'http_error',
      payload?.error?.message ?? res.statusText,
    );
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
  const name = decodeURIComponent(match?.[1] ?? match?.[2] ?? fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}
