import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const testEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://autohub_app:autohub_app_dev@localhost:5432/autohub_test',
  DATABASE_MIGRATION_URL:
    process.env.TEST_DATABASE_MIGRATION_URL ?? 'postgres://autohub_owner:autohub_owner_dev@localhost:5432/autohub_test',
  APP_ORIGINS: 'http://localhost:5173',
  APP_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: './.storage-test',
  LOG_LEVEL: 'silent',
  JOBS_ENABLED: 'false',
  LOGIN_MAX_FAILURES: '5',
  RATE_LIMIT_PER_MIN: '100000',
  AUTH_RATE_LIMIT_PER_MIN: '100000',
  CHROMIUM_PATH: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
};

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: testEnv,
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: 'forks',
    fileParallelism: false,
  },
});
