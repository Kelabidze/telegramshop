import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * The live USDT/RUB rate from Rapira.
 *
 * Against a local server rather than the exchange: these tests need to control what
 * comes back — a missing pair, a zero price, a timeout, a malformed body — and none
 * of that is reachable against the real endpoint. They also have to pass offline.
 *
 * The captured payload below is the real shape, taken from
 * `GET https://api.rapira.net/open/market/rates`, so the parser is checked against
 * what the provider actually sends rather than against an invented schema.
 */

/** One entry of the real response, trimmed to the fields that matter. */
const REAL_USDT_ENTRY = {
  symbol: 'USDT/RUB',
  open: 87.72,
  high: 87.72,
  low: 87.66,
  close: 87.66,
  chg: -0.00068446,
  change: -0.06,
  fee: 0,
  lastDayClose: 87.72,
  usdRate: 1,
  baseUsdRate: 0.0114025,
  askPrice: 87.7,
  bidPrice: 87.67,
  baseCoinScale: 2,
  coinScale: 2,
  quoteCurrencyName: 'Tether',
  baseCurrency: 'RUB',
  quoteCurrency: 'USDT',
};

/** A realistic full body: several pairs, the envelope Rapira wraps them in. */
function realBody(usdt: Record<string, unknown> = REAL_USDT_ENTRY) {
  return {
    code: 0,
    message: null,
    totalPage: null,
    totalElement: null,
    isWorking: 1,
    data: [
      { symbol: 'BTC/RUB', askPrice: 9_500_000, bidPrice: 9_490_000 },
      usdt,
      { symbol: 'ETH/RUB', askPrice: 300_000, bidPrice: 299_000 },
    ],
  };
}

const upstream = {
  status: 200,
  body: realBody() as unknown,
  /** Delay before answering, to force a client timeout. */
  delayMs: 0,
  calls: 0,
};

let server: Server;
let baseUrl = '';

before(async () => {
  server = createServer((_req, res) => {
    upstream.calls += 1;
    const send = () => {
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(upstream.body));
    };
    if (upstream.delayMs > 0) setTimeout(send, upstream.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  process.env.NODE_ENV = 'development';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = 'file:./prisma/dev.db';
  process.env.RAPIRA_ENABLED = 'true';
  process.env.RAPIRA_BASE_URL = baseUrl;
  process.env.RAPIRA_RATE_SIDE = 'ask';
  process.env.RAPIRA_RATE_CACHE_SECONDS = '60';
  process.env.RAPIRA_TIMEOUT_MS = '700';

  rapira = await import('./payments/rapira-rates.ts');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let rapira: typeof import('./payments/rapira-rates.ts');

beforeEach(() => {
  upstream.status = 200;
  upstream.body = realBody();
  upstream.delayMs = 0;
  upstream.calls = 0;
  rapira.resetRateCache();
});

describe('parsing the real Rapira payload', () => {
  it('finds USDT/RUB among the other pairs and reads askPrice', () => {
    // 87.70 -> 8770 kopecks per USDT.
    assert.equal(rapira.parseRatesResponse(realBody(), 'ask'), 8_770);
  });

  it('reads bidPrice when configured for the other side', () => {
    assert.equal(rapira.parseRatesResponse(realBody(), 'bid'), 8_767);
  });

  it('does not confuse another pair for USDT/RUB', () => {
    // BTC/RUB comes first in the array. Taking `data[0]` would price everything
    // off Bitcoin.
    const rate = rapira.parseRatesResponse(realBody(), 'ask');
    assert.equal(rate, 8_770);
    assert.notEqual(rate, 950_000_000);
  });

  it('rejects a body with no USDT/RUB pair', () => {
    const body = { code: 0, data: [{ symbol: 'BTC/RUB', askPrice: 1 }] };
    assert.throws(() => rapira.parseRatesResponse(body, 'ask'), /USDT\/RUB/);
  });

  it('rejects a zero or negative rate instead of dividing by it', () => {
    for (const askPrice of [0, -1, -87.7]) {
      assert.throws(
        () => rapira.parseRatesResponse(realBody({ symbol: 'USDT/RUB', askPrice }), 'ask'),
        /not positive/,
      );
    }
  });

  it('rejects a non-numeric or absent rate', () => {
    for (const askPrice of ['87.7', null, undefined, NaN, Infinity]) {
      assert.throws(
        () =>
          rapira.parseRatesResponse(
            realBody({ symbol: 'USDT/RUB', askPrice }),
            'ask',
          ),
        /finite number/,
      );
    }
  });

  it('rejects a body that is not the expected envelope', () => {
    for (const body of [null, 'text', 42, {}, { data: 'nope' }]) {
      assert.throws(() => rapira.parseRatesResponse(body, 'ask'));
    }
  });
});

describe('decimal safety', () => {
  it('converts a decimal string to minor units exactly', () => {
    assert.equal(rapira.decimalStringToMinor('87.70'), 8_770);
    assert.equal(rapira.decimalStringToMinor('94.78'), 9_478);
    assert.equal(rapira.decimalStringToMinor('100'), 10_000);
    assert.equal(rapira.decimalStringToMinor('0.07'), 7);
  });

  it('avoids the float drift that multiplication would introduce', () => {
    /*
     * `0.07 * 100` is 7.000000000000001 and `1.005 * 100` is 100.49999999999999 in
     * binary floating point. Money must not be computed that way, so the conversion
     * works on the digits instead.
     */
    assert.equal(0.07 * 100 === 7, false, 'premise: float multiplication drifts');
    assert.equal(rapira.decimalStringToMinor('0.07'), 7);
    assert.equal(rapira.decimalStringToMinor('1.005'), 101, 'half-up on the dropped digit');
  });

  it('rounds half-up rather than truncating a more precise quote', () => {
    // A rate quoted to more places than we keep must not silently lose value.
    assert.equal(rapira.decimalStringToMinor('87.705'), 8_771);
    assert.equal(rapira.decimalStringToMinor('87.704'), 8_770);
  });

  it('refuses malformed input rather than coercing it', () => {
    for (const bad of ['', 'abc', '-1', '1.2.3', ' 87.7', '8e2']) {
      assert.throws(() => rapira.decimalStringToMinor(bad), /Malformed decimal/);
    }
  });
});

describe('fetching and caching', () => {
  it('fetches the rate and reports its provenance', async () => {
    const quote = await rapira.getUsdtRubRate();
    assert.equal(quote.rateRubMinorPerUnit, 8_770);
    assert.equal(quote.source, 'RAPIRA');
    assert.equal(quote.side, 'ask');
    assert.ok(quote.fetchedAt instanceof Date);
  });

  it('serves a second call from cache', async () => {
    await rapira.getUsdtRubRate();
    assert.equal(upstream.calls, 1);

    await rapira.getUsdtRubRate();
    await rapira.getUsdtRubRate();
    // The rate is a price: every checkout in the same minute must quote the same
    // number, and the exchange should not be asked once per buyer.
    assert.equal(upstream.calls, 1);
  });

  it('shares one request between concurrent callers', async () => {
    // A burst on a cold cache must not become a burst upstream — nor produce two
    // slightly different rates for two simultaneous checkouts.
    const [a, b, c] = await Promise.all([
      rapira.getUsdtRubRate(),
      rapira.getUsdtRubRate(),
      rapira.getUsdtRubRate(),
    ]);
    assert.equal(upstream.calls, 1);
    assert.equal(a.rateRubMinorPerUnit, b.rateRubMinorPerUnit);
    assert.equal(b.rateRubMinorPerUnit, c.rateRubMinorPerUnit);
  });

  it('refetches once the cache has expired', async () => {
    // A 20 ms TTL, so expiry happens inside the test.
    await rapira.getUsdtRubRate(20);
    assert.equal(upstream.calls, 1);

    // Move the market and wait out the TTL.
    upstream.body = realBody({ symbol: 'USDT/RUB', askPrice: 96.0 });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const second = await rapira.getUsdtRubRate(20);
    assert.equal(upstream.calls, 2);
    assert.equal(second.rateRubMinorPerUnit, 9_600, 'must pick up the new rate');
  });

  it('reports a cached rate without contacting the exchange', async () => {
    assert.equal(rapira.getCachedUsdtRubRate(), null, 'nothing cached yet');
    await rapira.getUsdtRubRate();
    const cached = rapira.getCachedUsdtRubRate();
    assert.equal(cached?.rateRubMinorPerUnit, 8_770);
    assert.equal(upstream.calls, 1);
  });
});

describe('failure handling', () => {
  it('fails loudly rather than inventing a rate', async () => {
    upstream.status = 502;
    await assert.rejects(
      () => rapira.getUsdtRubRate(),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'RATE_UNAVAILABLE');
        return true;
      },
    );
  });

  it('fails on a timeout', async () => {
    upstream.delayMs = 1_500; // longer than RAPIRA_TIMEOUT_MS
    await assert.rejects(
      () => rapira.getUsdtRubRate(),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'RATE_UNAVAILABLE');
        return true;
      },
    );
  });

  it('fails on a malformed body rather than guessing', async () => {
    upstream.body = { code: 0, data: [] };
    // Asserted on the code, not the message: the message is buyer-facing Russian
    // prose and matching it would make the test brittle to a copy change.
    await assert.rejects(
      () => rapira.getUsdtRubRate(),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'RATE_UNAVAILABLE');
        return true;
      },
    );
  });

  it('does not serve a stale rate once the cache has expired', async () => {
    /*
     * The policy that matters: "the rate is unknown" and "the rate is what it was
     * ten minutes ago" are different statements, and quoting the second as if it
     * were the first means charging a price nobody agreed to.
     */
    const first = await rapira.getUsdtRubRate(20);
    assert.equal(first.rateRubMinorPerUnit, 8_770);

    upstream.status = 503;
    await new Promise((resolve) => setTimeout(resolve, 40));

    await assert.rejects(
      () => rapira.getUsdtRubRate(20),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'RATE_UNAVAILABLE');
        return true;
      },
    );
    // And the expired entry is not offered as "cached" either.
    assert.equal(rapira.getCachedUsdtRubRate(), null);
  });

  it('recovers on the next call once the exchange returns', async () => {
    upstream.status = 500;
    await assert.rejects(() => rapira.getUsdtRubRate());

    upstream.status = 200;
    const quote = await rapira.getUsdtRubRate();
    assert.equal(quote.rateRubMinorPerUnit, 8_770);
  });

  it('does not leave a failed fetch blocking later callers', async () => {
    // The in-flight promise must be cleared on failure, or every subsequent call
    // would await a request that already rejected.
    upstream.status = 500;
    await assert.rejects(() => rapira.getUsdtRubRate());
    await assert.rejects(() => rapira.getUsdtRubRate());

    upstream.status = 200;
    const quote = await rapira.getUsdtRubRate();
    assert.equal(quote.rateRubMinorPerUnit, 8_770);
  });
});

