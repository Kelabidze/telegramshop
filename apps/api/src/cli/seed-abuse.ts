/**
 * Seeds the root products of the «Всё для Абуза» section.
 *
 *   npm run db:seed:abuse                                    # dev
 *   node --env-file=<api.env> dist/cli/seed-abuse.js         # production
 *
 * Parents only: their country variations are added later through the admin
 * panel. A parent has no stock of its own and cannot be ordered — `createOrder`
 * refuses it — so seeding these is safe on a live shop: they show up as cards
 * that lead to an empty selector, never as something buyable at the wrong price.
 *
 * Idempotent by slug. Existing rows are left completely alone rather than
 * updated: a title or artwork edited through the admin panel must survive.
 */
import { config } from '../config.js';
import { disconnectDb, prisma } from '../db.js';

/** Display name -> slug. Order here is the display order. */
const ROOT_PRODUCTS: ReadonlyArray<{ title: string; slug: string }> = [
  { title: 'Bybit', slug: 'bybit' },
  { title: 'OKX', slug: 'okx' },
  { title: 'Binance', slug: 'binance' },
  { title: 'Bingx', slug: 'bingx' },
  { title: 'Arkham', slug: 'arkham' },
  { title: 'SandBox', slug: 'sandbox' },
  { title: 'BitGet', slug: 'bitget' },
  { title: 'Whitebit', slug: 'whitebit' },
  { title: 'Galxe', slug: 'galxe' },
  { title: 'KuCoin', slug: 'kucoin' },
  { title: 'Mexc', slug: 'mexc' },
  { title: 'BackPack', slug: 'backpack' },
  { title: 'Bitmart', slug: 'bitmart' },
  { title: 'Buidlpad', slug: 'buidlpad' },
  { title: 'Gate.io', slug: 'gate-io' },
  { title: 'Weex', slug: 'weex' },
  { title: 'Solayer', slug: 'solayer' },
  { title: 'Holonym', slug: 'holonym' },
  { title: 'Fragment', slug: 'fragment' },
  { title: 'Bitunix', slug: 'bitunix' },
  { title: 'Mexc withdrawal', slug: 'mexc-withdrawal' },
  { title: 'Coinbase', slug: 'coinbase' },
  { title: 'ByBit EU', slug: 'bybit-eu' },
];

async function main(): Promise<void> {
  console.log(`Seeding «Всё для Абуза» roots into ${config.databaseUrl}`);

  let created = 0;
  let kept = 0;

  for (const [index, product] of ROOT_PRODUCTS.entries()) {
    const existing = await prisma.product.findUnique({
      where: { slug: product.slug },
      select: { id: true },
    });

    if (existing) {
      kept += 1;
      continue;
    }

    await prisma.product.create({
      data: {
        slug: product.slug,
        title: product.title,
        description: '',
        section: 'ABUSE',
        // A parent's own price is never charged: the card shows "from X" derived
        // from its variations. Zero keeps it obvious that nothing is set here.
        amountMinor: 0,
        currency: 'RUB',
        fulfillmentKind: 'LICENSE_KEY',
        // Emoji rather than an image: nobody has uploaded artwork yet, and a
        // blank square is worse than a placeholder.
        emoji: '🎯',
        isActive: true,
        sortOrder: index + 1,
      },
    });
    created += 1;
  }

  console.log(`Done. created ${created}, kept ${kept}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void disconnectDb());
