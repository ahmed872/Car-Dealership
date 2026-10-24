import path from 'node:path';

/**
 * Settings shared by the Playwright config, the global setup and the specs. Every value can be
 * overridden from the environment so CI (or a second local run) can use other ports or databases.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3191);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5291);
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** One database for the whole run (tests run with one worker); it is dropped and migrated at start. */
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://autohub_app:autohub_app_dev@localhost:5432/autohub_test_t';
export const DATABASE_MIGRATION_URL =
  process.env.E2E_DATABASE_MIGRATION_URL ??
  'postgres://autohub_owner:autohub_owner_dev@localhost:5432/autohub_test_t';

/** The company the API start script provisions on the fresh database. */
export const PASSWORD = 'E2ePassw0rd!x';
export const OWNER_EMAIL = 'owner@e2e.test';
export const ADMIN_EMAIL = 'admin@e2e.test';
export const TENANT = {
  name: 'E2E Motors',
  slug: 'e2e-motors',
  market: 'SA',
  branchName: 'Riyadh HQ',
  planCode: 'enterprise',
  owner: { email: OWNER_EMAIL, fullName: 'Owner E2E', password: PASSWORD },
} as const;

export const E2E_DIR = path.resolve(__dirname, '..');
export const AUTH_DIR = path.join(E2E_DIR, '.auth');
export type Lang = 'ar' | 'en';
/** Signed-in owner session (cookies + the language saved in localStorage), one per UI language. */
export const ownerState = (lang: Lang) => path.join(AUTH_DIR, `owner-${lang}.json`);
