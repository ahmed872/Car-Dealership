import { createApp } from './bootstrap';
import { getEnv } from './config/env';

async function main() {
  const env = getEnv();
  const app = await createApp();
  await app.listen(env.PORT, env.HOST);
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
