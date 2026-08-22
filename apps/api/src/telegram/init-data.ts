import { createHmac, timingSafeEqual } from 'node:crypto';
import { initDataSchema, type InitData } from '@shop/shared';

/**
 * Telegram Mini App `initData` verification.
 *
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 *   secret_key       = HMAC_SHA256(key="WebAppData", message=<bot_token>)
 *   data_check_string= all params except `hash`, as "k=v", sorted, joined by "\n"
 *   expected         = hex(HMAC_SHA256(key=secret_key, message=data_check_string))
 *
 * Two details that are commonly implemented incorrectly:
 *  1. Only `hash` is excluded from the check string. The newer `signature`
 *     field IS included; dropping it makes every real launch fail to verify.
 *  2. Values must be used exactly as received (already percent-decoded once by
 *     URLSearchParams). Re-encoding or re-ordering breaks the digest.
 */

export type InitDataFailureReason =
  | 'EMPTY'
  | 'MALFORMED'
  | 'MISSING_HASH'
  | 'MISSING_AUTH_DATE'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NO_BOT_TOKEN';

export class InitDataError extends Error {
  readonly reason: InitDataFailureReason;

  constructor(reason: InitDataFailureReason, message: string) {
    super(message);
    this.name = 'InitDataError';
    this.reason = reason;
  }
}

/** Constant-time comparison of two hex digests. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** HMAC-SHA256 secret key derived from the bot token. */
function deriveSecretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

function buildDataCheckString(params: URLSearchParams): string {
  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key === 'hash') return; // excluded; `signature` is NOT excluded
    pairs.push(`${key}=${value}`);
  });
  return pairs.sort().join('\n');
}

/** Computes the expected hash for a raw initData query string. */
export function signInitData(rawInitData: string, botToken: string): string {
  const params = new URLSearchParams(rawInitData);
  return createHmac('sha256', deriveSecretKey(botToken))
    .update(buildDataCheckString(params))
    .digest('hex');
}

export interface VerifyInitDataOptions {
  botToken: string;
  /** Reject data older than this. 0 disables the age check. */
  maxAgeSeconds?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Verifies `initData` and returns the parsed payload.
 * Throws `InitDataError` on any failure. Never returns partially trusted data.
 */
export function verifyInitData(
  rawInitData: string,
  options: VerifyInitDataOptions,
): InitData {
  const { botToken, maxAgeSeconds = 86_400, now = Date.now } = options;

  if (!botToken) {
    throw new InitDataError('NO_BOT_TOKEN', 'Bot token is not configured.');
  }
  if (!rawInitData || rawInitData.trim() === '') {
    throw new InitDataError('EMPTY', 'initData is empty.');
  }

  const params = new URLSearchParams(rawInitData);

  const hash = params.get('hash');
  if (!hash) {
    throw new InitDataError('MISSING_HASH', 'initData has no "hash" field.');
  }

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw) {
    throw new InitDataError(
      'MISSING_AUTH_DATE',
      'initData has no "auth_date" field.',
    );
  }
  const authDate = Number.parseInt(authDateRaw, 10);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new InitDataError(
      'MISSING_AUTH_DATE',
      `initData has an invalid "auth_date": ${authDateRaw}`,
    );
  }

  // Verify the signature BEFORE trusting any field, including auth_date.
  const expected = createHmac('sha256', deriveSecretKey(botToken))
    .update(buildDataCheckString(params))
    .digest('hex');

  if (!hexEqual(expected, hash)) {
    throw new InitDataError(
      'BAD_SIGNATURE',
      'initData signature does not match; data is not from Telegram.',
    );
  }

  if (maxAgeSeconds > 0) {
    const ageSeconds = Math.floor(now() / 1000) - authDate;
    if (ageSeconds > maxAgeSeconds) {
      throw new InitDataError(
        'EXPIRED',
        `initData is ${ageSeconds}s old, which exceeds the ${maxAgeSeconds}s limit.`,
      );
    }
  }

  // Complex fields arrive as JSON strings.
  const record: Record<string, unknown> = {};
  params.forEach((value, key) => {
    record[key] = value;
  });

  for (const key of ['user', 'receiver'] as const) {
    const value = record[key];
    if (typeof value === 'string') {
      try {
        record[key] = JSON.parse(value);
      } catch {
        throw new InitDataError(
          'MALFORMED',
          `initData field "${key}" is not valid JSON.`,
        );
      }
    }
  }
  if (typeof record.auth_date === 'string') {
    record.auth_date = Number.parseInt(record.auth_date, 10);
  }

  const result = initDataSchema.safeParse(record);
  if (!result.success) {
    throw new InitDataError(
      'MALFORMED',
      `initData does not match the expected shape: ${result.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    );
  }

  return result.data;
}

/** Non-throwing variant. */
export function isInitDataValid(
  rawInitData: string,
  options: VerifyInitDataOptions,
): boolean {
  try {
    verifyInitData(rawInitData, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test helper: produces a correctly signed initData string.
 * Exported so tests never hardcode digests.
 */
export function createSignedInitData(
  fields: Record<string, string | number | object>,
  botToken: string,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(
      key,
      typeof value === 'object' ? JSON.stringify(value) : String(value),
    );
  }
  params.delete('hash');
  params.set('hash', signInitData(params.toString(), botToken));
  return params.toString();
}
