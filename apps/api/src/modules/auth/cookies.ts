import type { CookieOptions, Response } from 'express';
import { getEnv } from '../../config/env';

/** __Host- prefix (Secure, Path=/, no Domain) when cookies are secure; plain names for local http dev. */
export function cookieNames() {
  const secure = getEnv().cookieSecure;
  return { session: secure ? '__Host-ah_sid' : 'ah_sid', csrf: secure ? '__Host-ah_csrf' : 'ah_csrf' };
}

export function setAuthCookies(res: Response, token: string, csrfToken: string, expiresAt: Date): void {
  const env = getEnv();
  const base: CookieOptions = { secure: env.cookieSecure, sameSite: 'lax', path: '/', expires: expiresAt };
  const names = cookieNames();
  res.cookie(names.session, token, { ...base, httpOnly: true });
  // Readable by the SPA so it can echo it in the X-CSRF-Token header (double submit, bound to session).
  res.cookie(names.csrf, csrfToken, { ...base, httpOnly: false });
}

export function clearAuthCookies(res: Response): void {
  const env = getEnv();
  const names = cookieNames();
  const base: CookieOptions = { secure: env.cookieSecure, sameSite: 'lax', path: '/' };
  res.clearCookie(names.session, { ...base, httpOnly: true });
  res.clearCookie(names.csrf, base);
}
