/**
 * Seeds a demo catalog of digital products.
 * Idempotent: re-running updates existing rows instead of duplicating them.
 *
 *   npm run db:seed                                  # dev, through tsx
 *   node --env-file=<api.env> dist/cli/seed.js       # production
 *
 * Why it lives under src/ instead of prisma/: `tsc` compiles everything here,
 * so the production server gets a plain .js entry point. tsx is a
 * devDependency and is absent from the deployed artifact.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { FulfillmentKind } from '@shop/shared';
import { config } from '../config.js';
import { disconnectDb, prisma } from '../db.js';

/** Readable fake license key, e.g. "SHOP-4F2A-9C1D-77B0". */
function fakeLicenseKey(prefix: string): string {
  const group = () => randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${group()}-${group()}-${group()}`;
}

const categories = [
  { slug: 'templates', title: 'РЁР°Р±Р»РѕРЅС‹', emoji: 'рџЋЁ', sortOrder: 1 },
  { slug: 'courses', title: 'РљСѓСЂСЃС‹', emoji: 'рџЋ“', sortOrder: 2 },
  { slug: 'tools', title: 'РРЅСЃС‚СЂСѓРјРµРЅС‚С‹', emoji: 'рџ› ', sortOrder: 3 },
  { slug: 'ai', title: 'РР', emoji: 'рџ¤–', sortOrder: 4 },
  { slug: 'appstore-cards', title: 'РљР°СЂС‚С‹ AppStore', emoji: 'пЈї', sortOrder: 5 },
  { slug: 'digital-cards', title: 'Р¦РёС„СЂРѕРІС‹Рµ РєР°СЂС‚С‹', emoji: 'рџ’і', sortOrder: 6 },
];

// Administrators come from ADMIN_TELEGRAM_IDS, never from a constant in this
// file: the previous version compared a placeholder against its own value, so
// the branch was unreachable and enabling it required editing and rebuilding
// the source. The env var is also what plugins/auth.ts enforces on every login,
// so seeding from anywhere else would immediately drift.

interface SeedProductBase {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  /**
   * Base price in RUB kopecks вЂ” the one price a product has.
   *
   * What a buyer pays in Stars or USDT is derived from this at checkout with the
   * server's configured rates, so seeding a single figure is enough.
   */
  amountMinor: number;
  compareAtMinor: number | null;
  categorySlug: string;
  sortOrder: number;
}

/**
 * Stock is rows in LicenseKey, so a keyed product declares how many keys to
 * keep unclaimed; the others carry the payload they hand out. Splitting the two
 * shapes lets the compiler вЂ” rather than a cast вЂ” guarantee that a keyed
 * product never gets a staticPayload and vice versa.
 */
type SeedProduct = SeedProductBase &
  (
    | { fulfillmentKind: 'LICENSE_KEY'; keyPrefix: string; keyCount: number }
    | {
        fulfillmentKind: Exclude<FulfillmentKind, 'LICENSE_KEY'>;
        staticPayload: string;
      }
  );

const products: SeedProduct[] = [
  {
    slug: 'notion-dashboard',
    title: 'Notion-РґР°С€Р±РѕСЂРґ',
    subtitle: 'Р›РёС‡РЅР°СЏ РїСЂРѕРґСѓРєС‚РёРІРЅРѕСЃС‚СЊ',
    description:
      'Р“РѕС‚РѕРІС‹Р№ С€Р°Р±Р»РѕРЅ Notion: С†РµР»Рё, Р·Р°РґР°С‡Рё, РїСЂРёРІС‹С‡РєРё Рё Р±СЋРґР¶РµС‚ РІ РѕРґРЅРѕРј РјРµСЃС‚Рµ. ' +
      'РџРѕСЃР»Рµ РѕРїР»Р°С‚С‹ РІС‹ РїРѕР»СѓС‡РёС‚Рµ РїРµСЂСЃРѕРЅР°Р»СЊРЅС‹Р№ РєР»СЋС‡ Р°РєС‚РёРІР°С†РёРё.',
    amountMinor: 19_500,
    compareAtMinor: 32_500,
    categorySlug: 'templates',
    fulfillmentKind: 'LICENSE_KEY',
    keyPrefix: 'NOTION',
    keyCount: 25,
    sortOrder: 1,
  },
  {
    slug: 'figma-ui-kit',
    title: 'Figma UI Kit',
    subtitle: '120+ РєРѕРјРїРѕРЅРµРЅС‚РѕРІ',
    description:
      'РќР°Р±РѕСЂ РєРѕРјРїРѕРЅРµРЅС‚РѕРІ РґР»СЏ Р±С‹СЃС‚СЂРѕРіРѕ РїСЂРѕС‚РѕС‚РёРїРёСЂРѕРІР°РЅРёСЏ РјРѕР±РёР»СЊРЅС‹С… РёРЅС‚РµСЂС„РµР№СЃРѕРІ. ' +
      'Auto-layout, variants, С‚С‘РјРЅР°СЏ С‚РµРјР°.',
    amountMinor: 39_000,
    compareAtMinor: null,
    categorySlug: 'templates',
    fulfillmentKind: 'LICENSE_KEY',
    keyPrefix: 'FIGMA',
    keyCount: 10,
    sortOrder: 2,
  },
  {
    slug: 'telegram-bot-course',
    title: 'РљСѓСЂСЃ РїРѕ Telegram-Р±РѕС‚Р°Рј',
    subtitle: '6 С‡Р°СЃРѕРІ РІРёРґРµРѕ',
    description:
      'РћС‚ РїРµСЂРІРѕРіРѕ /start РґРѕ РїР»Р°С‚РµР¶РµР№ Рё РґРµРїР»РѕСЏ. РџСЂР°РєС‚РёС‡РµСЃРєРёРµ РїСЂРёРјРµСЂС‹ РЅР° TypeScript. ' +
      'Р”РѕСЃС‚СѓРї РІС‹РґР°С‘С‚СЃСЏ СЃСЂР°Р·Сѓ РїРѕСЃР»Рµ РѕРїР»Р°С‚С‹.',
    amountMinor: 65_000,
    compareAtMinor: 104_000,
    categorySlug: 'courses',
    fulfillmentKind: 'LINK',
    staticPayload: 'https://example.com/courses/telegram-bots?access=demo',
    sortOrder: 3,
  },
  {
    slug: 'seo-checklist',
    title: 'SEO-С‡РµРєР»РёСЃС‚',
    subtitle: 'PDF, 32 СЃС‚СЂР°РЅРёС†С‹',
    description:
      'РџРѕС€Р°РіРѕРІС‹Р№ Р°СѓРґРёС‚ СЃР°Р№С‚Р°: С‚РµС…РЅРёС‡РµСЃРєРёРµ РѕС€РёР±РєРё, РєРѕРЅС‚РµРЅС‚, СЃСЃС‹Р»РєРё. ' +
      'РЎСЃС‹Р»РєР° РЅР° СЃРєР°С‡РёРІР°РЅРёРµ РїСЂРёС…РѕРґРёС‚ РІ С‡Р°С‚.',
    amountMinor: 13_000,
    compareAtMinor: null,
    categorySlug: 'tools',
    fulfillmentKind: 'FILE',
    staticPayload: 'https://example.com/files/seo-checklist.pdf',
    sortOrder: 4,
  },
  {
    slug: 'starter-pack',
    title: 'РЎС‚Р°СЂС‚РѕРІС‹Р№ РЅР°Р±РѕСЂ',
    subtitle: 'Р‘РµСЃРїР»Р°С‚РЅРѕ',
    description:
      'РќРµР±РѕР»СЊС€РѕР№ Р±РµСЃРїР»Р°С‚РЅС‹Р№ РЅР°Р±РѕСЂ РёРєРѕРЅРѕРє Рё РїСЂРµСЃРµС‚РѕРІ, С‡С‚РѕР±С‹ РїРѕРїСЂРѕР±РѕРІР°С‚СЊ РјР°РіР°Р·РёРЅ. ' +
      'РћРїР»Р°С‚Р° РЅРµ С‚СЂРµР±СѓРµС‚СЃСЏ.',
    amountMinor: 0,
    compareAtMinor: null,
    categorySlug: 'tools',
    fulfillmentKind: 'LINK',
    staticPayload: 'https://example.com/files/starter-pack.zip',
    sortOrder: 5,
  },
];

/**
 * Refuse to seed a database that does not exist yet.
 *
 * Without this check, forgetting the env file in production is silent:
 * DATABASE_URL falls back to `file:./prisma/dev.db`, better-sqlite3 happily
 * creates that file inside the release directory, the script reports success вЂ”
 * and the live catalog stays empty.
 */
function requireExistingDatabase(): void {
  if (config.databaseUrl === ':memory:') return;
  if (existsSync(config.databaseUrl)) return;

  console.error(
    `Database file not found: ${config.databaseUrl}\n` +
      '  dev:        run "npm run db:push" first to create it from the schema\n' +
      '  production: point at the real database explicitly, e.g.\n' +
      '    node --env-file=/srv/shop/shared/api.env dist/cli/seed.js',
  );
  process.exit(1);
}

/** Tops the product up to `keyCount` unclaimed keys, never removing any. */
async function topUpLicenseKeys(
  productId: string,
  slug: string,
  keyPrefix: string,
  keyCount: number,
): Promise<void> {
  const existing = await prisma.licenseKey.count({
    where: { productId, claimedAt: null },
  });
  const missing = keyCount - existing;
  if (missing <= 0) return;

  // `secret` is unique per product, so retry on the rare collision.
  const secrets = new Set<string>();
  while (secrets.size < missing) secrets.add(fakeLicenseKey(keyPrefix));

  await prisma.licenseKey.createMany({
    data: [...secrets].map((secret) => ({ productId, secret })),
  });
  console.log(`  ${slug}: +${missing} license keys`);
}

/**
 * Creates a user row with role ADMIN for every id in ADMIN_TELEGRAM_IDS.
 *
 * Strictly a convenience: `plugins/auth.ts` promotes these ids on their first
 * login anyway. Seeding them up front means an admin UI can list administrators
 * before they have ever opened the app.
 *
 * `firstName` is a placeholder вЂ” the real name arrives from Telegram on first
 * login and overwrites it. Existing rows keep their name, so re-running never
 * clobbers real data.
 */
async function seedAdmins(): Promise<void> {
  const adminIds = [...config.adminTelegramIds];
  if (adminIds.length === 0) {
    console.log(
      '  no ADMIN_TELEGRAM_IDS configured; nobody will have admin access',
    );
    return;
  }

  for (const telegramId of adminIds) {
    await prisma.user.upsert({
      where: { telegramId },
      update: { role: 'ADMIN', isAdmin: true },
      create: { telegramId, firstName: 'Admin', role: 'ADMIN', isAdmin: true },
    });
  }
  console.log(`  admins: ${adminIds.join(', ')}`);
}

/**
 * Two demo banners for the home strip.
 *
 * Matched by title, since a banner has no natural unique key. Existing rows are
 * left alone rather than updated: a banner edited through the API must not be
 * reset by a re-run. Same rule as `seed-banners.ts`, which does only this part
 * and is the one safe to run on a live server.
 *
 * `section` is spelled out rather than left to the column default: a banner is
 * now tied to a screen, and a demo row that lands in the wrong one is a puzzle
 * for whoever opens the admin panel first.
 */
async function seedBanners(hasCategories: boolean): Promise<void> {
  const banners = [
    {
      title: 'РљСѓСЂСЃС‹ СЃРѕ СЃРєРёРґРєРѕР№',
      subtitle: 'РџРѕРґР±РѕСЂРєР° РЅРµРґРµР»Рё',
      linkUrl: hasCategories ? 'category:courses' : null,
      sortOrder: 1,
      section: 'SHOP',
    },
    {
      title: 'РљР»СѓР±РЅС‹Р№ С‚Р°СЂРёС„ 5%',
      subtitle: 'РџРѕРґРїРёС€РёС‚РµСЃСЊ РЅР° РєР°РЅР°Р»',
      linkUrl: config.clubChannel.url || null,
      sortOrder: 2,
      section: 'SHOP',
    },
  ];

  let created = 0;
  for (const banner of banners) {
    const existing = await prisma.banner.findFirst({
      where: { title: banner.title },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.banner.create({ data: banner });
    created += 1;
  }
  console.log(`  banners: ${created} created, ${banners.length - created} kept`);
}

async function main() {
  requireExistingDatabase();
  console.log(`Seeding database at ${config.databaseUrl}`);

  const categoryIdBySlug = new Map<string, string>();
  for (const category of categories) {
    const row = await prisma.category.upsert({
      where: { slug: category.slug },
      update: category,
      create: category,
    });
    categoryIdBySlug.set(row.slug, row.id);
  }
  console.log(`  categories: ${categories.length}`);

  for (const product of products) {
    const data = {
      slug: product.slug,
      title: product.title,
      subtitle: product.subtitle,
      description: product.description,
      amountMinor: product.amountMinor,
      compareAtMinor: product.compareAtMinor,
      currency: 'RUB',
      fulfillmentKind: product.fulfillmentKind,
      sortOrder: product.sortOrder,
      categoryId: categoryIdBySlug.get(product.categorySlug) ?? null,
      staticPayload:
        product.fulfillmentKind === 'LICENSE_KEY'
          ? null
          : product.staticPayload,
      isActive: true,
    };

    const row = await prisma.product.upsert({
      where: { slug: product.slug },
      update: data,
      create: data,
    });

    if (product.fulfillmentKind === 'LICENSE_KEY') {
      await topUpLicenseKeys(
        row.id,
        product.slug,
        product.keyPrefix,
        product.keyCount,
      );
    }
  }
  console.log(`  products: ${products.length}`);

  await seedBanners(categoryIdBySlug.size > 0);

  await seedAdmins();

  console.log('Done.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void disconnectDb());
