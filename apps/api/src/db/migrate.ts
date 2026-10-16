import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/** Applies pending migrations using the OWNER role connection (DATABASE_MIGRATION_URL). */
export async function runMigrations(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.join(__dirname, 'migrations') });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    console.error('DATABASE_MIGRATION_URL is required');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      console.log('Migrations applied');
    })
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
