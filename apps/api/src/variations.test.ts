/**
 * Product variations: listings, aggregates and the invariant that a parent
 * cannot be ordered.
 *
 * Variations are child products (`parentId`), so every rule that already
 * protects a product — license-key stock, the conditional UPDATE, club-tier
 * pricing — applies to them unchanged. What needs pinning down is the parent:
 * it groups children, owns no stock, and must never become an order line.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { effectiveUnitMinor, type Viewer } from '@shop/shared';

const workDir = mkdtempSync(path.join(tmpdir(), 'shop-variations-test-'));
const dbFile = path.join(workDir, 'test.db');
const apiRoot = path.resolve(import.meta.dirname, '..');

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.TELEGRAM_BOT_TOKEN = '424242:AAH-variations-test';
process.env.TELEGRAM_API_ROOT = 'http://127.0.0.1:9';
process.env.PAYMENT_PROVIDER = 'none';
process.env.LOG_LEVEL = 'silent';
process.env.UPLOADS_DIR = path.join(workDir, 'uploads');

let prisma: typeof import('./db.ts')['prisma'];
let catalog: typeof import('./services/catalog.ts');
let orders: typeof import('./services/orders.ts');

let parentId = '';
let usaVariationId = '';
let viewer: Viewer;

before(async () => {
  execFileSync('npx', ['prisma', 'db', 'push', '--url', `file:${dbFile}`], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  ({ prisma } = await import('./db.ts'));
  catalog = await import('./services/catalog.ts');
  orders = await import('./services/orders.ts');

  const usa = await prisma.country.create({
    data: { slug: 'usa', title: 'США', emoji: '🇺🇸', sortOrder: 1 },
  });
  const germany = await prisma.country.create({
    data: { slug: 'germany', title: 'Германия', emoji: '🇩🇪', sortOrder: 2 },
  });
  // Active but with nothing to sell: must stay out of the carousel.
  await prisma.country.create({
    data: { slug: 'japan', title: 'Япония', emoji: '🇯🇵', sortOrder: 3 },
  });

  const parent = await prisma.product.create({
    data: {
      slug: 'bybit',
      title: 'Bybit',
      section: 'ABUSE',
      amountMinor: 0,
      fulfillmentKind: 'LICENSE_KEY',
    },
  });
  parentId = parent.id;

  const usaVariation = await prisma.product.create({
    data: {
      slug: 'bybit-usa',
      title: 'США',
      section: 'ABUSE',
      amountMinor: 500,
      fulfillmentKind: 'LICENSE_KEY',
      parentId: parent.id,
      countryId: usa.id,
    },
  });
  usaVariationId = usaVariation.id;

  const germanyVariation = await prisma.product.create({
    data: {
      slug: 'bybit-de',
      title: 'Германия',
      section: 'ABUSE',
      amountMinor: 800,
      fulfillmentKind: 'LICENSE_KEY',
      parentId: parent.id,
      countryId: germany.id,
    },
  });

  await prisma.licenseKey.createMany({
    data: [
      { productId: usaVariation.id, secret: 'K1' },
      { productId: usaVariation.id, secret: 'K2' },
      { productId: germanyVariation.id, secret: 'K3' },
    ],
  });

  // An ordinary SHOP product, to prove the sections do not leak into each other.
  await prisma.product.create({
    data: {
      slug: 'plain-shop-item',
      title: 'Обычный товар',
      section: 'SHOP',
      amountMinor: 100,
      fulfillmentKind: 'LINK',
      staticPayload: 'https://example.com/x',
    },
  });

  const user = await prisma.user.create({
    data: { telegramId: '770000001', firstName: 'Tester' },
  });
  viewer = {
    id: user.id,
    telegramId: user.telegramId,
    firstName: user.firstName,
    lastName: null,
    username: null,
    languageCode: null,
    displayName: null,
    createdAt: user.createdAt.toISOString(),
    clubChannelUrl: null,
    role: 'USER',
    permissions: [],
    isSubscribedChannel: false,
    isAdmin: false,
  };
});

after(async () => {
  await prisma?.$disconnect();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is harmless.
  }
});

describe('storefront listings', () => {
  it('shows the parent once and never its variations', async () => {
    // The entire point of variations: one product with ten country options must
    // occupy one cell of the grid, not ten.
    const products = await catalog.listProducts({ section: 'ABUSE' });
    const slugs = products.map((p) => p.slug);
    assert.deepEqual(slugs, ['bybit']);
    assert.equal(slugs.includes('bybit-usa'), false);
  });

  it('keeps the two sections separate', async () => {
    const abuse = await catalog.listProducts({ section: 'ABUSE' });
    const shop = await catalog.listProducts({ section: 'SHOP' });
    assert.equal(abuse.some((p) => p.slug === 'plain-shop-item'), false);
    assert.equal(shop.some((p) => p.slug === 'bybit'), false);
  });

  it('reports the cheapest variation price, not the parent price', async () => {
    // The parent's own amountMinor is 0 and is never charged; showing it would
    // advertise a free product.
    const [parent] = await catalog.listProducts({ section: 'ABUSE' });
    assert.equal(parent!.variationCount, 2);
    assert.equal(parent!.minVariationAmountMinor, 500);
    assert.notEqual(parent!.minVariationAmountMinor, parent!.amountMinor);
  });

  it('sums stock across variations so a card is sold out only when all are', async () => {
    const [parent] = await catalog.listProducts({ section: 'ABUSE' });
    assert.equal(parent!.stock, 3, '2 keys + 1 key');
  });

  it('filters parents by the country of their variations', async () => {
    const german = await catalog.listProducts({
      section: 'ABUSE',
      countrySlug: 'germany',
    });
    assert.deepEqual(german.map((p) => p.slug), ['bybit']);

    const japanese = await catalog.listProducts({
      section: 'ABUSE',
      countrySlug: 'japan',
    });
    assert.deepEqual(japanese, [], 'no variation for Japan, so no parent matches');
  });

  it('hides countries that have nothing to sell', async () => {
    // An empty country in the carousel is a filter that returns nothing, which
    // reads as a broken screen rather than as honest "no stock".
    const countries = await catalog.listCountries();
    const slugs = countries.map((c) => c.slug);
    assert.deepEqual(slugs.sort(), ['germany', 'usa']);
    assert.equal(slugs.includes('japan'), false);
  });
});

describe('product page', () => {
  it('returns the variations with their own price, stock and country', async () => {
    const detail = await catalog.getProductBySlug('bybit');
    assert.equal(detail.variations.length, 2);

    const usa = detail.variations.find((v) => v.country?.slug === 'usa');
    assert.equal(usa?.amountMinor, 500);
    assert.equal(usa?.stock, 2);
    assert.equal(usa?.country?.emoji, '🇺🇸');
  });

  it('sorts variations deterministically', async () => {
    // Same sortOrder on both: the tiebreaker is the title, so the list does not
    // reshuffle between requests.
    const first = await catalog.getProductBySlug('bybit');
    const second = await catalog.getProductBySlug('bybit');
    assert.deepEqual(
      first.variations.map((v) => v.slug),
      second.variations.map((v) => v.slug),
    );
  });
});

describe('ordering', () => {
  it('refuses to order a parent, which has no stock of its own', async () => {
    // The client hides the buy button, but the client is not what enforces this:
    // a PENDING order for a parent could never be fulfilled.
    await assert.rejects(
      () => orders.createOrder(viewer, { items: [{ productId: parentId, quantity: 1 }] }),
      (error: unknown) =>
        (error as { code?: string }).code === 'PRODUCT_UNAVAILABLE',
    );
  });

  it('orders a variation at its own price, with the club maths applied', async () => {
    const created = await orders.createOrder(viewer, {
      items: [{ productId: usaVariationId, quantity: 1 }],
    });
    // 500 is the variation's stored club-tier price; this viewer is not a member.
    assert.equal(
      created.order.totalAmountMinor,
      effectiveUnitMinor(500, false),
    );
    assert.equal(created.order.lines[0]!.productId, usaVariationId);
  });

  it('deletes variations with their parent, never orphaning them', async () => {
    // A variation has no meaning on its own, so the relation cascades. Checked
    // on throwaway rows: the ones above are referenced by an order.
    const parent = await prisma.product.create({
      data: {
        slug: 'temp-parent',
        title: 'Temp',
        section: 'ABUSE',
        amountMinor: 0,
        fulfillmentKind: 'LICENSE_KEY',
      },
    });
    const child = await prisma.product.create({
      data: {
        slug: 'temp-parent-child',
        title: 'Child',
        section: 'ABUSE',
        amountMinor: 100,
        fulfillmentKind: 'LICENSE_KEY',
        parentId: parent.id,
      },
    });

    await prisma.product.delete({ where: { id: parent.id } });
    const orphan = await prisma.product.findUnique({ where: { id: child.id } });
    assert.equal(orphan, null);
  });
});
