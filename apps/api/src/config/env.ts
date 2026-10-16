import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Application role connection (RLS enforced). Must NOT be a superuser, BYPASSRLS, or table owner. */
    DATABASE_URL: z.string().url(),
    /** Owner role connection, used only by the migrator. */
    DATABASE_MIGRATION_URL: z.string().url().optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    /** Comma-separated list of allowed browser origins (CORS + CSRF Origin check). */
    APP_ORIGINS: z.string().default('http://localhost:5173'),
    PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
    COOKIE_SECURE: bool.optional(),
    SESSION_IDLE_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .default(720),
    SESSION_ABSOLUTE_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(168),
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(50).default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    /** 32-byte key, base64 — encrypts integration secrets at rest. */
    APP_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENCRYPTION_KEY must be 32 bytes base64'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./storage'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(500).default(25),
    CHROMIUM_PATH: z.string().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    JOBS_ENABLED: bool.default(true),
    TRUST_PROXY: bool.default(false),
    RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(1_000_000).default(600),
    AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(1_000_000).default(10),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
    VIN_DECODER: z.enum(['none', 'nhtsa']).default('none'),
    ALLOW_TENANT_SELF_SIGNUP: bool.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET'],
        message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
      });
    }
    if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE cannot be false in production',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema> & { cookieSecure: boolean; origins: string[] };

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  return {
    ...env,
    cookieSecure: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    origins: env.APP_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
