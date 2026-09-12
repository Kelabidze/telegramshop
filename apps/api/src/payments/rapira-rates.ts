import { config } from '../config.js';
import { AppError } from '../errors.js';

/**
 * Live USDT/RUB rate from Rapira.
 *
 * Replaces the fixed 86 в‚Ѕ/USDT that stood in for a real rate. The shop still
 * prices everything in roubles вЂ” this only decides how many USDT that is at the
 * moment a payment is opened.
 *
 * Two rules shape the whole module:
 *
 *  1. **The rate is fixed at payment creation and never recomputed.** An order
 *     quoted at 94.78 stays quoted at 94.78 even if the market moves a minute
 *     later, because the buyer is paying a number they were shown.
 *  2. **An unknown rate is an error, not a guess.** If Rapira is unreachable and
 *     the cache has expired, USDT checkout is refused. Quoting a stale or invented
 *     rate would mean charging a price nobody agreed to вЂ” and roubles and Stars
 *     keep working regardless, so refusing costs one rail rather than the shop.
 */

const RATES_PATH = '/open/market/rates';
const SYMBOL = 'USDT/RUB';

export interface RateQuote {
  /**
   * RUB kopecks per 1 USDT, as an integer.
   *
   * The same unit the order snapshot already uses (`rateRubMinorPerUnit`), so the
   * live rate drops into the existing pricing maths without a new representation.
   */
  rateRubMinorPerUnit: number;
  source: 'RAPIRA';
  /** Which side of the book was taken. */
  side: 'ask' | 'bid';
  /** When this quote was fetched, not when it was used. */
  fetchedAt: Date;
}

interface CacheEntry {
  quote: RateQuote;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
/**
 * In-flight fetch, shared by concurrent callers.
 *
 * Without this, a burst of checkouts arriving on a cold cache would each open
 * their own request to Rapira вЂ” and could each get a slightly different rate,
 * which is exactly the kind of inconsistency the cache exists to prevent.
 */
let inFlight: Promise<RateQuote> | null = null;

/**
 * Decimal string -> integer minor units, exactly.
 *
 * Not `value * 100`: binary floating point makes that drift (0.07 Г— 100 is
 * 7.000000000000001, and 1.005 Г— 100 is 100.49999999999999). Splitting the
 * decimal string and padding is exact for any input the API can produce.
 */
export function decimalStringToMinor(text: string, exponent = 2): number {
  // Validated as given, NOT trimmed first. Trimming before the check would accept
  // " 87.7" вЂ” and silently tolerating stray whitespace in a price is how a
  // malformed upstream field turns into a plausible-looking rate.
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Malformed decimal: ${JSON.stringify(text)}`);
  }

  const [whole, fraction = ''] = text.split('.');
  // Round half-up on the first dropped digit, so a rate quoted with more
  // precision than we keep does not silently truncate downwards.
  const kept = fraction.slice(0, exponent).padEnd(exponent, '0');
  const nextDigit = fraction.charCodeAt(exponent) - 48;
  const base = Number(`${whole}${kept}`);
  const rounded = nextDigit >= 5 ? base + 1 : base;

  if (!Number.isSafeInteger(rounded)) {
    throw new Error(`Decimal out of safe range: ${text}`);
  }
  return rounded;
}

/**
 * A JSON number back to the digits it was written with.
 *
 * `JSON.parse` has already turned the rate into a float by the time we see it, so
 * this recovers a decimal string from it. `toFixed` is the right tool: it formats
 * from the shortest round-trip representation, so 87.7 becomes "87.70" rather than
 * anything ending in stray binary noise.
 */
function numberToDecimalString(value: number, exponent = 2): string {
  return value.toFixed(exponent);
}

interface RapiraRate {
  symbol?: unknown;
  askPrice?: unknown;
  bidPrice?: unknown;
}

/**
 * Picks USDT/RUB out of the response and reads the configured side.
 *
 * Exported for tests: the parsing is the part most likely to break when a provider
 * changes a field, so it is checked directly against captured payloads.
 */
export function parseRatesResponse(
  body: unknown,
  side: 'ask' | 'bid',
): number {
  if (!body || typeof body !== 'object') {
    throw new Error('Rate response was not an object');
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error('Rate response had no data array');
  }

  const entry = (data as RapiraRate[]).find(
    (row) => typeof row?.symbol === 'string' && row.symbol === SYMBOL,
  );
  if (!entry) {
    throw new Error(`Rate response did not contain ${SYMBOL}`);
  }

  const raw = side === 'ask' ? entry.askPrice : entry.bidPrice;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`${SYMBOL} ${side}Price was not a finite number`);
  }
  // A zero or negative rate would divide badly and price everything at nothing.
  if (raw <= 0) {
    throw new Error(`${SYMBOL} ${side}Price was not positive: ${raw}`);
  }

  const minor = decimalStringToMinor(numberToDecimalString(raw));
  if (minor <= 0) {
    throw new Error(`${SYMBOL} ${side}Price rounded to zero`);
  }
  return minor;
}

async function fetchQuote(): Promise<RateQuote> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.rapira.timeoutMs);

  try {
    const response = await fetch(`${config.rapira.baseUrl}${RATES_PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = (await response.json()) as unknown;
    const rateRubMinorPerUnit = parseRatesResponse(body, config.rapira.side);

    return {
      rateRubMinorPerUnit,
      source: 'RAPIRA',
      side: config.rapira.side,
      fetchedAt: new Date(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The current rate, from cache when it is fresh.
 *
 * On failure with an expired cache this throws rather than falling back to the last
 * known value: "the rate is unknown" and "the rate is what it was ten minutes ago"
 * are different statements, and only one of them is true.
 */
export async function getUsdtRubRate(
  // Overridable so the cache's own behaviour is testable: `config` is frozen at
  // import time, so a test cannot otherwise shorten the TTL. Production never
  // passes it.
  cacheMs = config.rapira.cacheMs,
): Promise<RateQuote> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.quote;
  }

  // Join the request already in flight instead of starting a second one.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const quote = await fetchQuote();
      cache = {
        quote,
        expiresAt: Date.now() + cacheMs,
      };
      return quote;
    } finally {
      inFlight = null;
    }
  })();

  try {
    return await inFlight;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Technical detail for the journal; the buyer gets the message below. No
    // credentials are involved вЂ” this endpoint is public.
    throw new AppError(
      'RATE_UNAVAILABLE',
      'РљСѓСЂСЃ USDT РІСЂРµРјРµРЅРЅРѕ РЅРµРґРѕСЃС‚СѓРїРµРЅ. РџРѕРїСЂРѕР±СѓР№С‚Рµ РїРѕР·Р¶Рµ РёР»Рё РІС‹Р±РµСЂРёС‚Рµ РґСЂСѓРіРѕР№ СЃРїРѕСЃРѕР± РѕРїР»Р°С‚С‹.',
      { reason },
    );
  }
}

/**
 * The rate if one is already known, without contacting Rapira.
 *
 * For places that would like to show a rate but must not fail without one вЂ” the
 * admin product form is the case that matters: saving a rouble price cannot depend
 * on an exchange being reachable.
 */
export function getCachedUsdtRubRate(): RateQuote | null {
  if (cache && cache.expiresAt > Date.now()) return cache.quote;
  return null;
}

/** Test seam. */
export function resetRateCache(): void {
  cache = null;
  inFlight = null;
}
