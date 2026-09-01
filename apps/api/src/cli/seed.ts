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
  { slug: 'templates', title: 'Шаблоны', emoji: '🎨', sortOrder: 1 },
  { slug: 'courses', title: 'Курсы', emoji: '🎓', sortOrder: 2 },
  { slug: 'tools', title: 'Инструменты', emoji: '🛠', sortOrder: 3 },
  { slug: 'ai', title: 'ИИ', emoji: '🤖', sortOrder: 4 },
  { slug: 'appstore-cards', title: 'Карты AppStore', emoji: '', sortOrder: 5 },
  { slug: 'digital-cards', title: 'Цифровые карты', emoji: '💳', sortOrder: 6 },
];

// Replace this placeholder with the owner's Telegram id before production seeding.
const ADMIN_TELEGRAM_ID_PLACEHOLDER = 'REPLACE_WITH_YOUR_TELEGRAM_ID';

interface SeedProductBase {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  /** Prices are in whole Stars (XTR has no minor units). */
  amountMinor: number;
  compareAtMinor: number | null;
  categorySlug: string;
  sortOrder: number;
}

/**
 * Stock is rows in LicenseKey, so a keyed product declares how many keys to
 * keep unclaimed; the others carry the payload they hand out. Splitting the two
 * shapes lets the compiler — rather than a cast — guarantee that a keyed
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
    title: 'Notion-дашборд',
    subtitle: 'Личная продуктивность',
    description:
      'Готовый шаблон Notion: цели, задачи, привычки и бюджет в одном месте. ' +
      'После оплаты вы получите персональный ключ активации.',
    amountMinor: 150,
    compareAtMinor: 250,
    categorySlug: 'templates',
    fulfillmentKind: 'LICENSE_KEY',
    keyPrefix: 'NOTION',
    keyCount: 25,
    sortOrder: 1,
  },
  {
    slug: 'figma-ui-kit',
    title: 'Figma UI Kit',
    subtitle: '120+ компонентов',
    description:
      'Набор компонентов для быстрого прототипирования мобильных интерфейсов. ' +
      'Auto-layout, variants, тёмная тема.',
    amountMinor: 300,
    compareAtMinor: null,
    categorySlug: 'templates',
    fulfillmentKind: 'LICENSE_KEY',
    keyPrefix: 'FIGMA',
    keyCount: 10,
    sortOrder: 2,
  },
  {
    slug: 'telegram-bot-course',
    title: 'Курс по Telegram-ботам',
    subtitle: '6 часов видео',
    description:
      'От первого /start до платежей и деплоя. Практические примеры на TypeScript. ' +
      'Доступ выдаётся сразу после оплаты.',
    amountMinor: 500,
    compareAtMinor: 800,
    categorySlug: 'courses',
    fulfillmentKind: 'LINK',
    staticPayload: 'https://example.com/courses/telegram-bots?access=demo',
    sortOrder: 3,
  },
  {
    slug: 'seo-checklist',
    title: 'SEO-чеклист',
    subtitle: 'PDF, 32 страницы',
    description:
      'Пошаговый аудит сайта: технические ошибки, контент, ссылки. ' +
      'Ссылка на скачивание приходит в чат.',
    amountMinor: 100,
    compareAtMinor: null,
    categorySlug: 'tools',
    fulfillmentKind: 'FILE',
    staticPayload: 'https://example.com/files/seo-checklist.pdf',
    sortOrder: 4,
  },
  {
    slug: 'starter-pack',
    title: 'Стартовый набор',
    subtitle: 'Бесплатно',
    description:
      'Небольшой бесплатный набор иконок и пресетов, чтобы попробовать магазин. ' +
      'Оплата не требуется.',
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
 * creates that file inside the release directory, the script reports success —
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
      currency: 'XTR',
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

  if (ADMIN_TELEGRAM_ID_PLACEHOLDER !== 'REPLACE_WITH_YOUR_TELEGRAM_ID') {
    const admin = await prisma.user.upsert({
      where: { telegramId: ADMIN_TELEGRAM_ID_PLACEHOLDER },
      update: {
        role: 'ADMIN',
        isAdmin: true,
      },
      create: {
        telegramId: ADMIN_TELEGRAM_ID_PLACEHOLDER,
        firstName: 'Admin',
        role: 'ADMIN',
        isAdmin: true,
      },
    });
    console.log(`  admin user: ${admin.telegramId}`);
  } else {
    console.log('  admin user skipped: replace ADMIN_TELEGRAM_ID_PLACEHOLDER');
  }

  const admins = [...config.adminTelegramIds];
  if (admins.length > 0) {
    console.log(`  admin telegram ids: ${admins.join(', ')}`);
  } else {
    console.log('  no ADMIN_TELEGRAM_IDS configured');
  }

  console.log('Done.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void disconnectDb());
