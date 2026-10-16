import { sql } from 'drizzle-orm';
import { numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

export const pk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
export const tenantId = () => uuid('tenant_id').notNull();
export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
export const ts = (name: string) => timestamp(name, { withTimezone: true });

/** numeric(18,2) — returned by node-postgres as a string; never parse to float. */
export const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
export const rate = (name: string) => numeric(name, { precision: 18, scale: 8 });
export const pct = (name: string) => numeric(name, { precision: 9, scale: 4 });

/** Builds a CHECK expression "col IN ('a','b')" from a readonly list. */
export function inList(column: string, values: readonly string[]) {
  const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  return sql.raw(`${column} IN (${list})`);
}
