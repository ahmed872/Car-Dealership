import os from 'node:os';
import path from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_PORT,
  API_URL,
  DATABASE_MIGRATION_URL,
  DATABASE_URL,
  ownerState,
  PASSWORD,
  TENANT,
  WEB_PORT,
  WEB_URL,
} from './support/env';
import type { TestOptions } from './support/test';

const CI = !!process.env.CI;

/**
 * Browser end-to-end tests against the real stack: the NestJS API (development mode — production
 * insists on Secure cookies, which need https) on a freshly reset PostgreSQL database, and the
 * production build of the web app served by `vite preview`, which proxies /api to the API exactly
 * like the reverse proxy in production. One worker: every spec shares that one database.
 */
export default defineConfig<TestOptions>({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'ar-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1366, height: 900 },
        locale: 'ar',
        lang: 'ar',
        storageState: ownerState('ar'),
      },
    },
    {
      name: 'en-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1366, height: 900 },
        locale: 'en',
        lang: 'en',
        storageState: ownerState('en'),
      },
    },
    {
      name: 'mobile-ar',
      use: {
        // Chromium with a phone viewport (Pixel 7 class), touch and the mobile meta-viewport.
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['Pixel 7'].userAgent,
        locale: 'ar',
        lang: 'ar',
        storageState: ownerState('ar'),
      },
    },
  ],
  webServer: [
    {
      name: 'api',
      command: './scripts/start-api.sh',
      url: `${API_URL}/api/v1/health/ready`,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        DATABASE_URL,
        DATABASE_MIGRATION_URL,
        APP_ORIGINS: WEB_URL,
        PUBLIC_WEB_URL: WEB_URL,
        // A fixed, test-only key (the same one the API integration tests use) — not a secret.
        APP_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
        STORAGE_DRIVER: 'local',
        STORAGE_LOCAL_DIR: path.join(os.tmpdir(), `autohub-e2e-storage-${API_PORT}`),
        JOBS_ENABLED: 'false',
        LOG_LEVEL: 'warn',
        // Every spec signs in through the UI; the production limits would throttle a full run.
        AUTH_RATE_LIMIT_PER_MIN: '10000',
        RATE_LIMIT_PER_MIN: '100000',
        EXPORT_RATE_LIMIT_PER_MIN: '1000',
        // Sale documents are rendered to PDF with the same Chromium Playwright drives.
        CHROMIUM_PATH: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
        AUTOHUB_ADMIN_PASSWORD: PASSWORD,
        E2E_ADMIN_EMAIL: ADMIN_EMAIL,
        E2E_TENANT_JSON: JSON.stringify(TENANT),
      },
    },
    {
      name: 'web',
      // The production bundle (set E2E_SKIP_WEB_BUILD=1 when it was just built, as CI does).
      command: `${process.env.E2E_SKIP_WEB_BUILD ? '' : 'pnpm exec vite build && '}pnpm exec vite preview --port ${WEB_PORT} --strictPort`,
      cwd: '../apps/web',
      url: WEB_URL,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { API_URL },
    },
  ],
});
