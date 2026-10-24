import { Pool } from 'pg';
import { runMigrations } from './migrate';

/** Databases that may be reset without confirmation. */
const DEV_TEST_DB = /^autohub_(dev|test(_[a-z0-9]+)?)$/;

/**
 * Drops and recreates the schema, then migrates. DEVELOPMENT/TEST ONLY — refuses to run in production.
 * Only `autohub_dev` and `autohub_test*` are reset without confirmation: the deployment's database is
 * named `autohub` by default (docker-compose AUTOHUB_DB_NAME), so any other name needs
 * AUTOHUB_CONFIRM_RESET=<that name>, or a stray `db:reset` with a production URL would wipe it.
 */
export async function resetDatabase(url: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!DEV_TEST_DB.test(dbName) && process.env.AUTOHUB_CONFIRM_RESET !== dbName) {
    throw new Error(
      `Refusing to reset database "${dbName}": only autohub_dev and autohub_test* are reset without confirmation. ` +
        `This deletes ALL data; to proceed set AUTOHUB_CONFIRM_RESET=${dbName}.`,
    );
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
    );
  } finally {
    await pool.end();
  }
  await runMigrations(url);
}

if (require.main === module) {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL is required');
  resetDatabase(url)
    .then(() => console.log('Database reset and migrated'))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
