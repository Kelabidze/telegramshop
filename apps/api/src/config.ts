import path from 'node:path';
import { z } from 'zod';

/**
 * Environment parsing. Fails fast and loudly at boot: a missing bot token must
 * never surface later as a silent auth bypass.
 */
const booleanish = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().default('file:./prisma/dev.db'),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  TELEGRAM_PROVIDER_TOKEN: z.string().default(''),
  /** Override the Bot API root. Used by tests to avoid real network calls. */
  TELEGRAM_API_ROOT: z.string().default(''),
  PUBLIC_API_URL: z.string().default(''),
  /** Public origin of the Mini App, for the web_app buttons in the bot. */
  PUBLIC_APP_URL: z.string().default(''),

  /**
   * Club channel membership is checked against this chat.
   *
   * Either `@publicname` or a numeric `-100…` id. The bot must be an
   * administrator of the channel, otherwise `getChatMember` refuses.
   */
  CLUB_CHANNEL_ID: z.string().default(''),
  /** Public invite link shown to users, e.g. https://t.me/ochkisk. */
  CLUB_CHANNEL_URL: z.string().default(''),

  PAYMENT_PROVIDER: z.enum(['stars', 'provider', 'none']).default('stars'),

  CORS_ORIGINS: csv,
  ADMIN_TELEGRAM_IDS: csv,

  INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().min(0).default(86_400),
  /**
   * How long a membership answer is trusted, in seconds.
   *
   * Kept short: a viewer who just joined the channel expects the club rate on
   * the next screen, not in ten minutes.
   */
  CLUB_MEMBERSHIP_TTL_SECONDS: z.coerce.number().int().min(0).default(60),
  ALLOW_DEV_AUTH: booleanish.default(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;
const isProd = raw.NODE_ENV === 'production';

/**
 * `DATABASE_URL` is relative to this package so the API behaves the same no
 * matter which directory the process was started from.
 */
function resolveSqlitePath(url: string): string {
  if (url === ':memory:') return url;
  const withoutScheme = url.startsWith('file:') ? url.slice(5) : url;
  if (path.isAbsolute(withoutScheme)) return withoutScheme;
  // src/ -> apps/api
  return path.resolve(import.meta.dirname, '..', withoutScheme);
}

/** Bot id is the numeric prefix of the token; needed for third-party checks. */
function botIdFromToken(token: string): number | null {
  const [id] = token.split(':');
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const hasBotToken = raw.TELEGRAM_BOT_TOKEN.length > 0;
const devAuthEnabled = raw.ALLOW_DEV_AUTH && !isProd;

// Production safety rails: these misconfigurations are exploitable.
if (isProd) {
  if (!hasBotToken) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is required in production: initData cannot be verified without it.',
    );
  }
  if (raw.ALLOW_DEV_AUTH) {
    throw new Error(
      'ALLOW_DEV_AUTH must be false in production: it bypasses Telegram signature checks.',
    );
  }
  if (!raw.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error(
      'TELEGRAM_WEBHOOK_SECRET is required in production to authenticate webhook calls.',
    );
  }
  if (raw.PAYMENT_PROVIDER === 'provider' && !raw.TELEGRAM_PROVIDER_TOKEN) {
    throw new Error(
      'PAYMENT_PROVIDER="provider" requires TELEGRAM_PROVIDER_TOKEN.',
    );
  }
  // A configured channel with no invite link, or the reverse, is always a
  // mistake: half the feature works and the other half fails silently — either
  // members get a rate nobody is invited to claim, or the app advertises a
  // channel whose membership is never verified and so charges the same price.
  if (Boolean(raw.CLUB_CHANNEL_ID) !== Boolean(raw.CLUB_CHANNEL_URL)) {
    throw new Error(
      'CLUB_CHANNEL_ID and CLUB_CHANNEL_URL must be set together: one without ' +
        'the other means the club rate is either unclaimable or unverified.',
    );
  }
}

export const config = {
  env: raw.NODE_ENV,
  isProd,
  isDev: raw.NODE_ENV === 'development',
  port: raw.PORT,
  host: raw.HOST,
  logLevel: raw.LOG_LEVEL,

  databaseUrl: resolveSqlitePath(raw.DATABASE_URL),

  telegram: {
    botToken: raw.TELEGRAM_BOT_TOKEN,
    botId: botIdFromToken(raw.TELEGRAM_BOT_TOKEN),
    webhookSecret: raw.TELEGRAM_WEBHOOK_SECRET,
    providerToken: raw.TELEGRAM_PROVIDER_TOKEN,
    apiRoot: raw.TELEGRAM_API_ROOT,
    hasBotToken,
  },

  publicApiUrl: raw.PUBLIC_API_URL.replace(/\/+$/, ''),
  publicAppUrl: raw.PUBLIC_APP_URL.replace(/\/+$/, ''),
  paymentProvider: raw.PAYMENT_PROVIDER,

  /**
   * Club channel. `enabled` is the single question the rest of the code asks:
   * without both an id to verify against and a link to send people to, the
   * feature is off and everyone pays the standard price.
   */
  clubChannel: {
    id: raw.CLUB_CHANNEL_ID,
    url: raw.CLUB_CHANNEL_URL,
    enabled: raw.CLUB_CHANNEL_ID.length > 0,
    membershipTtlMs: raw.CLUB_MEMBERSHIP_TTL_SECONDS * 1000,
  },

  corsOrigins: raw.CORS_ORIGINS,
  adminTelegramIds: new Set(raw.ADMIN_TELEGRAM_IDS),

  initDataMaxAgeSeconds: raw.INIT_DATA_MAX_AGE_SECONDS,
  devAuthEnabled,
} as const;

export type Config = typeof config;
