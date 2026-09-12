import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * Cashera: transaction creation, webhook handling, and settlement.
 *
 * The gateway is a local HTTP server rather than the real one. These tests need to
 * control what it answers — 401, 422, 429, a lost response, a duplicate — and none
 * of that is reachable against production credentials. They also must pass offline
 * and must never move real money.
 *
 * Env is assigned before any local import because `config.ts` reads `process.env`
 * at module load.
 */

const workDir = mkdtempSync(path.join(tmpdir(), 'shop-cashera-test-'));
const dbFile = path.join(workDir, 'test.db');
const apiRoot = path.resolve(import.meta.dirname, '..');

const BOT_TOKEN = '424242:AAH-integration-test-token';
const API_KEY = 'test-api-key-value';
const API_SECRET = 'test-api-secret-value';

/** What the fake gateway does next. Mutated per test. */
const gateway = {
  status: 201,
  /** null means "hang up", to simulate a lost response. */
  body: null as unknown,
  requests: [] as { path: string; method: string; headers: Record<string, string | undefined>; body: unknown }[],
  /** Fails this many times before succeeding, for retry tests. */
  failTimes: 0,
  failStatus: 502,
};

let server: Server;
let gatewayUrl = '';

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      gateway.requests.push({
        path: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers as Record<string, string | undefined>,
        body: parsed,
      });

      if (gateway.failTimes > 0) {
        gateway.failTimes -= 1;
        res.writeHead(gateway.failStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'temporary' }));
        return;
      }

      res.writeHead(gateway.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(gateway.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  gatewayUrl = `http://127.0.0.1:${port}`;

  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.UPLOADS_DIR = path.join(workDir, 'uploads');
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.PAYMENT_PROVIDER = 'none';
  process.env.ALLOW_DEV_AUTH = 'false';
  process.env.LOG_LEVEL = 'silent';
  process.env.CORS_ORIGINS = '';
  process.env.ADMIN_TELEGRAM_IDS = '';
  process.env.TELEGRAM_API_ROOT = 'http://127.0.0.1:9';
  process.env.CASHERA_API_KEY = API_KEY;
  process.env.CASHERA_API_SECRET = API_SECRET;
  process.env.CASHERA_BASE_URL = gatewayUrl;
  process.env.CASHERA_PAYMENT_METHOD = 'sbp';
  process.env.CASHERA_CRYPTO_PAYMENT_METHOD = 'crypto';
  // Short, so retry tests do not take seconds.
  process.env.CASHERA_TIMEOUT_MS = '1500';
  process.env.PUBLIC_API_URL = 'https://shop.example';
  process.env.PUBLIC_APP_URL = 'https://app.example';

  execFileSync('npx', ['prisma', 'db', 'push', '--url', `file:${dbFile}`], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  ({ createSignedInitData } = await import('./telegram/init-data.ts'));
  ({ prisma } = await import('./db.ts'));
  cashera = await import('./services/cashera-payments.ts');
  orders = await import('./services/orders.ts');
  const { buildServer } = await import('./server.ts');
  app = await buildServer();
  await app.ready();

  const category = await prisma.category.create({
    data: { slug: 'card', title: 'Card', sortOrder: 1 },
  });
  // 499 ₽ = 49900 kopecks, the example from the integration brief.
  const product = await prisma.product.create({
    data: {
      slug: 'card-item',
      title: 'Card Item',
      description: '',
      amountMinor: 49_900,
      currency: 'RUB',
      fulfillmentKind: 'LICENSE_KEY',
      categoryId: category.id,
    },
  });
  productId = product.id;
  await prisma.licenseKey.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({
      productId: product.id,
      secret: `CARD-KEY-${i + 1}`,
    })),
  });
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

let app: Awaited<ReturnType<typeof import('./server.ts')['buildServer']>>;
let prisma: typeof import('./db.ts')['prisma'];
let cashera: typeof import('./services/cashera-payments.ts');
let orders: typeof import('./services/orders.ts');
let createSignedInitData: typeof import('./telegram/init-data.ts')['createSignedInitData'];
let productId = '';

const BUYER = 800_100;
let buyerSeq = 0;

function auth(telegramId: number): string {
  return `tma ${createSignedInitData(
    {
      user: JSON.stringify({ id: telegramId, first_name: 'Card' }),
      auth_date: String(Math.floor(Date.now() / 1000)),
    },
    BOT_TOKEN,
  )}`;
}

function uuid(): string {
  return `tx-${Math.random().toString(36).slice(2, 12)}`;
}

/** Sets the gateway to answer a successful create. */
function gatewayCreates(overrides: Record<string, unknown> = {}) {
  gateway.status = 201;
  gateway.body = {
    uuid: uuid(),
    status: 'pending',
    payment_url: 'https://pay.example/abc',
    ...overrides,
  };
  return gateway.body as { uuid: string };
}

/** Places a RUB order through the service, returning the created payment. */
async function placeCardOrder(options: { quantity?: number } = {}) {
  buyerSeq += 1;
  const telegramId = BUYER + buyerSeq;
  const user = await prisma.user.upsert({
    where: { telegramId: String(telegramId) },
    create: { telegramId: String(telegramId), firstName: 'Card' },
    update: {},
  });

  const result = await orders.createOrder(
    {
      id: user.id,
      telegramId: user.telegramId,
      firstName: user.firstName,
      lastName: null,
      username: null,
      languageCode: null,
      displayName: null,
      role: 'USER',
      permissions: [],
      isAdmin: false,
      createdAt: user.createdAt.toISOString(),
      // Member, so the base price is the stored one and the arithmetic is clean.
      isSubscribedChannel: true,
    },
    {
      items: [{ productId, quantity: options.quantity ?? 1 }],
      paymentCurrency: 'RUB',
    },
  );
  return { ...result, telegramId };
}

/**
 * Places a RUB order on the Cashera crypto rail.
 *
 * Same order and same RUB invoice as `placeCardOrder`; only the rail differs, which
 * is the whole point of the test — crypto must reach Cashera as `payment_method:
 * "crypto"`, not as `sbp`.
 */
async function placeCryptoOrder(options: { quantity?: number } = {}) {
  buyerSeq += 1;
  const telegramId = BUYER + buyerSeq;
  const user = await prisma.user.upsert({
    where: { telegramId: String(telegramId) },
    create: { telegramId: String(telegramId), firstName: 'Crypto' },
    update: {},
  });

  const result = await orders.createOrder(
    {
      id: user.id,
      telegramId: user.telegramId,
      firstName: user.firstName,
      lastName: null,
      username: null,
      languageCode: null,
      displayName: null,
      role: 'USER',
      permissions: [],
      isAdmin: false,
      createdAt: user.createdAt.toISOString(),
      isSubscribedChannel: true,
    },
    {
      items: [{ productId, quantity: options.quantity ?? 1 }],
      paymentCurrency: 'RUB',
      casheraRail: 'crypto',
    },
  );
  return { ...result, telegramId };
}

/** The single create-transaction body the fake gateway received, typed loosely. */
function lastCreateBody(): Record<string, unknown> {
  const create = [...gateway.requests]
    .reverse()
    .find((r) => r.method === 'POST' && r.path === '/integration/transactions');
  assert.ok(create, 'expected a create-transaction request');
  return create!.body as Record<string, unknown>;
}

/** Posts a webhook with the given headers and body. */
async function postWebhook(
  body: unknown,
  headers: { key?: string; secret?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/cashera',
    headers: {
      ...(headers.key === undefined ? { 'x-api-key': API_KEY } : { 'x-api-key': headers.key }),
      ...(headers.secret === undefined
        ? { 'x-secret': API_SECRET }
        : { 'x-secret': headers.secret }),
    },
    payload: body as Record<string, unknown>,
  });
}

function paidEvent(tx: {
  uuid: string;
  externalId: string;
  amount: number;
  currency?: string;
  status?: string;
  /** The method the gateway settles with. Defaults to the card rail's. */
  method?: string;
}) {
  return {
    event: 'transaction.status_updated',
    transaction: {
      uuid: tx.uuid,
      external_id: tx.externalId,
      status: tx.status ?? 'paid',
      amount: tx.amount,
      currency: tx.currency ?? 'RUB',
      payment_method: tx.method ?? 'sbp',
      paid_at: new Date().toISOString(),
    },
  };
}

beforeEach(() => {
  gateway.requests = [];
  gateway.failTimes = 0;
  gateway.failStatus = 502;
  gatewayCreates();
});

describe('pricing: RUB needs no conversion', () => {
  it('sends the order total straight through as minor units', async () => {
    const { order, casheraPayment } = await placeCardOrder();

    // 499 ₽ -> 49900. The base price already IS kopecks, so nothing converts and
    // nothing rounds.
    assert.equal(order.currency, 'RUB');
    assert.equal(order.totalAmountMinor, 49_900);
    assert.equal(order.totalBaseRubMinor, 49_900);
    assert.ok(casheraPayment);
    assert.equal(casheraPayment.amountMinor, 49_900);

    const sent = gateway.requests.at(-1)!.body as { amount: number; currency: string };
    assert.equal(sent.amount, 49_900, 'the gateway must be sent kopecks');
    assert.equal(sent.currency, 'RUB');
  });

  it('multiplies quantity without drift', async () => {
    const { order } = await placeCardOrder({ quantity: 3 });
    assert.equal(order.totalAmountMinor, 149_700);
    assert.equal(order.lines[0]!.unitAmountMinor, 49_900);
  });

  it('does not consult the USDT rate', async () => {
    // The card rail must not depend on a crypto rate: the snapshot is 100
    // kopecks per rouble, which is a statement of units rather than a conversion.
    const { order } = await placeCardOrder();
    assert.equal(order.rateRubMinorPerUnit, 100);
  });
});

describe('create transaction', () => {
  it('sends the documented payload and header', async () => {
    const { order } = await placeCardOrder();
    const request = gateway.requests.at(-1)!;

    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/integration/transactions');
    assert.equal(request.headers['x-api-key'], API_KEY);
    // The shared secret authenticates INBOUND webhooks. Sending it upstream would
    // expose it for no reason.
    assert.equal(request.headers['x-secret'], undefined);

    const body = request.body as Record<string, unknown>;
    assert.equal(body.payment_method, 'sbp');
    assert.equal(body.external_id, `ord_${order.id}`);
    assert.equal(body.callback_url, 'https://shop.example/webhooks/cashera');
    assert.ok(String(body.success_url).startsWith('https://shop.example/pay/ok'));
    assert.ok(String(body.fail_url).startsWith('https://shop.example/pay/fail'));
  });

  it('derives external_id from the order, so it is stable and traceable', async () => {
    const { order } = await placeCardOrder();
    assert.equal(cashera.externalIdForOrder(order.id), `ord_${order.id}`);

    const row = await prisma.casheraTransaction.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    assert.equal(row.externalId, `ord_${order.id}`);
  });

  it('is idempotent: asking again returns the same transaction', async () => {
    const { order, casheraPayment } = await placeCardOrder();
    assert.ok(casheraPayment);
    const callsBefore = gateway.requests.length;

    const again = await cashera.createPaymentForOrder(order.id);
    assert.equal(again.uuid, casheraPayment.uuid);
    // No second upstream call: the local row answers.
    assert.equal(gateway.requests.length, callsBefore);

    const rows = await prisma.casheraTransaction.count({
      where: { orderId: order.id },
    });
    assert.equal(rows, 1);
  });

  it('retries a transient failure with the SAME external_id', async () => {
    /*
     * The hazard this guards: a create can reach the gateway, open a transaction,
     * and lose its response. Retrying with a fresh id would create a second
     * transaction and a second payment link for one order. Cashera keys idempotency
     * on external_id, so the retry must reuse it.
     */
    gateway.failTimes = 2;
    gateway.failStatus = 502;

    const { order } = await placeCardOrder();
    const creates = gateway.requests.filter(
      (r) => r.path === '/integration/transactions',
    );
    assert.equal(creates.length, 3, 'two failures then a success');

    const ids = new Set(
      creates.map((r) => (r.body as { external_id: string }).external_id),
    );
    assert.equal(ids.size, 1, 'every attempt must carry one external_id');
    assert.equal([...ids][0], `ord_${order.id}`);
  });

  it('retries a timeout, and still only ever creates one row', async () => {
    // 429 is retryable and is the most likely real transient.
    gateway.failTimes = 1;
    gateway.failStatus = 429;

    const { order } = await placeCardOrder();
    const rows = await prisma.casheraTransaction.count({
      where: { orderId: order.id },
    });
    assert.equal(rows, 1);
  });

  it('gives up after a bounded number of attempts', async () => {
    gateway.failTimes = 99;
    gateway.failStatus = 502;

    await assert.rejects(
      () => placeCardOrder(),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'PAYMENT_PROVIDER_ERROR');
        return true;
      },
    );
    // Bounded: not an unbounded hammering of a failing gateway.
    const creates = gateway.requests.filter(
      (r) => r.path === '/integration/transactions',
    );
    assert.ok(creates.length <= 3, `made ${creates.length} attempts`);
  });

  for (const [status, code] of [
    [401, 'PAYMENT_PROVIDER_ERROR'],
    [403, 'PAYMENT_PROVIDER_ERROR'],
    [422, 'VALIDATION_ERROR'],
  ] as const) {
    it(`maps a ${status} to ${code} without retrying`, async () => {
      gateway.status = status;
      gateway.body = { message: 'nope', errors: { amount: ['bad'] } };

      await assert.rejects(
        () => placeCardOrder(),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, code);
          return true;
        },
      );
      const creates = gateway.requests.filter(
        (r) => r.path === '/integration/transactions',
      );
      // A refusal about the request itself is final; retrying only hides it.
      assert.equal(creates.length, 1);
    });
  }

  /**
   * A 401 is not one failure. Verified against the live gateway: an absent key
   * answers `X-Api-Key header is required.` and a wrong one answers
   * `Invalid API key.` — both HTTP 401. Without the reason these are
   * indistinguishable in the log, and they have opposite fixes.
   */
  for (const [reason, label] of [
    ['X-Api-Key header is required.', 'empty key'],
    ['Invalid API key.', 'unknown key'],
  ] as const) {
    it(`keeps Cashera's reason for a 401 so an ${label} is identifiable`, async () => {
      gateway.status = 401;
      gateway.body = { message: reason };

      await assert.rejects(
        () => placeCryptoOrder(),
        (error: Error & { httpStatus?: number; gatewayMessage?: string }) => {
          assert.equal(error.httpStatus, 401);
          assert.equal(
            error.gatewayMessage,
            reason,
            'the gateway reason must survive to the server log',
          );
          return true;
        },
      );
    });
  }

  it('does not leak a provider body that is not a short message', async () => {
    // The reason is taken from `message` only. An error page carrying request
    // echoes or internal identifiers must not be forwarded.
    gateway.status = 401;
    gateway.body = {
      message: 'Invalid API key.',
      debug: { echoed_key: 'pk_should_not_appear', trace: 'internal-123' },
    };

    await assert.rejects(
      () => placeCryptoOrder(),
      (error: Error & { gatewayMessage?: string }) => {
        assert.equal(error.gatewayMessage, 'Invalid API key.');
        return true;
      },
    );
  });

  it('caps an unreasonably long gateway message', async () => {
    gateway.status = 401;
    gateway.body = { message: 'x'.repeat(5000) };

    await assert.rejects(
      () => placeCryptoOrder(),
      (error: Error & { gatewayMessage?: string }) => {
        assert.equal(error.gatewayMessage?.length, 200);
        return true;
      },
    );
  });

  it('refuses when the gateway returns no uuid', async () => {
    gateway.status = 201;
    gateway.body = { status: 'pending', payment_url: 'https://pay.example/x' };

    await assert.rejects(
      () => placeCardOrder(),      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'PAYMENT_PROVIDER_ERROR');
        return true;
      },
    );
  });
});

describe('webhook authentication', () => {
  it('rejects a missing, wrong, or partial credential with 401', async () => {
    const created = gatewayCreates();
    const { order } = await placeCardOrder();
    const body = paidEvent({
      uuid: created.uuid,
      externalId: `ord_${order.id}`,
      amount: 49_900,
    });

    for (const headers of [
      { key: '', secret: '' },
      { key: 'wrong', secret: API_SECRET },
      { key: API_KEY, secret: 'wrong' },
      // The key is right but the secret is absent: not an authenticated request.
      { key: API_KEY, secret: '' },
      // Right values, wrong places.
      { key: API_SECRET, secret: API_KEY },
    ]) {
      const res = await postWebhook(body, headers);
      assert.equal(res.statusCode, 401, JSON.stringify(headers));
    }

    // And nothing was settled by any of them.
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(row.status, 'PENDING');
  });

  it('compares credentials without leaking their length', async () => {
    // A length-mismatched value must be rejected, not throw. `timingSafeEqual`
    // raises on unequal lengths, and an exception would both 500 and disclose that
    // the length was wrong rather than the value.
    const created = gatewayCreates();
    const { order } = await placeCardOrder();
    const body = paidEvent({
      uuid: created.uuid,
      externalId: `ord_${order.id}`,
      amount: 49_900,
    });

    for (const secret of ['x', `${API_SECRET}extra`, '']) {
      const res = await postWebhook(body, { secret });
      assert.equal(res.statusCode, 401);
      // 401, never 500: the comparison handled the length difference itself.
      assert.notEqual(res.statusCode, 500);
    }
  });

  it('does not log either credential', async () => {
    // Asserted structurally: the redact list must name both headers, since a
    // rejected webhook is logged and pino would otherwise serialise them.
    const { config } = await import('./config.ts');
    assert.ok(config.cashera.enabled);

    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(path.join(apiRoot, 'src/server.ts'), 'utf8'),
    );
    assert.match(source, /req\.headers\["x-secret"\]/);
    assert.match(source, /req\.headers\["x-api-key"\]/);
  });

  it('acknowledges an event it does not act on with 2xx, not 400', async () => {
    // Cashera's documented rule: answer 2xx to anything unrecognised, because a
    // 4xx is treated as a configuration error and stops retries. `webhook.test` is
    // sent by the dashboard's own test button and carries no `transaction`, so
    // rejecting it would make the merchant's test look broken.
    for (const event of ['webhook.test', 'payout.status_updated', 'something.new']) {
      const res = await postWebhook({ event });
      assert.equal(res.statusCode, 200, `${event} must be acknowledged`);
      assert.equal(res.json().accepted, false);
    }
  });

  it('rejects a malformed handled event with 400', async () => {
    // The event type is one we act on, but the body is not a valid transaction.
    // That is a 400: asking Cashera to retry a body that will never parse is noise.
    const res = await postWebhook({ event: 'transaction.status_updated', transaction: { uuid: 'u' } });
    assert.equal(res.statusCode, 400);
  });
});

describe('webhook settlement', () => {
  it('pays the order and delivers exactly one key on paid', async () => {
    const created = gatewayCreates();
    const { order } = await placeCardOrder();

    const res = await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: `ord_${order.id}`,
        amount: 49_900,
      }),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, true);

    const paid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.equal(paid.status, 'PAID');
    assert.ok(paid.paidAt);
    assert.match(paid.lines[0]!.deliveredPayload ?? '', /^CARD-KEY-/);
    // Telegram's charge columns stay empty: this was not a Telegram payment.
    assert.equal(paid.telegramPaymentChargeId, null);

    const row = await prisma.casheraTransaction.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    assert.equal(row.status, 'paid');
    assert.ok(row.paidAt);
    // A settled payment must not keep a usable link.
    assert.equal(row.paymentUrl, null);
  });

  for (const status of ['pending', 'failed', 'expired', 'refunded', 'chargeback'] as const) {
    it(`records "${status}" without paying the order`, async () => {
      const created = gatewayCreates();
      const { order } = await placeCardOrder();

      const res = await postWebhook(
        paidEvent({
          uuid: created.uuid,
          externalId: `ord_${order.id}`,
          amount: 49_900,
          status,
        }),
      );
      assert.equal(res.statusCode, 200);

      const row = await prisma.casheraTransaction.findUniqueOrThrow({
        where: { orderId: order.id },
      });
      assert.equal(row.status, status);

      // Only `paid` settles. Every other status leaves the order alone.
      const unpaid = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      assert.equal(unpaid.status, 'PENDING');
      assert.equal(unpaid.paidAt, null);
    });
  }

  it('refuses to ship when the amount does not match', async () => {
    const created = gatewayCreates();
    const { order } = await placeCardOrder();

    // One kopeck short of what the order asked for.
    const res = await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: `ord_${order.id}`,
        amount: 49_899,
      }),
    );
    // 200 so the gateway stops resending something that will never be accepted,
    // but explicitly not accepted.
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, false);

    const unpaid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.equal(unpaid.status, 'PENDING');
    assert.equal(unpaid.lines[0]!.deliveredPayload, null);
  });

  it('refuses to ship when the currency does not match', async () => {
    const created = gatewayCreates();
    const { order } = await placeCardOrder();

    const res = await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: `ord_${order.id}`,
        amount: 49_900,
        currency: 'USD',
      }),
    );
    assert.equal(res.json().accepted, false);

    const unpaid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(unpaid.status, 'PENDING');
  });

  it('refuses an unknown external_id', async () => {
    const res = await postWebhook(
      paidEvent({ uuid: uuid(), externalId: 'ord_nonexistent', amount: 100 }),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, false);
  });

  it('refuses a uuid that belongs to a different transaction', async () => {
    gatewayCreates();
    const { order } = await placeCardOrder();

    // Right reference, wrong gateway id.
    const res = await postWebhook(
      paidEvent({
        uuid: 'tx-someone-elses',
        externalId: `ord_${order.id}`,
        amount: 49_900,
      }),
    );
    assert.equal(res.json().accepted, false);

    const unpaid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(unpaid.status, 'PENDING');
  });
});

describe('webhook idempotency', () => {
  it('ignores a replay and does not deliver twice', async () => {
    const created = gatewayCreates();
    const { order } = await placeCardOrder();
    const body = paidEvent({
      uuid: created.uuid,
      externalId: `ord_${order.id}`,
      amount: 49_900,
    });

    const first = await postWebhook(body);
    assert.equal(first.json().duplicate, false);

    const claimedAfterFirst = await prisma.licenseKey.count({
      where: { productId, claimedAt: { not: null } },
    });

    for (let i = 0; i < 4; i += 1) {
      const replay = await postWebhook(body);
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().duplicate, true);
    }

    const claimedAfterReplays = await prisma.licenseKey.count({
      where: { productId, claimedAt: { not: null } },
    });
    assert.equal(claimedAfterReplays, claimedAfterFirst, 'replay claimed a key');

    const paid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    // One key, not several concatenated.
    assert.equal(paid.lines[0]!.deliveredPayload?.split('\n').length, 1);
  });

  it('survives concurrent duplicates', async () => {
    /*
     * Two deliveries of the same event at once. The unique constraint on
     * (uuid, status) is the only thing that can arbitrate this — an in-memory guard
     * would let both through on separate connections, and a check-then-insert would
     * leave a window between them.
     */
    const created = gatewayCreates();
    const { order } = await placeCardOrder();
    const body = paidEvent({
      uuid: created.uuid,
      externalId: `ord_${order.id}`,
      amount: 49_900,
    });

    const results = await Promise.all([
      postWebhook(body),
      postWebhook(body),
      postWebhook(body),
    ]);
    for (const res of results) assert.equal(res.statusCode, 200);

    // Exactly one did the work.
    const notDuplicate = results.filter((r) => r.json().duplicate === false);
    assert.equal(notDuplicate.length, 1, 'more than one delivery did the work');

    const events = await prisma.casheraWebhookEvent.count({
      where: { transactionUuid: created.uuid, status: 'paid' },
    });
    assert.equal(events, 1);

    const paid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.equal(paid.lines[0]!.deliveredPayload?.split('\n').length, 1);
  });

  it('treats a different status on the same transaction as a new event', async () => {
    // pending then paid is a normal progression, not a duplicate.
    const created = gatewayCreates();
    const { order } = await placeCardOrder();

    const pending = await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: `ord_${order.id}`,
        amount: 49_900,
        status: 'pending',
      }),
    );
    assert.equal(pending.json().duplicate, false);

    const paid = await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: `ord_${order.id}`,
        amount: 49_900,
      }),
    );
    assert.equal(paid.json().duplicate, false);

    const settled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(settled.status, 'PAID');
  });

  it('persists idempotency across a restart', async () => {
    // The events live in the database, so a process restart cannot reopen the
    // window for a duplicate. Asserted by reading the row back directly.
    const created = gatewayCreates();
    const { order } = await placeCardOrder();
    await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: `ord_${order.id}`,
        amount: 49_900,
      }),
    );

    const stored = await prisma.casheraWebhookEvent.findUnique({
      where: {
        transactionUuid_status: { transactionUuid: created.uuid, status: 'paid' },
      },
    });
    assert.ok(stored, 'the event must be persisted, not held in memory');
  });
});

describe('return URLs are navigation only', () => {
  it('does not mark an order paid when the buyer lands on /pay/ok', async () => {
    gatewayCreates();
    const { order } = await placeCardOrder();

    const res = await app.inject({
      method: 'GET',
      url: `/pay/ok?order=${order.id}`,
    });
    // Redirects back into the Mini App...
    assert.ok(res.statusCode === 302 || res.statusCode === 200);

    // ...and changes nothing. A URL anyone can open is not evidence of payment.
    const unpaid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.equal(unpaid.status, 'PENDING');
    assert.equal(unpaid.lines[0]!.deliveredPayload, null);
  });

  it('does not require authentication, and still settles nothing', async () => {
    gatewayCreates();
    const { order } = await placeCardOrder();
    await app.inject({ method: 'GET', url: `/pay/fail?order=${order.id}` });

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(row.status, 'PENDING');
  });
});

describe('status lookup and recovery', () => {
  it('settles from a gateway lookup when no webhook arrived', async () => {
    const created = gatewayCreates();
    const { order } = await placeCardOrder();

    // The gateway now reports it paid, but no webhook was ever delivered.
    gateway.status = 200;
    gateway.body = {
      uuid: created.uuid,
      status: 'paid',
      amount: 49_900,
      currency: 'RUB',
      payment_method: 'sbp',
      paid_at: new Date().toISOString(),
    };

    const refreshed = await cashera.refreshFromGateway(order.id);
    assert.equal(refreshed?.status, 'paid');

    const paid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.equal(paid.status, 'PAID');
    assert.match(paid.lines[0]!.deliveredPayload ?? '', /^CARD-KEY-/);
  });

  it('applies the same verification on the recovery path', async () => {
    const created = gatewayCreates();
    const { order } = await placeCardOrder();

    // A wrong amount must be refused whether it arrives by webhook or by polling.
    gateway.status = 200;
    gateway.body = {
      uuid: created.uuid,
      status: 'paid',
      amount: 1,
      currency: 'RUB',
    };

    await cashera.refreshFromGateway(order.id);
    const unpaid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(unpaid.status, 'PENDING');
  });

  it('does not double-deliver when a webhook and a lookup race', async () => {
    const created = gatewayCreates();
    const { order } = await placeCardOrder();
    const body = paidEvent({
      uuid: created.uuid,
      externalId: `ord_${order.id}`,
      amount: 49_900,
    });

    await postWebhook(body);
    const claimedAfterWebhook = await prisma.licenseKey.count({
      where: { productId, claimedAt: { not: null } },
    });

    // The recovery path runs afterwards and reports the same status. It goes
    // through the same event guard, so it cannot deliver again.
    gateway.status = 200;
    gateway.body = {
      uuid: created.uuid,
      status: 'paid',
      amount: 49_900,
      currency: 'RUB',
    };
    await cashera.refreshFromGateway(order.id);

    const claimedAfterRefresh = await prisma.licenseKey.count({
      where: { productId, claimedAt: { not: null } },
    });
    assert.equal(claimedAfterRefresh, claimedAfterWebhook);
  });
});

describe('API surface', () => {
  it('requires authentication on every card payment route', async () => {
    gatewayCreates();
    const { order } = await placeCardOrder();

    for (const route of [
      { method: 'GET' as const, url: `/api/orders/${order.id}/cashera-payment` },
      { method: 'POST' as const, url: `/api/orders/${order.id}/cashera-payment` },
      {
        method: 'POST' as const,
        url: `/api/orders/${order.id}/cashera-payment/refresh`,
      },
    ]) {
      const res = await app.inject({
        ...route,
        ...(route.method === 'POST' ? { payload: {} } : {}),
      });
      assert.equal(res.statusCode, 401, `${route.method} ${route.url}`);
    }
  });

  it("hides another buyer's payment behind a 404", async () => {
    gatewayCreates();
    const { order } = await placeCardOrder();

    const res = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}/cashera-payment`,
      headers: { authorization: auth(BUYER + 9_999) },
    });
    assert.equal(res.statusCode, 404);
  });

  it('never returns credentials to the client', async () => {
    gatewayCreates();
    const { order, telegramId } = await placeCardOrder();

    const res = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}/cashera-payment`,
      headers: { authorization: auth(telegramId) },
    });
    assert.equal(res.statusCode, 200);

    const body = res.body;
    assert.ok(!body.includes(API_KEY), 'response leaked the api key');
    assert.ok(!body.includes(API_SECRET), 'response leaked the api secret');
    for (const forbidden of ['x-secret', 'apiSecret', 'api_secret']) {
      assert.ok(!body.toLowerCase().includes(forbidden.toLowerCase()));
    }
  });

  it('reports availability without disclosing configuration', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/payment-options' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cardAvailable, true);

    const body = res.body;
    assert.ok(!body.includes(API_KEY));
    assert.ok(!body.includes(API_SECRET));
  });

  it('exposes the rail in /health without secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const { cashera: diag } = res.json();
    assert.equal(diag.enabled, true);
    assert.equal(diag.paymentMethod, 'sbp');
    // The crypto rail is reported too, so a deploy can be confirmed wired to
    // `crypto` without creating a real payment.
    assert.equal(diag.cryptoPaymentMethod, 'crypto');
    assert.equal(diag.callbackConfigured, true);

    assert.ok(!res.body.includes(API_KEY));
    assert.ok(!res.body.includes(API_SECRET));
    // Not even the base URL, which can carry a tenant path.
    assert.ok(!res.body.includes(gatewayUrl));
  });
});

describe('other rails still work', () => {
  it('keeps the Stars path unchanged', async () => {
    buyerSeq += 1;
    const telegramId = BUYER + buyerSeq;
    const user = await prisma.user.upsert({
      where: { telegramId: String(telegramId) },
      create: { telegramId: String(telegramId), firstName: 'Stars' },
      update: {},
    });

    const created = await orders.createOrder(
      {
        id: user.id,
        telegramId: user.telegramId,
        firstName: user.firstName,
        lastName: null,
        username: null,
        languageCode: null,
        displayName: null,
        role: 'USER',
        permissions: [],
        isAdmin: false,
        createdAt: user.createdAt.toISOString(),
        isSubscribedChannel: true,
      },
      { items: [{ productId, quantity: 1 }], paymentCurrency: 'XTR' },
    );

    assert.equal(created.order.currency, 'XTR');
    assert.equal(created.casheraPayment, null, 'Stars orders get no card payment');
    assert.equal(created.cryptoPayment, null);
    // Whole Stars, derived from the same rouble base.
    assert.ok(Number.isInteger(created.order.totalAmountMinor));
    assert.equal(created.order.totalBaseRubMinor, 49_900);

    // And the Telegram settlement path still delivers.
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: created.order.id },
    });
    const paid = await orders.markOrderPaid({
      kind: 'telegram',
      invoicePayload: row.invoicePayload,
      telegramPaymentChargeId: 'charge_stars_1',
      providerPaymentChargeId: null,
    });
    assert.equal(paid?.status, 'PAID');
    assert.match(paid!.lines[0]!.deliveredPayload!, /^CARD-KEY-/);
  });

  it('refuses a card payment on an order that is not in RUB', async () => {
    buyerSeq += 1;
    const telegramId = BUYER + buyerSeq;
    const user = await prisma.user.upsert({
      where: { telegramId: String(telegramId) },
      create: { telegramId: String(telegramId), firstName: 'Mixed' },
      update: {},
    });
    const created = await orders.createOrder(
      {
        id: user.id,
        telegramId: user.telegramId,
        firstName: user.firstName,
        lastName: null,
        username: null,
        languageCode: null,
        displayName: null,
        role: 'USER',
        permissions: [],
        isAdmin: false,
        createdAt: user.createdAt.toISOString(),
        isSubscribedChannel: true,
      },
      { items: [{ productId, quantity: 1 }], paymentCurrency: 'XTR' },
    );

    await assert.rejects(
      () => cashera.createPaymentForOrder(created.order.id),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CURRENCY_MISMATCH');
        return true;
      },
    );
  });
});

describe('crypto rail', () => {
  it('creates the transaction with payment_method=crypto, in RUB minor units', async () => {
    gatewayCreates();
    const { order, casheraPayment } = await placeCryptoOrder();

    const body = lastCreateBody();
    // The core requirement: crypto, not sbp, and not a named coin.
    assert.equal(body.payment_method, 'crypto');
    assert.equal(body.currency, 'RUB');
    assert.equal(body.amount, 49_900, '499 ₽ sent as kopecks');
    assert.equal(body.external_id, cashera.externalIdForOrder(order.id));
    assert.equal(body.callback_url, 'https://shop.example/webhooks/cashera');
    assert.ok(
      typeof body.success_url === 'string' && body.success_url.startsWith('https://'),
      'success_url must be an absolute https URL',
    );
    assert.ok(typeof body.description === 'string' && body.description.length > 0);

    assert.equal(casheraPayment!.rail, 'crypto');
    assert.equal(casheraPayment!.amountMinor, 49_900);
    assert.equal(casheraPayment!.currency, 'RUB');
  });

  it('does not send sbp on the crypto rail', async () => {
    gatewayCreates();
    await placeCryptoOrder();
    const body = lastCreateBody();
    assert.notEqual(body.payment_method, 'sbp');
    assert.equal(body.payment_method, 'crypto');
  });

  it('never restricts the rail to a single coin', async () => {
    // The whole point: "crypto", not "USDT". No coin name is chosen by this shop.
    gatewayCreates();
    await placeCryptoOrder();
    const body = lastCreateBody();

    // Inspect the *values*, not a substring scan of the whole body: the key
    // `payment_method` itself contains "eth", so scanning keys would false-positive.
    const method = String(body.payment_method).toLowerCase();
    const description = String(body.description ?? '').toLowerCase();
    const values = `${method} ${description}`;

    for (const coin of ['usdt', 'usdc', 'btc', 'bnb', 'tron', 'bep20']) {
      assert.equal(values.includes(coin), false, `must not hardcode ${coin}`);
    }
    // `eth` is checked as a whole word because it is a substring of `method`.
    assert.equal(/\beth\b/.test(method), false, 'must not hardcode eth');
    assert.equal(body.payment_method, 'crypto');
  });

  it('records the method Cashera reports and redirects to payment_url', async () => {
    const created = gatewayCreates({ payment_url: 'https://pay.example/crypto-1' });
    await placeCryptoOrder();

    const row = await prisma.casheraTransaction.findUniqueOrThrow({
      where: { uuid: created.uuid },
      select: { rail: true, paymentMethod: true, paymentUrl: true },
    });
    assert.equal(row.rail, 'crypto');
    assert.equal(row.paymentMethod, 'crypto');
    assert.equal(row.paymentUrl, 'https://pay.example/crypto-1');
  });

  it('settles on a paid webhook and delivers the key', async () => {
    const created = gatewayCreates();
    const { order } = await placeCryptoOrder();

    const res = await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: cashera.externalIdForOrder(order.id),
        amount: 49_900,
        method: 'crypto',
      }),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, true);

    const settled = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    });
    assert.equal(settled.status, 'PAID');
  });

  it('does not settle on pending', async () => {
    const created = gatewayCreates();
    const { order } = await placeCryptoOrder();

    await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: cashera.externalIdForOrder(order.id),
        amount: 49_900,
        status: 'pending',
        method: 'crypto',
      }),
    );

    const still = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    });
    assert.equal(still.status, 'PENDING', 'pending must not release goods');
  });

  it('delivers once on a replayed paid webhook', async () => {
    const created = gatewayCreates();
    const { order } = await placeCryptoOrder();
    const event = paidEvent({
      uuid: created.uuid,
      externalId: cashera.externalIdForOrder(order.id),
      amount: 49_900,
      method: 'crypto',
    });

    await postWebhook(event);
    const second = await postWebhook(event);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().duplicate, true, 'the replay is recognised');

    const delivered = await prisma.orderLine.findMany({
      where: { orderId: order.id, deliveredPayload: { not: null } },
    });
    assert.equal(delivered.length, 1, 'exactly one line, delivered once');
  });

  it('does not settle when the amount is wrong', async () => {
    const created = gatewayCreates();
    const { order } = await placeCryptoOrder();

    await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: cashera.externalIdForOrder(order.id),
        amount: 1,
        method: 'crypto',
      }),
    );

    const still = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    });
    assert.equal(still.status, 'PENDING');
  });

  it('does not settle when the currency is wrong', async () => {
    const created = gatewayCreates();
    const { order } = await placeCryptoOrder();

    await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: cashera.externalIdForOrder(order.id),
        amount: 49_900,
        currency: 'USD',
        method: 'crypto',
      }),
    );

    const still = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    });
    assert.equal(still.status, 'PENDING');
  });

  it('accepts a settlement whose method differs from the one requested', async () => {
    // A merchant may change what `crypto` resolves to in Cashera's dashboard, or a
    // common form may settle on another method. The money arrived and was verified by
    // amount, currency and uuid, so goods ship; the mismatch is only a diagnostic.
    const created = gatewayCreates();
    const { order } = await placeCryptoOrder();

    await postWebhook(
      paidEvent({
        uuid: created.uuid,
        externalId: cashera.externalIdForOrder(order.id),
        amount: 49_900,
        method: 'cryptobot',
      }),
    );

    const settled = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    });
    assert.equal(settled.status, 'PAID');
  });

  it('refuses to re-open an order already placed on the card rail', async () => {
    gatewayCreates();
    const { order } = await placeCardOrder();

    // Cashera keys idempotency on the whole payload, so a different method under the
    // same external_id could never succeed upstream. The conflict is raised here
    // rather than surfacing as an opaque gateway 409.
    await assert.rejects(
      () => cashera.createPaymentForOrder(order.id, 'crypto'),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CONFLICT');
        return true;
      },
    );
  });

  it('omits payment_method entirely for the common payment form', async () => {
    // A blank CASHERA_CRYPTO_PAYMENT_METHOD means "let Cashera offer every enabled
    // method". The key must be absent from the JSON — present-but-null is rejected.
    const { config } = await import('./config.ts');
    const original = config.cashera.cryptoPaymentMethod;
    (config.cashera as { cryptoPaymentMethod: string | null }).cryptoPaymentMethod = null;

    try {
      gatewayCreates({ payment_method: null, selection_required: true });
      const { order } = await placeCryptoOrder();
      const body = lastCreateBody();
      assert.equal('payment_method' in body, false, 'the key must be omitted, not null');

      const row = await prisma.casheraTransaction.findUniqueOrThrow({
        where: { orderId: order.id },
        select: { rail: true, paymentMethod: true },
      });
      assert.equal(row.rail, 'crypto');
      assert.equal(row.paymentMethod, null, 'unknown until the buyer picks');
    } finally {
      (config.cashera as { cryptoPaymentMethod: string | null }).cryptoPaymentMethod = original;
    }
  });

  it('does not require CRYPTO_DEPOSIT_XPUB or the native BEP20 rail', async () => {
    // The crypto rail must work with the native on-chain payments disabled. If it
    // depended on them, `crypto` would be unavailable in production today.
    const { config } = await import('./config.ts');
    assert.equal(config.crypto.enabled, false, 'native BEP20 stays off');
    assert.ok(config.cashera.enabled, 'Cashera is the only thing required');

    gatewayCreates();
    const { casheraPayment } = await placeCryptoOrder();
    assert.equal(casheraPayment!.rail, 'crypto');
  });

  it('keeps the card rail charging the configured card method', async () => {
    // The crypto work must not have changed what `card` does.
    gatewayCreates();
    await placeCardOrder();
    const body = lastCreateBody();
    assert.equal(body.payment_method, 'sbp');
  });
});
