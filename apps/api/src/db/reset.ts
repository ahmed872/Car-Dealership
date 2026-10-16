import { Pool } from 'pg';
import { runMigrations } from './migrate';

/**
 * Drops and recreates the schema, then migrates. DEVELOPMENT/TEST ONLY — refuses to run in production
 * or against a database whose name does not look like a dev/test database.
 */
export async function resetDatabase(url: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
  const dbName = new URL(url).pathname.slice(1);
  if (!/(_test|_dev|^autohub)$/.test(dbName) && !dbName.endsWith('test')) {
    throw new Error(`Refusing to reset database "${dbName}"`);
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
