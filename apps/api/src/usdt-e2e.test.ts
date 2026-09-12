import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The whole USDT purchase, driven through HTTP the way the Mini App drives it.
 *
 * The other crypto suites test layers: conversions, log decoding, reconciliation
 * decisions. This one checks that the layers are wired together РІР‚вЂќ that a buyer
 * who only ever touches the public API gets from a rouble-priced product to a
 * delivered licence key, and that every figure they are shown along the way is
 * the figure the next stage actually uses.
 *
 * The chain is the one part that cannot be real here: there is no way to make BSC
 * finalise a block on demand. Transfers are written the way the monitor writes
 * them after decoding a log, which `monitor.test.ts` covers against a fake node.
 */

const workDir = mkdtempSync(path.join(tmpdir(), 'shop-e2e-test-'));
const dbFile = path.join(workDir, 'test.db');
const apiRoot = path.resolve(import.meta.dirname, '..');

/** The fake exchange. `askPrice` is mutated to move the market mid-test. */
const rapira = { askPrice: 87.7, calls: 0 };
let rapiraServer: import('node:http').Server;

const BOT_TOKEN = '424242:AAH-integration-test-token';
// Watch-only key for the published Hardhat test mnemonic. Leaks nothing.
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
process.env.CRYPTO_PAYMENTS_ENABLED = 'true';
process.env.CRYPTO_DEPOSIT_XPUB = TEST_XPUB;
process.env.CRYPTO_MONITOR_INTERVAL_SECONDS = '0';
/**
 * Rapira points at a local server, not the exchange.
 *
 * The rate has to be controllable: this suite asserts exact USDT amounts, and one
 * test moves the market to prove an existing order does not follow it. A live
 * exchange would make both non-deterministic and would need network access.
 */
process.env.RAPIRA_ENABLED = 'true';
process.env.RAPIRA_RATE_SIDE = 'ask';
process.env.RAPIRA_RATE_CACHE_SECONDS = '60';
process.env.USDT_RUB_RATE = '86';
process.env.STAR_RUB_MINOR_RATE = '130';

let app: Awaited<ReturnType<typeof import('./server.ts')['buildServer']>>;
let prisma: typeof import('./db.ts')['prisma'];
let crypto: typeof import('./services/crypto-payments.ts');
let createSignedInitData: typeof import('./telegram/init-data.ts')['createSignedInitData'];

const BUYER = 700_100;
let productId = '';

function auth(telegramId = BUYER): string {
  return `tma ${createSignedInitData(
    {
      user: JSON.stringify({ id: telegramId, first_name: 'E2E' }),
      auth_date: String(Math.floor(Date.now() / 1000)),
    },
    BOT_TOKEN,
  )}`;
}

function randomHex(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  }
  return out;
}

before(async () => {
  // Fake exchange first: config reads its URL at import time.
  const { createServer } = await import('node:http');
  rapiraServer = createServer((_req, res) => {
    rapira.calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 0,
        isWorking: 1,
        data: [
          { symbol: 'BTC/RUB', askPrice: 9_500_000, bidPrice: 9_490_000 },
          { symbol: 'USDT/RUB', askPrice: rapira.askPrice, bidPrice: rapira.askPrice - 0.03 },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => rapiraServer.listen(0, '127.0.0.1', resolve));
  const rapiraAddress = rapiraServer.address();
  const rapiraPort =
    typeof rapiraAddress === 'object' && rapiraAddress ? rapiraAddress.port : 0;
  process.env.RAPIRA_BASE_URL = `http://127.0.0.1:${rapiraPort}`;

  execFileSync('npx', ['prisma', 'db', 'push', '--url', `file:${dbFile}`], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  ({ createSignedInitData } = await import('./telegram/init-data.ts'));
  ({ prisma } = await import('./db.ts'));
  crypto = await import('./services/crypto-payments.ts');
  const { buildServer } = await import('./server.ts');
  app = await buildServer();
  await app.ready();

  const category = await prisma.category.create({
    data: { slug: 'e2e', title: 'E2E', sortOrder: 1 },
  });
  // 1290 РІвЂљР…. At 86 РІвЂљР…/USDT that is exactly 15.00 USDT for a club member.
  const product = await prisma.product.create({
    data: {
      slug: 'e2e-item',
      title: 'E2E Item',
      description: 'Priced in roubles.',
      amountMinor: 129_000,
      currency: 'RUB',
      fulfillmentKind: 'LICENSE_KEY',
      categoryId: category.id,
    },
  });
  productId = product.id;
  await prisma.licenseKey.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      productId: product.id,
      secret: `E2E-KEY-${i + 1}`,
    })),
  });
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
  await new Promise<void>((resolve) => rapiraServer.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

describe('USDT purchase, end to end over HTTP', () => {
  it('carries one amount from the catalog through to a delivered key', async () => {
    // --- 1. The storefront quotes a rouble price and offers both rails --------
    const options = await app.inject({
      method: 'GET',
      url: '/api/payment-options',
    });
    assert.equal(options.statusCode, 200);
    const { rates, usdtAvailable } = options.json();
    assert.equal(usdtAvailable, true);
    // The LIVE rate is what the preview shows, so it matches what checkout quotes.
    assert.equal(rates.usdtRubMinorPerUnit, 8_770);

    const catalog = await app.inject({ method: 'GET', url: '/api/products' });
    const listed = catalog.json().products.find((p: { id: string }) => p.id === productId);
    assert.equal(listed.currency, 'RUB');
    assert.equal(listed.amountMinor, 129_000);
    assert.equal(listed.stock, 10);

    // --- 2. Checkout in USDT -------------------------------------------------
    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: auth() },
      payload: {
        items: [{ productId, quantity: 1 }],
        paymentCurrency: 'USDT',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json();

    assert.equal(session.order.currency, 'USDT');
    assert.equal(session.invoiceUrl, null, 'on-chain orders get no invoice link');
    assert.ok(session.cryptoPayment, 'the intent must come back with the order');

    // The order records why it asks for this number, not just the number.
    //
    // This buyer is not a channel member (no club channel is configured here), so
    // the base is the STANDARD price derived from the stored club-tier one РІР‚вЂќ and
    // that derived figure is what gets snapshotted and converted.
    const { effectiveUnitMinor } = await import('@shop/shared');
    const expectedBase = effectiveUnitMinor(listed.amountMinor, false);
    assert.equal(session.order.totalBaseRubMinor, expectedBase);
    assert.ok(
      expectedBase > listed.amountMinor,
      'a non-member must be quoted above the club price',
    );
    // The live rate from the (fake) exchange, in kopecks per USDT, plus where it
    // came from вЂ” an order kept for months should say which claim it was priced on.
    assert.equal(session.order.rateRubMinorPerUnit, 8_770);
    assert.equal(session.order.rateSource, 'RAPIRA');
    assert.equal(session.order.rateSide, 'ask');
    assert.ok(session.order.rateFetchedAt);

    // --- 3. Every figure the buyer sees agrees with the next stage -----------
    const payment = session.cryptoPayment;
    assert.equal(payment.expectedAmountMinor, session.order.totalAmountMinor);
    assert.match(payment.depositAddress, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(payment.status, 'AWAITING');
    assert.equal(payment.chainId, 56);
    assert.equal(payment.decimals, 18);

    // The displayed string, parsed back the way a wallet would, must equal the
    // wei the intent will be reconciled against.
    const [whole, fraction = ''] = payment.expectedAmountDisplay.split('.');
    const walletWei =
      BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
    assert.equal(walletWei.toString(), payment.expectedAmountWei);

    // --- 4. The stock is held while the payment is in flight ----------------
    const during = await app.inject({ method: 'GET', url: '/api/products' });
    const held = during.json().products.find((p: { id: string }) => p.id === productId);
    assert.equal(held.stock, 9, 'the unit being paid for must leave the shelf');

    // --- 5. Re-opening the payment is idempotent ----------------------------
    const reopened = await app.inject({
      method: 'POST',
      url: `/api/orders/${session.order.id}/crypto-payment`,
      headers: { authorization: auth() },
      payload: {},
    });
    assert.equal(reopened.statusCode, 200, 'nothing new was created');
    assert.equal(reopened.json().cryptoPayment.id, payment.id);
    assert.equal(
      reopened.json().cryptoPayment.depositAddress,
      payment.depositAddress,
      'a reload must not issue a second address',
    );

    // --- 6. The transfer arrives and finalises ------------------------------
    const intentRow = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
      where: { id: payment.id },
      select: { walletId: true },
    });
    await prisma.cryptoTransaction.create({
      data: {
        txHash: `0x${randomHex(64)}`,
        logIndex: 0,
        walletId: intentRow.walletId,
        intentId: payment.id,
        fromAddress: `0x${randomHex(40)}`,
        // Exactly what the screen told the buyer to send.
        amountWei: payment.expectedAmountWei,
        blockNumber: 1_000n,
        blockHash: `0x${randomHex(64)}`,
        status: 'CONFIRMED',
        confirmations: 3,
        confirmedAt: new Date(),
      },
    });

    // --- 7. The buyer polls, and the poll reconciles ------------------------
    const polled = await app.inject({
      method: 'GET',
      url: `/api/orders/${session.order.id}/crypto-payment`,
      headers: { authorization: auth() },
    });
    assert.equal(polled.statusCode, 200);
    const settled = polled.json().cryptoPayment;
    assert.equal(settled.status, 'CONFIRMED');
    assert.equal(settled.receivedAmountWei, payment.expectedAmountWei);
    assert.ok(settled.confirmedAt);
    assert.equal(settled.transactions.length, 1);

    // --- 8. The order is paid and the goods delivered -----------------------
    const orders = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { authorization: auth() },
    });
    const mine = orders.json().orders.find(
      (o: { id: string }) => o.id === session.order.id,
    );
    assert.equal(mine.status, 'PAID');
    assert.ok(mine.paidAt);
    assert.match(mine.lines[0].deliveredPayload, /^E2E-KEY-/);

    // Exactly one key, and it is the one the buyer now holds.
    const claimed = await prisma.licenseKey.findMany({
      where: { productId, claimedAt: { not: null } },
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.secret, mine.lines[0].deliveredPayload);
    // The hold was consumed by the claim, not left behind.
    assert.equal(claimed[0]!.reservedForLineId, null);

    // --- 9. Polling again changes nothing -----------------------------------
    for (let i = 0; i < 3; i += 1) {
      const again = await app.inject({
        method: 'GET',
        url: `/api/orders/${session.order.id}/crypto-payment`,
        headers: { authorization: auth() },
      });
      assert.equal(again.json().cryptoPayment.status, 'CONFIRMED');
    }
    const stillOne = await prisma.licenseKey.count({
      where: { productId, claimedAt: { not: null } },
    });
    assert.equal(stillOne, 1, 'repeated polling must not claim a second key');

    // --- 10. No secret material anywhere in what the client received --------
    for (const body of [created.body, polled.body, reopened.body]) {
      const lower = body.toLowerCase();
      for (const forbidden of [
        'xpub',
        'xprv',
        'mnemonic',
        'privatekey',
        'private_key',
        'seedphrase',
        'derivationindex',
        'derivationpath',
      ]) {
        assert.ok(!lower.includes(forbidden), `response leaked "${forbidden}"`);
      }
    }
  });

  it('does not reprice an existing order when the market moves', async () => {
    /*
     * The property the live-rate change rests on. A buyer is quoted a USDT amount
     * from the rate at one instant; if the market moves before they pay, the amount
     * they were told to send must not change underneath them — otherwise a correct
     * payment silently becomes an underpayment through no fault of theirs.
     */
    const { resetRateCache, getUsdtRubRate } = await import(
      './payments/rapira-rates.ts'
    );

    rapira.askPrice = 87.7;
    resetRateCache();

    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: auth(BUYER + 40) },
      payload: { items: [{ productId, quantity: 1 }], paymentCurrency: 'USDT' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json();

    const quotedRate = session.order.rateRubMinorPerUnit;
    const quotedTotal = session.order.totalAmountMinor;
    const quotedWei = session.cryptoPayment.expectedAmountWei;
    const quotedDisplay = session.cryptoPayment.expectedAmountDisplay;
    assert.equal(quotedRate, 8_770);

    // The market moves by ~9%, and the cache is cleared so a refetch sees it.
    rapira.askPrice = 96.0;
    resetRateCache();
    const moved = await getUsdtRubRate();
    assert.equal(moved.rateRubMinorPerUnit, 9_600, 'premise: the rate did move');

    // Re-read everything the buyer could see. All of it must be unchanged.
    const reread = await app.inject({
      method: 'GET',
      url: `/api/orders/${session.order.id}/crypto-payment`,
      headers: { authorization: auth(BUYER + 40) },
    });
    assert.equal(reread.statusCode, 200);
    const payment = reread.json().cryptoPayment;
    assert.equal(payment.expectedAmountWei, quotedWei, 'the chain amount changed');
    assert.equal(payment.expectedAmountDisplay, quotedDisplay);

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: session.order.id },
    });
    assert.equal(row.rateRubMinorPerUnit, quotedRate, 'the snapshot was rewritten');
    assert.equal(row.totalAmountMinor, quotedTotal);
    assert.equal(row.rateSource, 'RAPIRA');

    // A NEW order, however, is priced at the new rate — the snapshot is per order,
    // not a frozen global.
    const later = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: auth(BUYER + 41) },
      payload: { items: [{ productId, quantity: 1 }], paymentCurrency: 'USDT' },
    });
    assert.equal(later.json().order.rateRubMinorPerUnit, 9_600);
    assert.notEqual(later.json().order.totalAmountMinor, quotedTotal);

    // Restore, so later tests see the original rate.
    rapira.askPrice = 87.7;
    resetRateCache();
  });

  it('keeps roubles and Stars working when the exchange is unreachable', async () => {
    /*
     * A dead exchange must cost one rail, not the shop. USDT cannot be quoted
     * without a rate — refusing is the honest answer — but roubles need no rate at
     * all and Stars use a configured one.
     */
    const { resetRateCache } = await import('./payments/rapira-rates.ts');
    const { config } = await import('./config.ts');

    // Point the client at a closed port and clear the cache: the rate is now
    // genuinely unobtainable.
    const original = config.rapira.baseUrl;
    Object.defineProperty(config.rapira, 'baseUrl', {
      value: 'http://127.0.0.1:1',
      configurable: true,
    });
    resetRateCache();

    try {
      // USDT is refused, with a status that says "try later".
      const usdt = await app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { authorization: auth(BUYER + 42) },
        payload: { items: [{ productId, quantity: 1 }], paymentCurrency: 'USDT' },
      });
      assert.equal(usdt.statusCode, 503, usdt.body);
      assert.equal(usdt.json().error.code, 'RATE_UNAVAILABLE');

      // Stars still work.
      const stars = await app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { authorization: auth(BUYER + 43) },
        payload: { items: [{ productId, quantity: 1 }], paymentCurrency: 'XTR' },
      });
      assert.equal(stars.statusCode, 201, stars.body);
      assert.equal(stars.json().order.currency, 'XTR');

      // And the storefront still loads, with no USDT rate offered.
      const options = await app.inject({
        method: 'GET',
        url: '/api/payment-options',
      });
      assert.equal(options.statusCode, 200);
      assert.equal(options.json().usdtRate, null);
      assert.equal(
        options.json().usdtAvailable,
        false,
        'a rail with no rate must not be offered',
      );
    } finally {
      Object.defineProperty(config.rapira, 'baseUrl', {
        value: original,
        configurable: true,
      });
      resetRateCache();
    }
  });

  it('leaves the Stars path untouched', async () => {
    // The same rouble-priced product, paid the old way, still works.
    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: auth(BUYER + 1) },
      payload: {
        items: [{ productId, quantity: 1 }],
        paymentCurrency: 'XTR',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json();

    assert.equal(session.order.currency, 'XTR');
    assert.equal(session.cryptoPayment, null, 'Stars orders get no intent');
    assert.equal(session.order.rateRubMinorPerUnit, 130);
    // Whole Stars, derived from the same base the USDT order used РІР‚вЂќ the standard
    // price, since this buyer is not a club member either.
    const { effectiveUnitMinor, starsForRubMinor } = await import('@shop/shared');
    const base = effectiveUnitMinor(129_000, false);
    assert.equal(session.order.totalBaseRubMinor, base);
    assert.ok(Number.isInteger(session.order.totalAmountMinor));
    assert.equal(
      session.order.totalAmountMinor,
      starsForRubMinor(base, {
        usdtRubMinorPerUnit: 8_770,
        starRubMinorPerUnit: 130,
      }),
    );

    // No hold is taken for Stars: it settles in seconds.
    const line = await prisma.orderLine.findFirstOrThrow({
      where: { orderId: session.order.id },
    });
    const heldForStars = await prisma.licenseKey.count({
      where: { reservedForLineId: line.id },
    });
    assert.equal(heldForStars, 0);

    // And the Telegram settlement path delivers.
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: session.order.id },
    });
    const { markOrderPaid } = await import('./services/orders.ts');
    const paid = await markOrderPaid({
      kind: 'telegram',
      invoicePayload: row.invoicePayload,
      telegramPaymentChargeId: `charge_${randomHex(8)}`,
      providerPaymentChargeId: null,
    });
    assert.equal(paid?.status, 'PAID');
    assert.match(paid!.lines[0]!.deliveredPayload!, /^E2E-KEY-/);
  });

  it('refuses a second intent on an order that is already paid', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: auth(BUYER + 2) },
      payload: { items: [{ productId, quantity: 1 }], paymentCurrency: 'USDT' },
    });
    const session = created.json();

    const intentRow = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
      where: { id: session.cryptoPayment.id },
      select: { walletId: true },
    });
    await prisma.cryptoTransaction.create({
      data: {
        txHash: `0x${randomHex(64)}`,
        logIndex: 0,
        walletId: intentRow.walletId,
        intentId: session.cryptoPayment.id,
        fromAddress: `0x${randomHex(40)}`,
        amountWei: session.cryptoPayment.expectedAmountWei,
        blockNumber: 1_001n,
        blockHash: `0x${randomHex(64)}`,
        status: 'CONFIRMED',
        confirmations: 3,
        confirmedAt: new Date(),
      },
    });
    await crypto.reconcileIntent(session.cryptoPayment.id);

    // Asking again returns the settled intent rather than opening a new one: a
    // second address on a paid order would be an invitation to pay twice.
    const again = await app.inject({
      method: 'POST',
      url: `/api/orders/${session.order.id}/crypto-payment`,
      headers: { authorization: auth(BUYER + 2) },
      payload: {},
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().cryptoPayment.status, 'CONFIRMED');
    assert.equal(again.json().cryptoPayment.id, session.cryptoPayment.id);

    const intents = await prisma.cryptoPaymentIntent.count({
      where: { orderId: session.order.id },
    });
    assert.equal(intents, 1);
  });

  it('reports monitor state through /health without leaking anything', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);

    const { crypto: diag } = res.json();
    assert.equal(diag.enabled, true);
    assert.equal(diag.derivationReady, true);
    // The numbers an operator needs to tell "working" from "stuck".
    assert.equal(typeof diag.openIntents, 'number');
    assert.equal(typeof diag.rpcFailures, 'number');
    assert.equal(typeof diag.degraded, 'boolean');

    const lower = res.body.toLowerCase();
    for (const forbidden of ['xpub', 'mnemonic', 'http://', 'https://']) {
      assert.ok(!lower.includes(forbidden), `health leaked "${forbidden}"`);
    }
  });
});
