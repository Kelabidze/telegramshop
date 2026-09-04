/**
 * End-to-end API tests against a real SQLite database.
 *
 * Uses Fastify's `inject`, so no port binding or background process is needed.
 * The database is a temporary file that is created and removed per run.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
// Safe to import before the env is set up: `@shop/shared` is pure and reads no
// configuration, unlike the local modules imported lazily inside `before`.
import { effectiveUnitMinor } from '@shop/shared';

const BOT_TOKEN = '424242:AAH-integration-test-token';
const TG_ID = '555000111';

const workDir = mkdtempSync(path.join(tmpdir(), 'shop-api-test-'));
const dbFile = path.join(workDir, 'test.db');
const apiRoot = path.resolve(import.meta.dirname, '..');

// Configure the app BEFORE importing it: config.ts reads env at module load.
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.PAYMENT_PROVIDER = 'none'; // no network calls to Telegram
process.env.ALLOW_DEV_AUTH = 'false'; // force real signature checks
process.env.ADMIN_TELEGRAM_IDS = '';
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = '';
// Point the Bot API at an unroutable address so nothing leaves the machine and
// `bot.init()` fails fast instead of retrying against api.telegram.org.
process.env.TELEGRAM_API_ROOT = 'http://127.0.0.1:9';

type App = Awaited<ReturnType<typeof import('./server.ts')['buildServer']>>;

let app: App;
let createSignedInitData: typeof import('./telegram/init-data.ts')['createSignedInitData'];
let prisma: typeof import('./db.ts')['prisma'];

/** Signed auth header for a given Telegram user. */
function authHeader(telegramId = TG_ID): Record<string, string> {
  const initData = createSignedInitData(
    {
      auth_date: Math.floor(Date.now() / 1000),
      query_id: 'test-query',
      user: { id: Number(telegramId), first_name: 'Tester', username: 'tester' },
    },
    BOT_TOKEN,
  );
  return { authorization: `tma ${initData}` };
}

before(async () => {
  // Create the schema in the temp database.
  execFileSync('npx', ['prisma', 'db', 'push', '--url', `file:${dbFile}`], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  ({ createSignedInitData } = await import('./telegram/init-data.ts'));
  ({ prisma } = await import('./db.ts'));
  const { buildServer } = await import('./server.ts');
  app = await buildServer();
  await app.ready();

  // Minimal catalog: one keyed product with 2 keys, one free link product.
  const category = await prisma.category.create({
    data: { slug: 'test-cat', title: 'Test', sortOrder: 1 },
  });
  const keyed = await prisma.product.create({
    data: {
      slug: 'keyed-item',
      title: 'Keyed Item',
      description: 'A product delivered as a license key.',
      amountMinor: 150,
      currency: 'XTR',
      fulfillmentKind: 'LICENSE_KEY',
      categoryId: category.id,
      sortOrder: 1,
    },
  });
  await prisma.licenseKey.createMany({
    data: [
      { productId: keyed.id, secret: 'KEY-AAAA' },
      { productId: keyed.id, secret: 'KEY-BBBB' },
    ],
  });
  await prisma.product.create({
    data: {
      slug: 'free-link',
      title: 'Free Link',
      description: 'A free product delivered as a link.',
      amountMinor: 0,
      currency: 'XTR',
      fulfillmentKind: 'LINK',
      staticPayload: 'https://example.com/free',
      categoryId: category.id,
      sortOrder: 2,
    },
  });
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(workDir, { recursive: true, force: true });
});

describe('health & catalog', () => {
  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    // No club channel is configured in this suite: the flag must still be
    // present so a silent "feature off" is distinguishable from a Telegram
    // refusal when diagnosing production.
    assert.equal(body.clubChannelConfigured, false);
  });

  it('lists products publicly with stock and without description', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/products' });
    assert.equal(res.statusCode, 200);
    const { products } = res.json();
    assert.equal(products.length, 2);
    const keyed = products.find((p: { slug: string }) => p.slug === 'keyed-item');
    assert.equal(keyed.stock, 2, 'stock should reflect unclaimed keys');
    assert.equal(
      'description' in keyed,
      false,
      'list endpoint must not ship full descriptions',
    );
  });

  it('never exposes staticPayload (the paid content)', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/products' });
    const detail = await app.inject({ method: 'GET', url: '/api/products/free-link' });
    assert.equal(list.body.includes('example.com/free'), false);
    assert.equal(detail.body.includes('example.com/free'), false);
  });

  it('returns 404 for an unknown product', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/products/nope' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });
});

describe('authentication', () => {
  it('rejects /api/me without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'UNAUTHORIZED');
  });

  it('rejects a forged initData', async () => {
    const forged = createSignedInitData(
      { auth_date: Math.floor(Date.now() / 1000), user: { id: 1, first_name: 'Hacker' } },
      'wrong:token',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `tma ${forged}` },
    });
    assert.equal(res.statusCode, 401);
  });

  it('ignores the dev bypass header when ALLOW_DEV_AUTH is false', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { 'x-dev-telegram-id': '999' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('accepts correctly signed initData and creates the user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: authHeader(),
    });
    assert.equal(res.statusCode, 200);
    const { viewer } = res.json();
    assert.equal(viewer.telegramId, TG_ID);
    assert.equal(viewer.isAdmin, false, 'users must not be admin by default');
  });

  it('reports no channel membership when no club channel is configured', async () => {
    // With CLUB_CHANNEL_ID unset the feature is off and `getChatMember` is never
    // called — important in tests, where the Bot API points at an unroutable
    // address. The flag must still be present and false: the client reads it to
    // decide which price to display, and `undefined` would be truthy-adjacent
    // bugs waiting to happen.
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: authHeader(),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().viewer.isSubscribedChannel, false);
  });

  it('accepts the membership recheck header without changing the answer', async () => {
    // The "Я подписался!" button makes the client send this header. It may only
    // force a fresh getChatMember lookup — never grant membership by itself,
    // which is exactly what an unsigned header must not be able to do.
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { ...authHeader(), 'x-club-recheck': '1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.json().viewer.isSubscribedChannel,
      false,
      'a client-supplied header must never confer club membership',
    );
  });
});

describe('orders', () => {
  it('rejects an order with an unknown product', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: authHeader(),
      payload: { items: [{ productId: 'does-not-exist', quantity: 1 }] },
    });
    assert.equal(res.statusCode, 404);
  });

  it('rejects an invalid quantity', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'keyed-item' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: authHeader(),
      payload: { items: [{ productId: product.id, quantity: 0 }] },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });

  it('computes the total from the database, ignoring client-sent prices', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'keyed-item' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: authHeader(),
      payload: {
        items: [{ productId: product.id, quantity: 2 }],
        // Hostile extras that must be ignored:
        amountMinor: 1,
        totalAmountMinor: 1,
        status: 'PAID',
      },
    });
    assert.equal(res.statusCode, 201);
    const { order } = res.json();

    // This viewer is not a channel member (no club channel is configured in
    // tests), so the standard price applies. Derived, not hardcoded: the point
    // of the test is that the amount comes from the database rather than the
    // request body, and a literal would break on every rate change while
    // proving nothing extra.
    const expectedUnit = effectiveUnitMinor(product.amountMinor, false);
    assert.equal(
      order.totalAmountMinor,
      expectedUnit * 2,
      'the unit price must come from the DB, times the requested quantity',
    );
    assert.equal(order.lines[0].unitAmountMinor, expectedUnit);
    assert.notEqual(order.totalAmountMinor, 1, 'client price must be ignored');
    assert.equal(order.status, 'PENDING', 'client cannot set status');
    assert.equal(order.lines[0].deliveredPayload, null, 'nothing before payment');
  });

  it('refuses to oversell license keys', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'keyed-item' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: authHeader(),
      payload: { items: [{ productId: product.id, quantity: 99 }] },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'OUT_OF_STOCK');
  });

  it('delivers free orders immediately without payment', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'free-link' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: authHeader(),
      payload: { items: [{ productId: product.id, quantity: 1 }] },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.order.status, 'PAID');
    assert.equal(body.invoiceUrl, null);
    assert.equal(body.order.lines[0].deliveredPayload, 'https://example.com/free');
  });

  it('hides other users\' orders', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'free-link' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: authHeader('555000222'),
      payload: { items: [{ productId: product.id, quantity: 1 }] },
    });
    const otherOrderId = created.json().order.id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/orders/${otherOrderId}`,
      headers: authHeader(TG_ID),
    });
    assert.equal(res.statusCode, 404, 'must not leak another user\'s order');
  });

  it('lists only the caller\'s own orders', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: authHeader('555000222'),
    });
    assert.equal(res.statusCode, 200);
    const { orders } = res.json();
    assert.ok(orders.length >= 1);
    assert.equal(orders.length, 1, 'other users\' orders must not appear');
  });
  it('charges a channel member the stored club tier price', async () => {
    // Goes through the service rather than HTTP: membership is resolved from
    // Telegram during authentication, and no club channel is configured in this
    // suite. What matters here is that `createOrder` reads the flag off the
    // viewer the server resolved, so the two viewers must differ only in it.
    const { createOrder } = await import('./services/orders.ts');
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'keyed-item' },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { telegramId: TG_ID },
    });

    const baseViewer = {
      id: user.id,
      telegramId: user.telegramId,
      firstName: user.firstName,
      lastName: null,
      username: null,
      languageCode: null,
      role: 'USER' as const,
      permissions: [],
      isAdmin: false,
    };

    const asMember = await createOrder(
      { ...baseViewer, isSubscribedChannel: true },
      { items: [{ productId: product.id, quantity: 1 }] },
    );
    const asGuest = await createOrder(
      { ...baseViewer, isSubscribedChannel: false },
      { items: [{ productId: product.id, quantity: 1 }] },
    );

    assert.equal(
      asMember.order.totalAmountMinor,
      product.amountMinor,
      'a member pays exactly the price stored in the database',
    );
    assert.equal(
      asGuest.order.totalAmountMinor,
      effectiveUnitMinor(product.amountMinor, false),
      'a non-member pays the standard price derived from it',
    );
    assert.ok(
      asGuest.order.totalAmountMinor > asMember.order.totalAmountMinor,
      'membership must never cost more than not having it',
    );
  });
});

describe('payment delivery', () => {
  it('is idempotent: replaying a payment does not claim extra keys', async () => {
    const { markOrderPaid } = await import('./services/orders.ts');
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'keyed-item' },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: authHeader(),
      payload: { items: [{ productId: product.id, quantity: 1 }] },
    });
    const orderId = created.json().order.id;
    const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    const first = await markOrderPaid({
      invoicePayload: row.invoicePayload,
      telegramPaymentChargeId: 'charge_1',
      providerPaymentChargeId: null,
    });
    assert.equal(first?.status, 'PAID');
    const secret = first?.lines[0]?.deliveredPayload;
    assert.ok(secret, 'a key must be delivered');

    const claimedAfterFirst = await prisma.licenseKey.count({
      where: { productId: product.id, claimedAt: { not: null } },
    });

    // Telegram retrying the same update must be a no-op.
    const second = await markOrderPaid({
      invoicePayload: row.invoicePayload,
      telegramPaymentChargeId: 'charge_1',
      providerPaymentChargeId: null,
    });
    assert.equal(second?.status, 'PAID');
    assert.equal(
      second?.lines[0]?.deliveredPayload,
      secret,
      'the same key must be returned, not a new one',
    );

    const claimedAfterSecond = await prisma.licenseKey.count({
      where: { productId: product.id, claimedAt: { not: null } },
    });
    assert.equal(
      claimedAfterSecond,
      claimedAfterFirst,
      'replaying a payment must not consume additional stock',
    );
  });

  it('reduces advertised stock after a key is claimed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/products' });
    const keyed = res
      .json()
      .products.find((p: { slug: string }) => p.slug === 'keyed-item');
    assert.equal(keyed.stock, 1, 'one of two keys is now claimed');
  });

  it('ignores an unknown invoice payload', async () => {
    const { markOrderPaid } = await import('./services/orders.ts');
    const result = await markOrderPaid({
      invoicePayload: 'ord_unknown',
      telegramPaymentChargeId: 'x',
      providerPaymentChargeId: null,
    });
    assert.equal(result, null);
  });
});
