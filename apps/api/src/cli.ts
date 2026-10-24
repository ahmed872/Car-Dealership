import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { zEmail, zPassword, zProvisionTenant } from '@autohub/shared';
import { AppModule } from './app.module';
import { DbService } from './db/db.service';
import { users } from './db/schema';
import { PasswordService } from './modules/auth/password.service';
import { encryptSupplierNationalIds } from './modules/purchasing/supplier-id-backfill';
import { SuppliersService } from './modules/purchasing/suppliers.service';
import { ProvisioningService } from './modules/tenancy/provisioning.service';

/**
 * Operational CLI.
 *   create-platform-admin --email a@b.com --name "Admin"   (password from AUTOHUB_ADMIN_PASSWORD)
 *   provision-tenant '<json>'                                (zProvisionTenant payload)
 *   encrypt-supplier-ids [--tenant <uuid>] [--batch-size 500] (upgrade step after migration 0018, D-047:
 *                                                            encrypts plain-text supplier national IDs; idempotent)
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const arg = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const dbs = app.get(DbService);
    if (command === 'create-platform-admin') {
      const email = zEmail.parse(arg('email'));
      const fullName = arg('name') ?? 'Platform Admin';
      const password = zPassword.parse(process.env.AUTOHUB_ADMIN_PASSWORD);
      const hash = await app.get(PasswordService).hash(password);
      await dbs.runInTenant({ tenantId: null, userId: null }, async () => {
        const [existing] = await dbs.db.select({ id: users.id }).from(users).where(eq(users.email, email));
        if (existing) {
          await dbs.db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, existing.id));
        } else {
          await dbs.db.insert(users).values({
            email,
            fullName,
            passwordHash: hash,
            isPlatformAdmin: true,
            passwordChangedAt: new Date(),
          });
        }
      });
      console.log(`Platform admin ready: ${email}`);
    } else if (command === 'provision-tenant') {
      const input = zProvisionTenant.parse(JSON.parse(rest[0] ?? '{}'));
      const result = await app.get(ProvisioningService).provision(input, null);
      console.log(JSON.stringify(result));
    } else if (command === 'encrypt-supplier-ids') {
      const tenantId = arg('tenant');
      const batch = arg('batch-size');
      const batchSize = batch === undefined ? undefined : Number(batch);
      if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000)) {
        throw new Error('--batch-size must be an integer between 1 and 10000');
      }
      const result = await encryptSupplierNationalIds(dbs, app.get(SuppliersService), {
        tenantId,
        batchSize,
      });
      // encrypted: recognised IDs (normalised, hashed for duplicate checks); unrecognised: encrypted
      // exactly as typed, without a duplicate-check hash; cleared: blank or already encrypted.
      const line = (c: { encrypted: number; unrecognised: number; cleared: number }) =>
        `encrypted ${c.encrypted}, encrypted as typed (not a recognisable ID) ${c.unrecognised}, plain text removed only ${c.cleared}`;
      for (const t of result.tenants) {
        if (t.encrypted || t.unrecognised || t.cleared) console.log(`${t.slug}: ${line(t)}`);
      }
      console.log(
        `Supplier national IDs: ${result.tenants.length} companies checked; ${line(result.totals)}`,
      );
    } else {
      console.error('Unknown command. Use: create-platform-admin | provision-tenant | encrypt-supplier-ids');
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
