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

/**
 * Normalises a credential read from an environment file.
 *
 * The shop is edited on Windows and deployed to a systemd unit whose
 * `EnvironmentFile` is NOT a dotenv parser. A value written in dotenv style
 * (`KEY="pk_live_…"`) keeps its quotes, because systemd does not strip them the way
 * a dotenv loader would — and the key then goes out as `X-Api-Key: "pk_live_…"`,
 * which Cashera rejects as unknown. That surfaces as a 401 while `/health` still
 * reports the rail enabled, since it only checks that the value is non-empty.
 *
 * Trimming matters for a different reason than the quotes, and it is worth being
 * precise about which is which: a trailing `\r` on the *key* would not have reached
 * the wire at all, because Node trims trailing whitespace from header values before
 * sending. The secret is what trimming really protects — it is compared
 * byte-for-byte against Cashera's `X-Secret` in `secretsMatch`, with no header
 * normalisation in between, so a CRLF-edited `api.env` would fail webhook
 * authentication while looking correctly configured.
 *
 * Both operations are no-ops for a clean value, and a Cashera credential never
 * legitimately contains surrounding quotes or edge whitespace.
 */
const secret = z
  .string()
  .default('')
  .transform((v) => {
    let s = v.trim();
    if (s.length >= 2) {
      const first = s[0];
      const last = s[s.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        s = s.slice(1, -1).trim();
      }
    }
    return s;
  });

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

  /**
   * Where uploaded banner and product media is stored.
   *
   * Must live OUTSIDE the release directory: deploys replace `current` and prune
   * old releases, so anything written there disappears. In production this is
   * `/srv/shop/shared/uploads`, the one path the systemd unit grants write
   * access to and the one that survives a deploy.
   *
   * Left empty on purpose — the default is derived below, because a relative
   * default resolved into the release directory, which systemd mounts read-only
   * (`ProtectSystem=strict` + `ReadWritePaths=/srv/shop/shared`). Creating it
   * there failed with EROFS and took the whole process down on boot.
   */
  UPLOADS_DIR: z.string().default(''),

  PAYMENT_PROVIDER: z.enum(['stars', 'provider', 'none']).default('stars'),

  // ---- pricing -------------------------------------------------------------
  /**
   * Fallback RUB per 1 USDT, used only when no live rate is configured.
   *
   * The live rate comes from Rapira (see `RAPIRA_*` below). This remains as the
   * value used when `RAPIRA_ENABLED=false` — a deliberately explicit switch, so a
   * shop running without the exchange still has a defined rate rather than an
   * accidental one.
   */
  USDT_RUB_RATE: z.coerce.number().int().min(1).max(100_000).default(86),

  // ---- live rate (Rapira) --------------------------------------------------
  /** Off means USDT prices use the fixed `USDT_RUB_RATE` above. */
  RAPIRA_ENABLED: booleanish.default(true),
  RAPIRA_BASE_URL: z.string().default('https://api.rapira.net'),
  /**
   * Which side of the order book to price from.
   *
   * `ask` by default: it is what someone buying USDT would pay, so pricing from it
   * means the shop is not quoting a rate better than the one it could actually
   * transact at.
   */
  RAPIRA_RATE_SIDE: z.enum(['ask', 'bid']).default('ask'),
  /**
   * How long a fetched rate stays usable.
   *
   * Short, because the number is a price. Long enough that a burst of checkouts
   * does not become a burst of upstream requests, and that all of them quote the
   * same rate.
   */
  RAPIRA_RATE_CACHE_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(60),
  RAPIRA_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  /**
   * RUB per 1 Telegram Star, in kopecks.
   *
   * Kopecks rather than roubles because one Star is worth well under a rouble,
   * so a whole-rouble rate could not express it. 130 = 1.30 ₽ per Star, which is
   * the order of magnitude Telegram's own Stars pricing sits at.
   */
  STAR_RUB_MINOR_RATE: z.coerce.number().int().min(1).max(1_000_000).default(130),

  // ---- on-chain payments ---------------------------------------------------
  /** Master switch. Off means the API refuses to create USDT intents at all. */
  CRYPTO_PAYMENTS_ENABLED: booleanish.default(false),
  /**
   * Watch-only extended public key for the deposit account, e.g. the xpub of
   * `m/44'/60'/0'/0`.
   *
   * Public material by design: it derives addresses and nothing else. The
   * mnemonic that produced it must never reach this process — only the separate
   * sweep component needs signing capability, and that is a later phase.
   */
  CRYPTO_DEPOSIT_XPUB: z.string().default(''),
  /** Path the xpub corresponds to. Recorded on each wallet for future signing. */
  CRYPTO_DERIVATION_BASE_PATH: z.string().default("m/44'/60'/0'/0"),
  /** BEP20 USDT contract. Overridable for testnet, not for convenience. */
  USDT_CONTRACT_ADDRESS: z
    .string()
    .default('0x55d398326f99059fF775485246999027B3197955'),
  BSC_RPC_URL: z.string().default('https://bsc-dataseed.binance.org'),
  /** Second, independent endpoint. Every RPC call falls back to it. */
  BSC_RPC_FALLBACK_URL: z.string().default('https://bsc-rpc.publicnode.com'),
  /** How long a buyer has to send funds, in minutes. */
  CRYPTO_PAYMENT_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /** Seconds between monitor passes. 0 disables the in-process monitor. */
  CRYPTO_MONITOR_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(15),
  /**
   * Largest block range asked for in one `eth_getLogs`.
   *
   * Public BSC endpoints reject wide ranges, and a rejected range is a range
   * whose logs were never seen.
   */
  CRYPTO_SCAN_WINDOW_BLOCKS: z.coerce
    .number()
    .int()
    .min(1)
    .max(50_000)
    .default(2_000),
  /**
   * Blocks of slack behind the finalised head when a new address is issued.
   *
   * A buyer cannot pay before the address exists, so scanning from slightly
   * before creation is enough — and far cheaper than scanning from genesis.
   */
  CRYPTO_SCAN_START_LAG_BLOCKS: z.coerce
    .number()
    .int()
    .min(0)
    .max(100_000)
    .default(200),
  /**
   * Fallback confirmation depth, used ONLY if an RPC cannot answer the
   * `finalized` tag.
   *
   * Not the primary mechanism: BSC has fast finality and both configured
   * endpoints serve `finalized`, so this is a safety net rather than business
   * logic. Deliberately deeper than the exchanger's 6 — if the precise signal is
   * unavailable, the honest response is to wait longer, not to guess.
   */
  CRYPTO_FALLBACK_CONFIRMATIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(45),
  /** Where swept funds are destined. Sweeping is a later phase. */
  CRYPTO_TREASURY_ADDRESS: z.string().default(''),

  // ---- Cashera (external gateway, RUB) -------------------------------------
  /**
   * Credentials for the gateway. Server-side only.
   *
   * `CASHERA_API_SECRET` authenticates *inbound* webhooks — it is compared against
   * the `X-Secret` header — and is never sent anywhere. It must not be logged, and
   * `server.ts` redacts it.
   */
  CASHERA_API_KEY: secret,
  CASHERA_API_SECRET: secret,
  CASHERA_BASE_URL: z.string().default('https://api.cashera.cash/api/v1'),
  /**
   * Which Cashera method to charge with, e.g. `sbp` or `card`.
   *
   * Configuration rather than a literal in the checkout path: the set a merchant
   * may use is decided in Cashera's dashboard, not in this code, and one shop
   * changing method should not need a deploy.
   */
  CASHERA_PAYMENT_METHOD: z.string().default('sbp'),
  /**
   * Which method the crypto rail asks for.
   *
   * `crypto` is Cashera's own code for "pay in cryptocurrency" — the buyer picks the
   * coin and network on Cashera's page, and the invoice is still denominated in RUB.
   * This shop never names a coin.
   *
   * Empty string means the opposite approach: omit `payment_method` altogether and
   * use Cashera's common payment form, where the buyer chooses from every method the
   * merchant has enabled. That is the widest official flow, but it also offers card
   * and SBP alongside crypto, so it is opt-in rather than the default.
   */
  CASHERA_CRYPTO_PAYMENT_METHOD: z.string().default('crypto'),
  /** Per-request timeout, milliseconds. */
  CASHERA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),

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

/**
 * Where uploads live, defaulting next to the database rather than to the code.
 *
 * The database is already required to sit on writable storage that survives a
 * deploy — in production `/srv/shop/shared/data/prod.db`. Uploads need exactly
 * the same guarantees, so deriving their location from it means a server whose
 * `api.env` predates this feature (and therefore has no `UPLOADS_DIR`) still
 * gets a working, writable path instead of one inside the read-only release.
 *
 * That is not hypothetical: `setup-server.sh` never rewrites an existing
 * `api.env`, so every already-provisioned server lacks the variable.
 */
function resolveUploadsDir(configured: string, databaseUrl: string): string {
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(import.meta.dirname, '..', configured);
  }

  const dbPath = resolveSqlitePath(databaseUrl);
  if (dbPath !== ':memory:' && path.isAbsolute(dbPath)) {
    // .../shared/data/prod.db -> .../shared/uploads
    return path.resolve(path.dirname(dbPath), '..', 'uploads');
  }

  // In-memory database (tests): anywhere writable will do.
  return path.resolve(import.meta.dirname, '..', 'uploads');
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
  // Crypto checkout without a derivation key would quote an amount and then have
  // nowhere to receive it: better to refuse at boot than to sell to a void.
  if (raw.CRYPTO_PAYMENTS_ENABLED && !raw.CRYPTO_DEPOSIT_XPUB) {
    throw new Error(
      'CRYPTO_PAYMENTS_ENABLED=true requires CRYPTO_DEPOSIT_XPUB: deposit ' +
        'addresses cannot be derived without it.',
    );
  }
}

/**
 * A private key or mnemonic in this process is a configuration error, not a
 * feature. The API only ever needs the watch-only key, so anything that can
 * spend must be rejected loudly rather than quietly used.
 */
if (raw.CRYPTO_DEPOSIT_XPUB) {
  const material = raw.CRYPTO_DEPOSIT_XPUB.trim();
  if (material.startsWith('xprv') || material.startsWith('yprv') || material.startsWith('zprv')) {
    throw new Error(
      'CRYPTO_DEPOSIT_XPUB holds an EXTENDED PRIVATE key. The API must never ' +
        'hold spending capability — supply the watch-only xpub instead.',
    );
  }
  if (material.split(/\s+/).length >= 12) {
    throw new Error(
      'CRYPTO_DEPOSIT_XPUB looks like a mnemonic phrase. The API must never ' +
        'hold spending capability — supply the watch-only xpub instead.',
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

  uploadsDir: resolveUploadsDir(raw.UPLOADS_DIR, raw.DATABASE_URL),

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

  /**
   * Rates used to derive payable prices from the RUB base price.
   *
   * Both in RUB minor units per one unit of the target currency, so every
   * conversion is `rubMinor / rate` — one direction, no chance of inverting one.
   */
  rates: {
    /**
     * Fallback only. The live USDT rate comes from `payments/rapira-rates.ts`;
     * this value is what a shop with `RAPIRA_ENABLED=false` prices at.
     */
    usdtRubMinorPerUnit: raw.USDT_RUB_RATE * 100,
    starRubMinorPerUnit: raw.STAR_RUB_MINOR_RATE,
  },

  rapira: {
    enabled: raw.RAPIRA_ENABLED,
    baseUrl: raw.RAPIRA_BASE_URL.replace(/\/+$/, ''),
    side: raw.RAPIRA_RATE_SIDE,
    cacheMs: raw.RAPIRA_RATE_CACHE_SECONDS * 1000,
    timeoutMs: raw.RAPIRA_TIMEOUT_MS,
  },

  cashera: {
    /**
     * Both credentials are required. The key alone could create transactions but
     * could not authenticate the webhook that reports them paid, which would mean
     * taking money with no way to recognise it — worse than not offering the rail.
     */
    enabled:
      raw.CASHERA_API_KEY.length > 0 && raw.CASHERA_API_SECRET.length > 0,
    apiKey: raw.CASHERA_API_KEY,
    apiSecret: raw.CASHERA_API_SECRET,
    baseUrl: raw.CASHERA_BASE_URL.replace(/\/+$/, ''),
    paymentMethod: raw.CASHERA_PAYMENT_METHOD,
    /**
     * `null` when the variable is blank, meaning "use the common payment form".
     *
     * Normalised here rather than at the call site so the distinction between "ask
     * for the crypto method" and "let Cashera present every enabled method" is made
     * once, in the place that reads configuration.
     */
    cryptoPaymentMethod: raw.CASHERA_CRYPTO_PAYMENT_METHOD.trim() || null,
    timeoutMs: raw.CASHERA_TIMEOUT_MS,
  },

  crypto: {
    /**
     * Single question the rest of the code asks. Both parts are required: the
     * switch alone cannot issue addresses, and a key alone should not start
     * taking payments nobody turned on.
     */
    enabled: raw.CRYPTO_PAYMENTS_ENABLED && raw.CRYPTO_DEPOSIT_XPUB.length > 0,
    depositXpub: raw.CRYPTO_DEPOSIT_XPUB,
    derivationBasePath: raw.CRYPTO_DERIVATION_BASE_PATH,
    usdtContract: raw.USDT_CONTRACT_ADDRESS,
    rpcUrls: [raw.BSC_RPC_URL, raw.BSC_RPC_FALLBACK_URL].filter(
      (url, index, all) => url.length > 0 && all.indexOf(url) === index,
    ),
    paymentTtlMs: raw.CRYPTO_PAYMENT_TTL_MINUTES * 60 * 1000,
    monitorIntervalMs: raw.CRYPTO_MONITOR_INTERVAL_SECONDS * 1000,
    scanWindowBlocks: raw.CRYPTO_SCAN_WINDOW_BLOCKS,
    scanStartLagBlocks: raw.CRYPTO_SCAN_START_LAG_BLOCKS,
    fallbackConfirmations: raw.CRYPTO_FALLBACK_CONFIRMATIONS,
    treasuryAddress: raw.CRYPTO_TREASURY_ADDRESS,
  },

  corsOrigins: raw.CORS_ORIGINS,
  adminTelegramIds: new Set(raw.ADMIN_TELEGRAM_IDS),

  initDataMaxAgeSeconds: raw.INIT_DATA_MAX_AGE_SECONDS,
  devAuthEnabled,
} as const;

export type Config = typeof config;
