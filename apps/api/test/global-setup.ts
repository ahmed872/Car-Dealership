import { resetDatabase } from '../src/db/reset';

export default async function setup() {
  const url =
    process.env.TEST_DATABASE_MIGRATION_URL ??
    'postgres://autohub_owner:autohub_owner_dev@localhost:5432/autohub_test';
  process.env.NODE_ENV = 'test';
  await resetDatabase(url);
}
