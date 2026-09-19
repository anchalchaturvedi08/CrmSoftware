/**
 * Validated application configuration.
 *
 * Every environment variable the server reads is declared and validated here,
 * once, at startup. Nothing else in the codebase touches `process.env` — so a
 * missing secret is a loud boot failure rather than an `undefined` that
 * silently disables security later.
 *
 * Spec §19 requires business values to be configurable rather than hard-coded.
 */
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/** Accepts the common truthy spellings people actually write in .env files. */
const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /* ---- Database -------------------------------------------------------- */
  /* Must be a replica set: spec §19 requires transactions, and MongoDB only
     offers them on a replica set. See DECISIONS.md §2. */
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  /* ---- Auth ------------------------------------------------------------ */
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  /* ---- Login throttling ------------------------------------------------ */
  /* Spec section 19 requires the backend to be the real gate. A ten-digit
     mobile number plus a human-chosen password is a guessable pair, and
     per-IP limits alone are trivially defeated by rotating addresses — so
     failures are also counted against the account itself. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  /* Per-IP ceiling, applied before any database work. */
  LOGIN_RATE_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  LOGIN_RATE_MAX_REQUESTS: z.coerce.number().int().positive().default(20),

  /* ---- Happy Code ------------------------------------------------------ */
  /* AES-256-GCM key, 32 bytes hex-encoded. Encrypted rather than hashed so
     Admin can re-send a code the customer never received — see
     DECISIONS.md §4.2. */
  HAPPY_CODE_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'HAPPY_CODE_KEY must be 64 hex characters (32 bytes)'),
  /* A 6-digit code is only 10^6 possibilities, so verification is capped. */
  HAPPY_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /* ---- SLA (spec §14: configurable, not hard-coded) -------------------- */
  SLA_PAUSE_ON_WAITING_PARTS: booleanish.default(false),
  SLA_PAUSE_ON_REVISIT_REQUIRED: booleanish.default(false),

  /* ---- Time ------------------------------------------------------------ */
  /* Timestamps are stored UTC and rendered in this single company timezone. */
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),

  /* ---- Attachments (spec §19: access-controlled, never public) --------- */
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  STORAGE_MAX_FILE_MB: z.coerce.number().int().positive().default(10),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * The placeholder values shipped in `server/.env.example`.
 *
 * The two JWT placeholders are 41 and 43 characters, so they pass the length
 * rule above. A copied example file would therefore boot with secrets anyone
 * can read in the repository — and a known access secret lets anyone sign an
 * Admin token, choosing its `ims` claim too, so not even a password change
 * would revoke it.
 */
const EXAMPLE_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'replace-me-with-48-random-bytes-base64url',
  'replace-me-with-a-different-48-random-bytes',
  'replace-me-with-64-hex-characters',
]);

/**
 * Fewer distinct characters than this reads as a made-up value, not a random one.
 *
 * Measured rather than guessed: over 200,000 random 32-character hex secrets
 * (the shortest real secret the length rule allows) the fewest distinct
 * characters seen was 8, and base64url secrets never came close. Typed
 * stand-ins sit well below it — `aaaa…`, `abab…`, `passwordpassword…` (7).
 */
const MIN_DISTINCT_CHARACTERS = 8;

/**
 * Why each secret is unfit for production, if it is. Never includes a value.
 *
 * Heuristics, not proof of randomness: they catch the placeholder, a typed
 * stand-in and a copy-paste of one secret into both slots. Exported so the
 * rules can be tested without booting a production process.
 */
export function productionSecretIssues(
  env: Pick<AppConfig, 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET' | 'HAPPY_CODE_KEY'>,
): string[] {
  const issues: string[] = [];

  for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'HAPPY_CODE_KEY'] as const) {
    const value = env[name];

    if (EXAMPLE_PLACEHOLDERS.has(value) || /replace-?me/i.test(value)) {
      issues.push(`${name}: still the placeholder from .env.example`);
      continue;
    }

    if (new Set(value).size < MIN_DISTINCT_CHARACTERS) {
      issues.push(`${name}: uses too few different characters to be a random secret`);
      continue;
    }

    /* One short run typed again and again, e.g. `0123456789` four times. */
    if (/^(.+?)\1+$/s.test(value)) {
      issues.push(`${name}: is one short pattern repeated, not a random secret`);
    }
  }

  /* With one key for both, a leaked access secret also mints refresh tokens —
     the separation described in core/tokens.ts would be for show. */
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    issues.push('JWT_REFRESH_SECRET: must be different from JWT_ACCESS_SECRET');
  }

  return issues;
}

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
      'Copy server/.env.example to server/.env and fill in the values.',
    );
  }

  /**
   * Production refuses weak secrets outright; development and test keep
   * working with whatever `.env` holds, as before.
   *
   * A boot failure here is the cheap moment to find out. The same secret
   * discovered after go-live means rotating it, which signs everyone out and —
   * for HAPPY_CODE_KEY — makes every stored Happy Code unreadable.
   */
  if (parsed.data.NODE_ENV === 'production') {
    const weak = productionSecretIssues(parsed.data);
    if (weak.length > 0) {
      throw new Error(
        'Refusing to start in production with unsafe secrets:\n' +
        `${weak.map((issue) => `  - ${issue}`).join('\n')}\n\n` +
        'Generate each one separately:\n' +
        '  JWT secrets:    node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\n' +
        '  HAPPY_CODE_KEY: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
  }

  return parsed.data;
}

/**
 * A connection string that is safe to print: any `user:password@` is masked.
 *
 * Scripts announce which database they are about to touch, which is worth
 * keeping — but once the database has authentication on, the URI carries its
 * password, and console output ends up in terminal scrollback and CI logs.
 * Matching up to the last `@` before the query string also masks a password
 * that contains an unescaped `@` or `/`.
 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s?#]*@/gi, '$1***:***@');
}

export const config = loadConfig();

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
