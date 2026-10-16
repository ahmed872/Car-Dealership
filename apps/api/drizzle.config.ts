import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL ?? 'postgres://autohub_owner:autohub_owner@localhost:5432/autohub' },
  strict: true,
  verbose: false,
});
