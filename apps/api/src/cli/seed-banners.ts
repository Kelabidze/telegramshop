/**
 * Seeds two demo promo banners and nothing else.
 *
 *   npm run db:seed:banners                                    # dev
 *   node --env-file=<api.env> dist/cli/seed-banners.js         # production
 *
 * Separate from `seed.ts` on purpose. The full seed also upserts the demo
 * catalog, so running it on production would overwrite real products with demo
 * ones — which makes it unusable for the one thing people actually want on a
 * live server: getting the banner strip populated without hand-writing curl.
 *
 * Idempotent, and it never touches a banner that already exists: a banner
 * edited through the API keeps its text, and re-running this adds nothing.
 */
import { config } from '../config.js';
import { disconnectDb, prisma } from '../db.js';

interface DemoBanner {
  title: string;
  subtitle: string;
  /** Resolved at run time: an in-app target only works if the category exists. */
  link: (context: { hasCourses: boolean }) => string | null;
  sortOrder: number;
}

const DEMO_BANNERS: DemoBanner[] = [
  {
    title: 'Курсы со скидкой',
    subtitle: 'Подборка недели',
    // Pointing at a category that does not exist would render a banner that
    // filters the catalog down to nothing.
    link: ({ hasCourses }) => (hasCourses ? 'category:courses' : null),
    sortOrder: 1,
  },
  {
    title: 'Клубный тариф 5%',
    subtitle: 'Подпишитесь на канал',
    // Null when no channel is configured: better a decorative strip than a
    // button that opens a dead link.
    link: () => config.clubChannel.url || null,
    sortOrder: 2,
  },
];

async function main(): Promise<void> {
  console.log(`Seeding banners into ${config.databaseUrl}`);

  const hasCourses =
    (await prisma.category.count({ where: { slug: 'courses' } })) > 0;

  let created = 0;
  let kept = 0;

  for (const banner of DEMO_BANNERS) {
    // Matched by title because a banner has no natural unique key. Skipped
    // rather than updated: overwriting would undo edits made through the API,
    // and this script exists to bootstrap, not to reset.
    const existing = await prisma.banner.findFirst({
      where: { title: banner.title },
      select: { id: true },
    });

    if (existing) {
      kept += 1;
      console.log(`  kept: ${banner.title}`);
      continue;
    }

    await prisma.banner.create({
      data: {
        title: banner.title,
        subtitle: banner.subtitle,
        linkUrl: banner.link({ hasCourses }),
        sortOrder: banner.sortOrder,
        isActive: true,
      },
    });
    created += 1;
    console.log(`  created: ${banner.title}`);
  }

  console.log(`Done. created ${created}, kept ${kept}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void disconnectDb());
