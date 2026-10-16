import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { zEmail, zPassword, zProvisionTenant } from '@autohub/shared';
import { AppModule } from './app.module';
import { DbService } from './db/db.service';
import { users } from './db/schema';
import { PasswordService } from './modules/auth/password.service';
import { ProvisioningService } from './modules/tenancy/provisioning.service';

/**
 * Operational CLI.
 *   create-platform-admin --email a@b.com --name "Admin"   (password from AUTOHUB_ADMIN_PASSWORD)
 *   provision-tenant '<json>'                                (zProvisionTenant payload)
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
          await dbs.db.insert(users).values({ email, fullName, passwordHash: hash, isPlatformAdmin: true, passwordChangedAt: new Date() });
        }
      });
      console.log(`Platform admin ready: ${email}`);
    } else if (command === 'provision-tenant') {
      const input = zProvisionTenant.parse(JSON.parse(rest[0] ?? '{}'));
      const result = await app.get(ProvisioningService).provision(input, null);
      console.log(JSON.stringify(result));
    } else {
      console.error('Unknown command. Use: create-platform-admin | provision-tenant');
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
