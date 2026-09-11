import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The on-chain payment lifecycle, end to end against a real SQLite database.
 *
 * The chain itself is the one thing not real here: there is no way to make BSC
 * finalise a block on demand, so `CryptoTransaction` rows are written directly —
 * exactly what the monitor does after parsing a log. Log parsing, failover and
 * finality resolution are covered separately in `chain.test.ts`; what this file
 * asserts is what happens to an order once transfers are on record.
 *
 * Env is assigned before any local import because `config.ts` reads
 * `process.env` at module load.
 */

import {
  type PaymentRates,
  effectiveUnitMinor,
  starsForRubMinor,
  usdtMinorForRubMinor,
} from '@shop/shared';

/** Must match the env set below. */
const RATES: PaymentRates = {
  usdtRubMinorPerUnit: 8_600,
  starRubMinorPerUnit: 130,
};

/** The base (club-tier) price of the RUB-priced fixture: 1290 ₽. */
const BASE_RUB_MINOR = 129_000;

const workDir = mkdtempSync(path.join(tmpdir(), 'shop-crypto-test-'));
const dbFile = path.join(workDir, 'test.db');
const apiRoot = path.resolve(import.meta.dirname, '..');

const BOT_TOKEN = '424242:AAH-integration-test-token';
// Watch-only key for the published Hardhat test mnemonic. See chain.test.ts.
const TEST_XPUB =
  'xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.UPLOADS_DIR = path.join(workDir, 'uploads');
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.PAYMENT_PROVIDER = 'none';
process.env.ALLOW_DEV_AUTH = 'false';
process.env.ADMIN_TELEGRAM_IDS = '';
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = '';
process.env.TELEGRAM_API_ROOT = 'http://127.0.0.1:9';
// Crypto on, but the monitor's own loop off: these tests drive reconciliation
// directly so nothing races with a timer.
process.env.CRYPTO_PAYMENTS_ENABLED = 'true';
process.env.CRYPTO_DEPOSIT_XPUB = TEST_XPUB;
process.env.CRYPTO_MONITOR_INTERVAL_SECONDS = '0';
process.env.USDT_RUB_RATE = '86';
process.env.STAR_RUB_MINOR_RATE = '130';

type App = Awaited<ReturnType<typeof import('./server.ts')['buildServer']>>;
type Prisma = typeof import('./db.ts')['prisma'];
type CryptoService = typeof import('./services/crypto-payments.ts');
type OrdersService = typeof import('./services/orders.ts');

let app: App;
let prisma: Prisma;
let crypto: CryptoService;
let orders: OrdersService;
let createSignedInitData: typeof import('./telegram/init-data.ts')['createSignedInitData'];

let usdtProductId = '';
let starProductId = '';

const BUYER_ID = 500_100;

function authHeader(telegramId = BUYER_ID): string {
  const initData = createSignedInitData(
    {
      user: JSON.stringify({
        id: telegramId,
        first_name: 'Crypto',
        username: `buyer${telegramId}`,
      }),
      auth_date: String(Math.floor(Date.now() / 1000)),
    },
    BOT_TOKEN,
  );
  return `tma ${initData}`;
}

before(async () => {
  execFileSync('npx', ['prisma', 'db', 'push', '--url', `file:${dbFile}`], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  ({ createSignedInitData } = await import('./telegram/init-data.ts'));
  ({ prisma } = await import('./db.ts'));
  crypto = await import('./services/crypto-payments.ts');
  orders = await import('./services/orders.ts');
  const { buildServer } = await import('./server.ts');
  app = await buildServer();
  await app.ready();

  const category = await prisma.category.create({
    data: { slug: 'crypto-cat', title: 'Crypto', sortOrder: 1 },
  });

  // 1290 ₽ base price. At 86 ₽/USDT that is exactly 15.00 USDT — a clean number
  // to reason about, chosen so the expected wei is unambiguous.
  const usdtProduct = await prisma.product.create({
    data: {
      slug: 'rub-priced-item',
      title: 'RUB Priced Item',
      description: 'Priced in roubles, payable in USDT or Stars.',
      amountMinor: 129_000,
      currency: 'RUB',
      fulfillmentKind: 'LICENSE_KEY',
      categoryId: category.id,
      sortOrder: 1,
    },
  });
  usdtProductId = usdtProduct.id;
  // Generous stock: this suite places an order per test, and running out would
  // fail tests for a reason unrelated to what they assert.
  await prisma.licenseKey.createMany({
    data: Array.from({ length: 120 }, (_, i) => ({
      productId: usdtProduct.id,
      secret: `USDT-KEY-${i + 1}`,
    })),
  });

  // A legacy XTR-priced product, to prove the old path still works untouched.
  const starProduct = await prisma.product.create({
    data: {
      slug: 'legacy-xtr-item',
      title: 'Legacy XTR Item',
      description: 'Priced directly in Stars, as before the RUB model.',
      amountMinor: 150,
      currency: 'XTR',
      fulfillmentKind: 'LICENSE_KEY',
      categoryId: category.id,
      sortOrder: 2,
    },
  });
  starProductId = starProduct.id;
  await prisma.licenseKey.createMany({
    data: Array.from({ length: 40 }, (_, i) => ({
      productId: starProduct.id,
      secret: `XTR-KEY-${i + 1}`,
    })),
  });
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Places an order through the service rather than over HTTP.
 *
 * `POST /api/orders` is rate limited to 20/minute in production, and this file
 * places far more than that. Lowering the limit for tests would stop asserting
 * the real configuration, so the route is exercised by the handful of HTTP tests
 * below and the rest of the lifecycle goes straight at the service — the same
 * split `server.test.ts` already uses for club-tier pricing.
 */
async function placeOrder(
  paymentCurrency: 'XTR' | 'USDT',
  productId = usdtProductId,
  quantity = 1,
  options: { telegramId?: number; isSubscribedChannel?: boolean } = {},
) {
  const telegramId = options.telegramId ?? BUYER_ID;
  const user = await prisma.user.upsert({
    where: { telegramId: String(telegramId) },
    create: { telegramId: String(telegramId), firstName: 'Crypto' },
    update: {},
  });

  return orders.createOrder(
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
      // Club membership is resolved from Telegram during authentication, and no
      // club channel is configured here — so it is set explicitly. The stored
      // price IS the club tier, and a non-member pays the standard price derived
      // from it, which is why the two cases produce different USDT amounts.
      isSubscribedChannel: options.isSubscribedChannel ?? false,
    },
    { items: [{ productId, quantity }], paymentCurrency },
  );
}

/** What a base price becomes in USDT cents, at the suite's configured rate. */
function expectedUsdtMinor(baseRubMinor: number, isMember: boolean): number {
  return usdtMinorForRubMinor(effectiveUnitMinor(baseRubMinor, isMember), RATES);
}

/**
 * Writes a transfer the way the monitor would after parsing a log.
 *
 * `status` is the caller's choice because the two interesting cases are a
 * transfer that has reached finality and one that has not.
 */
async function recordTransfer(
  intentId: string,
  amountWei: string,
  options: { status?: 'SEEN' | 'CONFIRMED' | 'ORPHANED'; txHash?: string; logIndex?: number } = {},
) {
  const intent = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
    where: { id: intentId },
    select: { walletId: true },
  });
  return prisma.cryptoTransaction.create({
    data: {
      txHash: options.txHash ?? `0x${randomHex(64)}`,
      logIndex: options.logIndex ?? 0,
      walletId: intent.walletId,
      intentId,
      fromAddress: `0x${randomHex(40)}`,
      amountWei,
      blockNumber: 1_000n,
      blockHash: `0x${randomHex(64)}`,
      status: options.status ?? 'CONFIRMED',
      confirmations: 20,
      confirmedAt: (options.status ?? 'CONFIRMED') === 'CONFIRMED' ? new Date() : null,
    },
  });
}

function randomHex(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  }
  return out;
}

describe('USDT checkout: order creation', () => {
  it('derives the USDT total from the RUB base price and snapshots the rate', async () => {
    // A club member pays the stored base price: 1290 ₽ / 86 = exactly 15.00 USDT.
    const { order, cryptoPayment, invoiceUrl } = await placeOrder(
      'USDT',
      usdtProductId,
      1,
      { isSubscribedChannel: true },
    );

    assert.equal(order.currency, 'USDT');
    assert.equal(order.totalAmountMinor, 1_500);
    // The snapshot: the base total and the rate that produced the charged total.
    assert.equal(order.totalBaseRubMinor, BASE_RUB_MINOR);
    assert.equal(order.rateRubMinorPerUnit, 8_600);
    // On-chain orders get an intent, never a Telegram invoice link.
    assert.equal(invoiceUrl, null);
    assert.ok(cryptoPayment);
    assert.equal(cryptoPayment.expectedAmountMinor, 1_500);
    assert.equal(cryptoPayment.expectedAmountWei, '15000000000000000000');
    assert.equal(cryptoPayment.expectedAmountDisplay, '15.00');
    assert.equal(cryptoPayment.status, 'AWAITING');
  });

  it('charges a non-member the standard price, converted', async () => {
    // The club tier survives the currency change: the stored price is the member
    // price, and a guest pays the standard price derived from it — then that is
    // what gets converted, not the other way round.
    const { order } = await placeOrder('USDT');

    const expected = expectedUsdtMinor(BASE_RUB_MINOR, false);
    assert.equal(order.totalAmountMinor, expected);
    assert.ok(
      expected > 1_500,
      'a guest must pay more than a member for the same product',
    );
    // The base snapshot is the standard price, i.e. what this buyer was quoted.
    assert.equal(order.totalBaseRubMinor, effectiveUnitMinor(BASE_RUB_MINOR, false));
  });

  it('gives the buyer a deposit address that is theirs alone', async () => {
    const first = await placeOrder('USDT');
    const second = await placeOrder('USDT');

    assert.ok(first.cryptoPayment && second.cryptoPayment);
    // Two payments must never share an address: an incoming transfer has to be
    // attributable to exactly one intent.
    assert.notEqual(
      first.cryptoPayment.depositAddress,
      second.cryptoPayment.depositAddress,
    );
    assert.match(first.cryptoPayment.depositAddress, /^0x[0-9a-fA-F]{40}$/);
  });

  it('never exposes derivation material to the client', async () => {
    const { order } = await placeOrder('USDT');
    const response = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}/crypto-payment`,
      headers: { authorization: authHeader() },
    });
    assert.equal(response.statusCode, 200);

    // The response may name the address; it must say nothing about how the key
    // that produced it works.
    const body = response.body.toLowerCase();
    for (const forbidden of ['xpub', 'xprv', 'mnemonic', 'privatekey', 'private_key', 'seed', 'derivationindex', 'derivationpath']) {
      assert.ok(!body.includes(forbidden), `response leaked "${forbidden}"`);
    }
  });

  it('is idempotent: asking again returns the same address and amount', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    const again = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/crypto-payment`,
      headers: { authorization: authHeader() },
      payload: {},
    });
    // 200, not 201: nothing new was created.
    assert.equal(again.statusCode, 200);
    const body = again.json() as { cryptoPayment: { id: string; depositAddress: string } };
    assert.equal(body.cryptoPayment.id, cryptoPayment.id);
    assert.equal(body.cryptoPayment.depositAddress, cryptoPayment.depositAddress);
  });

  it('multiplies quantity at the unit price, so line maths still holds', async () => {
    const { order } = await placeOrder('USDT', usdtProductId, 3);

    // Rounding happens per unit, then multiplies. Converting the line total
    // instead would leave the line's own numbers not multiplying out — and
    // Telegram rejects an invoice whose prices do not sum to its total.
    const unit = expectedUsdtMinor(BASE_RUB_MINOR, false);
    assert.equal(order.totalAmountMinor, unit * 3);
    assert.equal(
      order.totalBaseRubMinor,
      effectiveUnitMinor(BASE_RUB_MINOR, false) * 3,
    );
    assert.equal(order.lines[0]!.unitAmountMinor, unit);
    assert.equal(order.lines[0]!.totalAmountMinor, unit * 3);
  });

  it('refuses USDT for a product priced directly in Stars', async () => {
    // No RUB base means no rate to convert from; guessing one would invent a price.
    await assert.rejects(
      () => placeOrder('USDT', starProductId),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CURRENCY_MISMATCH');
        return true;
      },
    );
  });

  it("hides another buyer's payment behind a 404, not a 403", async () => {
    const { order } = await placeOrder('USDT');
    const response = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}/crypto-payment`,
      headers: { authorization: authHeader(BUYER_ID + 1) },
    });
    // 404: the existence of someone else's order is not confirmed.
    assert.equal(response.statusCode, 404);
  });

  it('requires authentication on every payment route', async () => {
    const { order } = await placeOrder('USDT');

    // All three, not just the read: an unauthenticated POST that fell through to
    // the service would issue an address on somebody else's order.
    for (const route of [
      { method: 'GET' as const, url: `/api/orders/${order.id}/crypto-payment` },
      { method: 'POST' as const, url: `/api/orders/${order.id}/crypto-payment` },
      {
        method: 'POST' as const,
        url: `/api/orders/${order.id}/crypto-payment/cancel`,
      },
    ]) {
      const response = await app.inject({
        ...route,
        // A body on the POSTs: Fastify rejects an empty JSON body with a 400/500
        // before the auth hook runs, which would make this assertion pass for the
        // wrong reason.
        ...(route.method === 'POST' ? { payload: {} } : {}),
      });
      assert.equal(
        response.statusCode,
        401,
        `${route.method} ${route.url} answered ${response.statusCode}`,
      );
    }
  });

  it("refuses to issue an address on another buyer's order", async () => {
    const { order } = await placeOrder('USDT');
    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/crypto-payment`,
      headers: { authorization: authHeader(BUYER_ID + 7) },
      payload: {},
    });
    // 404, not 403: the existence of someone else's order is not confirmed.
    assert.equal(response.statusCode, 404);
  });
});

describe('USDT checkout: reconciliation', () => {
  it('confirms an exact payment and delivers the goods', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    await recordTransfer(cryptoPayment.id, cryptoPayment.expectedAmountWei);
    const settled = await crypto.reconcileIntent(cryptoPayment.id);

    assert.equal(settled?.status, 'CONFIRMED');
    assert.equal(settled?.receivedAmountWei, cryptoPayment.expectedAmountWei);
    assert.ok(settled?.confirmedAt);

    // The order is paid and a key was actually handed over.
    const paid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.equal(paid.status, 'PAID');
    assert.ok(paid.paidAt);
    assert.match(paid.lines[0]!.deliveredPayload ?? '', /^USDT-KEY-/);
    // Telegram identifiers stay empty: this was not a Telegram payment.
    assert.equal(paid.telegramPaymentChargeId, null);
  });

  it('treats a transfer that has not reached finality as CONFIRMING, not paid', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    // Seen on chain but not yet final.
    await recordTransfer(cryptoPayment.id, cryptoPayment.expectedAmountWei, {
      status: 'SEEN',
    });
    const state = await crypto.reconcileIntent(cryptoPayment.id);

    assert.equal(state?.status, 'CONFIRMING');
    // Nothing counts until it is final.
    assert.equal(state?.receivedAmountWei, '0');
    const stillPending = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    assert.equal(stillPending.status, 'PENDING');
  });

  it('marks a short payment UNDERPAID and does not pay the order', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    // One wei short. The buyer paid almost everything, which is not everything.
    const short = (BigInt(cryptoPayment.expectedAmountWei) - 1n).toString();
    await recordTransfer(cryptoPayment.id, short);
    const state = await crypto.reconcileIntent(cryptoPayment.id);

    assert.equal(state?.status, 'UNDERPAID');
    assert.equal(state?.receivedAmountWei, short);
    const unpaid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(unpaid.status, 'PENDING');
    assert.equal(unpaid.paidAt, null);
  });

  it('completes an underpaid intent when the buyer tops it up', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    const expected = BigInt(cryptoPayment.expectedAmountWei);
    // Two separate transfers that together make the expected amount. They must
    // sum within one intent rather than each being judged alone.
    await recordTransfer(cryptoPayment.id, (expected - 100n).toString(), { logIndex: 0 });
    assert.equal((await crypto.reconcileIntent(cryptoPayment.id))?.status, 'UNDERPAID');

    await recordTransfer(cryptoPayment.id, '100', { logIndex: 1 });
    const settled = await crypto.reconcileIntent(cryptoPayment.id);

    assert.equal(settled?.status, 'CONFIRMED');
    assert.equal(settled?.receivedAmountWei, expected.toString());
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(paid.status, 'PAID');
  });

  it('records an overpayment rather than absorbing it, and still pays the order', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    const over = (BigInt(cryptoPayment.expectedAmountWei) + 250n).toString();
    await recordTransfer(cryptoPayment.id, over);
    const state = await crypto.reconcileIntent(cryptoPayment.id);

    assert.equal(state?.status, 'OVERPAID');
    // The buyer paid enough, so they get their goods.
    const paid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.equal(paid.status, 'PAID');
    assert.match(paid.lines[0]!.deliveredPayload ?? '', /^USDT-KEY-/);

    // The excess is a stored number a human can act on, not a rounding loss.
    const row = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
      where: { id: cryptoPayment.id },
    });
    assert.equal(row.overpaidAmountWei, '250');
  });

  it('ignores an orphaned transfer, because a reorged block is not a payment', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    await recordTransfer(cryptoPayment.id, cryptoPayment.expectedAmountWei, {
      status: 'ORPHANED',
    });
    const state = await crypto.reconcileIntent(cryptoPayment.id);

    assert.equal(state?.receivedAmountWei, '0');
    assert.notEqual(state?.status, 'CONFIRMED');
    const unpaid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(unpaid.status, 'PENDING');
  });
});

describe('USDT checkout: idempotency', () => {
  it('cannot record the same transfer twice', async () => {
    const { cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    const txHash = `0x${randomHex(64)}`;
    await recordTransfer(cryptoPayment.id, '1000', { txHash, logIndex: 0 });

    // Same (txHash, logIndex): the database constraint refuses it. This is the
    // deduplication mechanism, not an application-level check.
    await assert.rejects(() =>
      recordTransfer(cryptoPayment.id, '1000', { txHash, logIndex: 0 }),
    );

    // A different log in the SAME transaction is a different payment and must be
    // allowed — which is why the key is the pair, not the hash alone.
    await recordTransfer(cryptoPayment.id, '2000', { txHash, logIndex: 1 });

    const count = await prisma.cryptoTransaction.count({ where: { txHash } });
    assert.equal(count, 2);
  });

  it('reconciling repeatedly does not deliver a second key', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    await recordTransfer(cryptoPayment.id, cryptoPayment.expectedAmountWei);

    const claimedBefore = await prisma.licenseKey.count({
      where: { productId: usdtProductId, claimedAt: { not: null } },
    });

    // Five passes, as a stuck poller would produce.
    for (let i = 0; i < 5; i += 1) {
      await crypto.reconcileIntent(cryptoPayment.id);
    }

    const claimedAfter = await prisma.licenseKey.count({
      where: { productId: usdtProductId, claimedAt: { not: null } },
    });
    assert.equal(claimedAfter - claimedBefore, 1, 'claimed more than one key');

    const paid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.equal(paid.status, 'PAID');
    // One key, not five concatenated.
    assert.equal(paid.lines[0]!.deliveredPayload?.split('\n').length, 1);
  });

  it('recomputes the received total instead of accumulating it', async () => {
    const { cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    await recordTransfer(cryptoPayment.id, '5000', { logIndex: 0 });
    const first = await crypto.reconcileIntent(cryptoPayment.id);
    assert.equal(first?.receivedAmountWei, '5000');

    // Recompute, not increment: the same rows must give the same answer however
    // many times they are read.
    for (let i = 0; i < 3; i += 1) {
      const again = await crypto.reconcileIntent(cryptoPayment.id);
      assert.equal(again?.receivedAmountWei, '5000');
    }
  });

  it('refuses to settle an order that is already paid by another route', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    // The order gets cancelled underneath the payment.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' },
    });

    await recordTransfer(cryptoPayment.id, cryptoPayment.expectedAmountWei);
    // markOrderPaid refuses a cancelled order, and that refusal must surface
    // rather than being swallowed into a false CONFIRMED.
    await assert.rejects(() => crypto.reconcileIntent(cryptoPayment.id));
  });
});

describe('USDT checkout: expiry', () => {
  it('expires an intent whose deadline passed with nothing confirmed', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    await prisma.cryptoPaymentIntent.update({
      where: { id: cryptoPayment.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const state = await crypto.reconcileIntent(cryptoPayment.id);
    assert.equal(state?.status, 'EXPIRED');

    // The order stays PENDING rather than being cancelled: the address is still
    // watched, so late funds remain visible and refundable.
    const stillPending = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    assert.equal(stillPending.status, 'PENDING');
  });

  it('lets a payment that confirmed in the same tick win over the clock', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    // Deadline already passed, but the money is there and final.
    await prisma.cryptoPaymentIntent.update({
      where: { id: cryptoPayment.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await recordTransfer(cryptoPayment.id, cryptoPayment.expectedAmountWei);

    const state = await crypto.reconcileIntent(cryptoPayment.id);
    // Paying slightly late is still paying.
    assert.equal(state?.status, 'CONFIRMED');
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(paid.status, 'PAID');
  });

  it('does not resurrect a settled intent when the sweep pass runs', async () => {
    const { cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    await recordTransfer(cryptoPayment.id, cryptoPayment.expectedAmountWei);
    await crypto.reconcileIntent(cryptoPayment.id);

    await prisma.cryptoPaymentIntent.update({
      where: { id: cryptoPayment.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await crypto.expireStaleIntents();

    const row = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
      where: { id: cryptoPayment.id },
    });
    assert.equal(row.status, 'CONFIRMED');
  });

  it('records a transfer that arrives after expiry instead of losing it', async () => {
    const { cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    await prisma.cryptoPaymentIntent.update({
      where: { id: cryptoPayment.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await crypto.reconcileIntent(cryptoPayment.id);

    // Money still lands. It must be on record: unattributed funds a buyer can
    // prove they sent are worse than any status.
    await recordTransfer(cryptoPayment.id, cryptoPayment.expectedAmountWei);
    const stored = await prisma.cryptoTransaction.count({
      where: { intentId: cryptoPayment.id },
    });
    assert.equal(stored, 1);
  });
});

describe('USDT checkout: stock is held while payment is in flight', () => {
  /** A product with exactly one key, so the race is unambiguous. */
  async function seedScarceProduct(slug: string) {
    const product = await prisma.product.create({
      data: {
        slug,
        title: 'Last One',
        description: '',
        amountMinor: 129_000,
        currency: 'RUB',
        fulfillmentKind: 'LICENSE_KEY',
      },
    });
    await prisma.licenseKey.create({
      data: { productId: product.id, secret: `ONLY-${slug}` },
    });
    return product.id;
  }

  it('holds the key so a second buyer cannot take it', async () => {
    const productId = await seedScarceProduct('scarce-hold');

    // First buyer opens an on-chain payment. The single key is now spoken for.
    const first = await placeOrder('USDT', productId);
    assert.ok(first.cryptoPayment);

    // Second buyer tries the same product. Without a hold this would succeed, and
    // whichever of the two paid second would land in FAILED — after sending
    // irreversible funds.
    await assert.rejects(
      () => placeOrder('USDT', productId, 1, { telegramId: BUYER_ID + 20 }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'OUT_OF_STOCK');
        return true;
      },
    );
  });

  it('still lets the holding buyer claim their own key', async () => {
    const productId = await seedScarceProduct('scarce-claim');
    const { order, cryptoPayment } = await placeOrder('USDT', productId);
    assert.ok(cryptoPayment);

    await recordTransfer(cryptoPayment.id, cryptoPayment.expectedAmountWei);
    const settled = await crypto.reconcileIntent(cryptoPayment.id);
    assert.equal(settled?.status, 'CONFIRMED');

    // The hold must not lock the buyer out of the very key it was protecting.
    const paid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.lines[0]!.deliveredPayload, 'ONLY-scarce-claim');
  });

  it('hides held stock from the storefront count', async () => {
    const productId = await seedScarceProduct('scarce-count');
    const { listProducts } = await import('./services/catalog.ts');

    const before = (await listProducts()).find((p) => p.id === productId);
    assert.equal(before?.stock, 1);

    await placeOrder('USDT', productId);

    // "N left" must mean what a new buyer can actually get.
    const during = (await listProducts()).find((p) => p.id === productId);
    assert.equal(during?.stock, 0);
  });

  it('returns the stock when the buyer cancels', async () => {
    const productId = await seedScarceProduct('scarce-cancel');
    const { order, cryptoPayment } = await placeOrder('USDT', productId);
    assert.ok(cryptoPayment);

    await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/crypto-payment/cancel`,
      headers: { authorization: authHeader() },
      payload: {},
    });

    // Immediately, not after the hold lapses: the buyer has said they are not
    // paying, and somebody else may want the key now.
    const { listProducts } = await import('./services/catalog.ts');
    const after = (await listProducts()).find((p) => p.id === productId);
    assert.equal(after?.stock, 1);

    // And a fresh checkout genuinely succeeds.
    const next = await placeOrder('USDT', productId, 1, { telegramId: BUYER_ID + 21 });
    assert.ok(next.cryptoPayment);
  });

  it('returns the stock when the payment expires', async () => {
    const productId = await seedScarceProduct('scarce-expire');
    const { cryptoPayment } = await placeOrder('USDT', productId);
    assert.ok(cryptoPayment);

    await prisma.cryptoPaymentIntent.update({
      where: { id: cryptoPayment.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await crypto.expireStaleIntents();

    const { listProducts } = await import('./services/catalog.ts');
    const after = (await listProducts()).find((p) => p.id === productId);
    assert.equal(after?.stock, 1);
  });

  it('recovers on its own when a hold simply lapses', async () => {
    // The self-healing property: nothing has to remember to release a hold, which
    // is the failure mode a boolean flag would have had.
    const productId = await seedScarceProduct('scarce-lapse');
    const { order } = await placeOrder('USDT', productId);

    const line = await prisma.orderLine.findFirstOrThrow({
      where: { orderId: order.id },
    });
    await prisma.licenseKey.updateMany({
      where: { reservedForLineId: line.id },
      data: { reservedUntil: new Date(Date.now() - 1_000) },
    });

    const { countAvailableKeys } = await import('./services/orders.ts');
    assert.equal(await countAvailableKeys(productId), 1);
  });

  it('terminates when asked for more keys than exist', async () => {
    /*
     * Regression: the reservation loop used to decrement its own counter on a lost
     * race, with no ceiling. A row that kept matching the filter but refusing the
     * conditional UPDATE would spin forever — inside the request holding a
     * checkout open. The bound is what makes this test finish at all.
     */
    const productId = await seedScarceProduct('scarce-bounded');
    const { reserveLicenseKeys } = await import('./services/orders.ts');

    // The fixture product has no order yet — the hold needs a line to hang on.
    const user = await prisma.user.findFirstOrThrow();
    const order = await prisma.order.create({
      data: {
        reference: `BND${Date.now() % 100000}`,
        userId: user.id,
        status: 'PENDING',
        currency: 'USDT',
        totalAmountMinor: 1_500,
        totalBaseRubMinor: 129_000,
        rateRubMinorPerUnit: 8_600,
        invoicePayload: `ord_bounded_${Date.now()}`,
        lines: {
          create: {
            productId,
            titleSnapshot: 'Last One',
            unitAmountMinor: 1_500,
            quantity: 1,
            totalAmountMinor: 1_500,
            unitBaseRubMinor: 129_000,
            fulfillmentKind: 'LICENSE_KEY',
          },
        },
      },
      include: { lines: true },
    });
    const lineId = order.lines[0]!.id;

    // One key exists; ask for far more. Must return what it could take and stop,
    // rather than looping on the exhausted pool.
    const reserved = await reserveLicenseKeys(
      productId,
      lineId,
      500,
      new Date(Date.now() + 60_000),
    );
    assert.equal(reserved, 1, 'should reserve exactly the one key that exists');
  });

  it('does not hold stock for a Stars order', async () => {
    // Stars settle in seconds, so the race was already acceptable there — and a
    // hold would make the common path slower for no benefit.
    const productId = await seedScarceProduct('scarce-stars');
    await placeOrder('XTR', productId);

    const held = await prisma.licenseKey.count({
      where: { productId, reservedUntil: { not: null } },
    });
    assert.equal(held, 0);
  });

  it('never lets two orders claim the same key, holds or not', async () => {
    /*
     * The invariant that must survive everything above. Holds are advisory; the
     * conditional UPDATE in claimLicenseKey is what decides ownership, so even if
     * two lines somehow both believed they held a key, only one can claim it.
     */
    const productId = await seedScarceProduct('scarce-invariant');

    const a = await placeOrder('USDT', productId);
    assert.ok(a.cryptoPayment);

    // Force a second order onto the same product by bypassing the stock check,
    // which is exactly the situation the claim guard exists for.
    const user = await prisma.user.findFirstOrThrow();
    const b = await prisma.order.create({
      data: {
        reference: `RACE${Date.now() % 100000}`,
        userId: user.id,
        status: 'PENDING',
        currency: 'USDT',
        totalAmountMinor: 1_500,
        totalBaseRubMinor: 129_000,
        rateRubMinorPerUnit: 8_600,
        invoicePayload: `ord_race_${Date.now()}`,
        lines: {
          create: {
            productId,
            titleSnapshot: 'Last One',
            unitAmountMinor: 1_500,
            quantity: 1,
            totalAmountMinor: 1_500,
            unitBaseRubMinor: 129_000,
            fulfillmentKind: 'LICENSE_KEY',
          },
        },
      },
    });

    await recordTransfer(a.cryptoPayment.id, a.cryptoPayment.expectedAmountWei);
    await crypto.reconcileIntent(a.cryptoPayment.id);
    const secondPaid = await orders.markOrderPaid({ kind: 'crypto', orderId: b.id });

    // One key, one owner. The second order is FAILED, not holding a duplicate.
    const claimed = await prisma.licenseKey.count({
      where: { productId, claimedAt: { not: null } },
    });
    assert.equal(claimed, 1);
    assert.equal(secondPaid?.status, 'FAILED');
  });
});

describe('USDT checkout: cancellation', () => {
  it('lets a buyer walk away before paying', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/crypto-payment/cancel`,
      headers: { authorization: authHeader() },
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().cryptoPayment.status, 'CANCELLED');
  });

  it('refuses to cancel once funds have arrived', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);

    await recordTransfer(cryptoPayment.id, '1000', { status: 'SEEN' });
    await crypto.reconcileIntent(cryptoPayment.id);

    // Cancelling now would leave a confirmed transfer pointing at a closed intent.
    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/crypto-payment/cancel`,
      headers: { authorization: authHeader() },
      payload: {},
    });
    assert.equal(response.statusCode, 409);
  });
});

describe('Stars checkout still works unchanged', () => {
  it('derives Stars from the same RUB base price', async () => {
    const { order, cryptoPayment } = await placeOrder('XTR', usdtProductId, 1, {
      isSubscribedChannel: true,
    });

    assert.equal(order.currency, 'XTR');
    // 129_000 kopecks / 130 = 992.3... -> 993 whole Stars, always an integer.
    assert.equal(order.totalAmountMinor, starsForRubMinor(BASE_RUB_MINOR, RATES));
    assert.ok(Number.isInteger(order.totalAmountMinor));
    assert.equal(order.totalBaseRubMinor, BASE_RUB_MINOR);
    assert.equal(order.rateRubMinorPerUnit, 130);
    // A Stars order never gets an on-chain payment.
    assert.equal(cryptoPayment, null);
  });

  it('prices one product in both currencies from the same base', async () => {
    // The point of a single base price: the two rails are two views of one number,
    // so they cannot drift apart the way three independent price columns would.
    const stars = await placeOrder('XTR', usdtProductId, 1, {
      isSubscribedChannel: true,
    });
    const usdt = await placeOrder('USDT', usdtProductId, 1, {
      isSubscribedChannel: true,
    });

    assert.equal(stars.order.totalBaseRubMinor, usdt.order.totalBaseRubMinor);
    assert.notEqual(stars.order.currency, usdt.order.currency);
    assert.notEqual(stars.order.rateRubMinorPerUnit, usdt.order.rateRubMinorPerUnit);
  });

  it('keeps an existing order untouched when the rate changes', async () => {
    const { order, cryptoPayment } = await placeOrder('USDT');
    assert.ok(cryptoPayment);
    const quotedWei = cryptoPayment.expectedAmountWei;
    const quotedRate = order.rateRubMinorPerUnit;

    // Rates are configuration. A change must never rewrite what an order that
    // already exists is asking to be paid.
    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const intent = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    assert.equal(reread.rateRubMinorPerUnit, quotedRate);
    assert.equal(intent.expectedAmountWei, quotedWei);
    // And the contract snapshot pins the token too.
    assert.equal(intent.contract, '0x55d398326f99059fF775485246999027B3197955');
  });

  it('charges a legacy XTR-priced product at its stored price', async () => {
    const { order } = await placeOrder('XTR', starProductId);
    // No conversion: 150 stored, and a non-member pays the standard price
    // derived from it (150 / 0.95 = 158).
    assert.equal(order.currency, 'XTR');
    assert.equal(order.totalAmountMinor, 158);
    assert.equal(order.rateRubMinorPerUnit, 1);
  });

  it('defaults to Stars when the client sends no payment currency', async () => {
    // An older Mini App bundle, deployed before this change, sends no
    // `paymentCurrency` at all. It must keep working rather than 400.
    const { createOrderInputSchema } = await import('@shop/shared');
    const parsed = createOrderInputSchema.parse({
      items: [{ productId: usdtProductId, quantity: 1 }],
    });
    assert.equal(parsed.paymentCurrency, 'XTR');
  });

  it('delivers a Stars order through the Telegram path', async () => {
    const { order } = await placeOrder('XTR', starProductId);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

    const paid = await orders.markOrderPaid({
      kind: 'telegram',
      invoicePayload: row.invoicePayload,
      telegramPaymentChargeId: `charge_${randomHex(8)}`,
      providerPaymentChargeId: null,
    });

    assert.equal(paid?.status, 'PAID');
    const delivered = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });
    assert.match(delivered.lines[0]!.deliveredPayload ?? '', /^XTR-KEY-/);
    // The Telegram receipt is still recorded on the order.
    assert.ok(delivered.telegramPaymentChargeId);
  });

  it('has no crypto payment endpoint for a Stars order', async () => {
    const { order } = await placeOrder('XTR');
    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/crypto-payment`,
      headers: { authorization: authHeader() },
      payload: {},
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'CURRENCY_MISMATCH');
  });
});

describe('health reporting', () => {
  it('reports monitor and cursor state without leaking secrets', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);

    const body = response.json() as {
      ok: boolean;
      crypto: { enabled: boolean; derivationReady: boolean; openIntents: number };
    };
    assert.equal(body.ok, true);
    assert.equal(body.crypto.enabled, true);
    assert.equal(body.crypto.derivationReady, true);
    assert.equal(typeof body.crypto.openIntents, 'number');

    // Diagnostics must not include the key or the endpoint URLs, which can carry
    // API keys in their path.
    const raw = response.body.toLowerCase();
    for (const forbidden of ['xpub', 'mnemonic', 'http://', 'https://']) {
      assert.ok(!raw.includes(forbidden), `health leaked "${forbidden}"`);
    }
  });
});
