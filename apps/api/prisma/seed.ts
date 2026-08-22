/**
 * Seeds a demo catalog of digital products.
 * Idempotent: re-running updates existing rows instead of duplicating them.
 *
 *   npm run db:seed -w @shop/api
 */
import { randomBytes } from 'node:crypto';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { config } from '../src/config.ts';

const adapter = new PrismaBetterSqlite3(
  { url: config.databaseUrl },
  { timestampFormat: 'iso8601' },
);
const prisma = new PrismaClient({ adapter });

/** Readable fake license key, e.g. "SHOP-4F2A-9C1D-77B0". */
function fakeLicenseKey(prefix: string): string {
  const group = () => randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${group()}-${group()}-${group()}`;
}

const categories = [
  { slug: 'templates', title: 'Шаблоны', emoji: '🎨', sortOrder: 1 },
  { slug: 'courses', title: 'Курсы', emoji: '🎓', sortOrder: 2 },
  { slug: 'tools', title: 'Инструменты', emoji: '🛠', sortOrder: 3 },
];

/** Prices are in whole Stars (XTR has no minor units). */
const products = [
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
    fulfillmentKind: 'LICENSE_KEY' as const,
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
    fulfillmentKind: 'LICENSE_KEY' as const,
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
    fulfillmentKind: 'LINK' as const,
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
    fulfillmentKind: 'FILE' as const,
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
    fulfillmentKind: 'LINK' as const,
    staticPayload: 'https://example.com/files/starter-pack.zip',
    sortOrder: 5,
  },
];

async function main() {
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
    const {
      categorySlug,
      keyPrefix,
      keyCount,
      staticPayload,
      ...rest
    } = product as typeof product & {
      keyPrefix?: string;
      keyCount?: number;
      staticPayload?: string;
    };

    const data = {
      ...rest,
      currency: 'XTR',
      categoryId: categoryIdBySlug.get(categorySlug) ?? null,
      staticPayload: staticPayload ?? null,
      isActive: true,
    };

    const row = await prisma.product.upsert({
      where: { slug: product.slug },
      update: data,
      create: data,
    });

    if (product.fulfillmentKind === 'LICENSE_KEY' && keyPrefix && keyCount) {
      const existing = await prisma.licenseKey.count({
        where: { productId: row.id, claimedAt: null },
      });
      const missing = keyCount - existing;
      if (missing > 0) {
        // `secret` is unique per product, so retry on the rare collision.
        const secrets = new Set<string>();
        while (secrets.size < missing) secrets.add(fakeLicenseKey(keyPrefix));
        await prisma.licenseKey.createMany({
          data: [...secrets].map((secret) => ({ productId: row.id, secret })),
        });
        console.log(`  ${product.slug}: +${missing} license keys`);
      }
    }
  }
  console.log(`  products: ${products.length}`);

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
  .finally(() => void prisma.$disconnect());
