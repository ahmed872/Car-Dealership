import { afterEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../src/db/reset';

// The guard runs before any connection is opened, so an unreachable port is enough.
const url = (db: string) => `postgres://autohub_owner:x@127.0.0.1:1/${db}`;

describe('database reset guard', () => {
  const saved = { node: process.env.NODE_ENV, confirm: process.env.AUTOHUB_CONFIRM_RESET };
  afterEach(() => {
    process.env.NODE_ENV = saved.node;
    if (saved.confirm === undefined) delete process.env.AUTOHUB_CONFIRM_RESET;
    else process.env.AUTOHUB_CONFIRM_RESET = saved.confirm;
  });

  it('refuses the deployment database name and any other name without confirmation', async () => {
    delete process.env.AUTOHUB_CONFIRM_RESET;
    await expect(resetDatabase(url('autohub'))).rejects.toThrow(/Refusing to reset database "autohub"/);
    await expect(resetDatabase(url('autohub_prod'))).rejects.toThrow(/AUTOHUB_CONFIRM_RESET=autohub_prod/);
    await expect(resetDatabase(url('postgres'))).rejects.toThrow(/Refusing/);
  });

  it('a confirmation for another database does not unlock this one', async () => {
    process.env.AUTOHUB_CONFIRM_RESET = 'autohub_other';
    await expect(resetDatabase(url('autohub'))).rejects.toThrow(/Refusing to reset database "autohub"/);
  });

  it('never resets in production, even when confirmed', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTOHUB_CONFIRM_RESET = 'autohub_test_x';
    await expect(resetDatabase(url('autohub_test_x'))).rejects.toThrow(/production/);
  });

  it('dev/test names pass the guard (and then fail only on the unreachable server)', async () => {
    delete process.env.AUTOHUB_CONFIRM_RESET;
    process.env.NODE_ENV = 'test';
    await expect(resetDatabase(url('autohub_test_x'))).rejects.not.toThrow(/Refusing/);
  });
});
