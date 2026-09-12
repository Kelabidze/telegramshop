import { formatMoney } from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';

/**
 * Converts legacy Stars-priced products to the RUB base-price model.
 *
 * Why this exists as a deliberate, argument-driven script rather than a migration:
 * the stored integer changes meaning with the currency. On an XTR row `150` is 150
 * whole Stars; on a RUB row it is 150 kopecks, i.e. 1.50 ₽. There is no way to infer
 * the intended rouble price from the number alone, so a blind `UPDATE ... SET
 * currency='RUB'` would reprice the entire catalog by a factor of ~87 and a blind
 * conversion would invent prices nobody agreed to.
 *
 * So the operator supplies the rate explicitly, and nothing is written without
 * `--apply`. A legacy XTR product cannot be paid by card or USDT at all
 * (`CURRENCY_MISMATCH` in `services/orders.ts`), which is what makes the conversion
 * necessary rather than cosmetic.
 *
 *   # See what would change. Default: no writes.
 *   node dist/cli/migrate-product-currency.js --rate 1.30
 *
 *   # Convert, one product at a time.
 *   node dist/cli/migrate-product-currency.js --rate 1.30 --only ai-openai-plus --apply
 *
 *   # Convert everything still on XTR.
 *   node dist/cli/migrate-product-currency.js --rate 1.30 --all --apply
 *
 * `--rate` is roubles per Star, and is required: it is the price decision, and it
 * belongs to whoever runs this, not to this file.
 */

interface Options {
  /** Kopecks per Star. */
  rateMinor: number;
  slugs: string[];
  all: boolean;
  apply: boolean;
}

function usage(message: string): never {
  console.error(`\n${message}\n`);
  console.error('usage: migrate-product-currency --rate <RUB per Star> [--only <slug>]... [--all] [--apply]');
  console.error('');
  console.error('  --rate <n>    roubles per Star, e.g. 1.30. Required.');
  console.error('  --only <slug> convert just this product. Repeatable.');
  console.error('  --all         convert every product still priced in XTR.');
  console.error('  --apply       actually write. Without it, nothing changes.');
  process.exit(1);
}

/**
 * Parses a decimal rate into integer kopecks.
 *
 * Digit-string arithmetic rather than `value * 100`: `1.3 * 100` is fine but
 * `8.77 * 100` is 876.9999999999999, and a rate that is one kopeck low silently
 * underprices the whole catalog.
 */
function parseRateToMinor(raw: string): number {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(raw.trim());
  if (!match) usage(`--rate must be a number with at most 2 decimals, got "${raw}".`);
  const whole = Number(match[1]);
  const frac = (match[2] ?? '').padEnd(2, '0');
  const minor = whole * 100 + Number(frac);
  if (minor <= 0) usage('--rate must be greater than zero.');
  return minor;
}

function parseArgs(argv: string[]): Options {
  let rateMinor = 0;
  const slugs: string[] = [];
  let all = false;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--rate': {
        const value = argv[i + 1];
        if (!value) usage('--rate needs a value.');
        rateMinor = parseRateToMinor(value);
        i += 1;
        break;
      }
      case '--only': {
        const value = argv[i + 1];
        if (!value) usage('--only needs a slug.');
        slugs.push(value);
        i += 1;
        break;
      }
      case '--all':
        all = true;
        break;
      case '--apply':
        apply = true;
        break;
      default:
        usage(`Unknown argument "${String(arg)}".`);
    }
  }

  if (rateMinor === 0) usage('--rate is required: this script must not invent a price.');
  if (!all && slugs.length === 0) usage('Pass --only <slug> or --all.');
  if (all && slugs.length > 0) usage('--all and --only are mutually exclusive.');

  return { rateMinor, slugs, all, apply };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const rows = await prisma.product.findMany({
    where: {
      currency: { not: 'RUB' },
      ...(options.all ? {} : { slug: { in: options.slugs } }),
    },
    select: {
      id: true,
      slug: true,
      title: true,
      currency: true,
      amountMinor: true,
      compareAtMinor: true,
      isActive: true,
      parentId: true,
    },
    orderBy: { slug: 'asc' },
  });

  if (!options.all) {
    const found = new Set(rows.map((r) => r.slug));
    const missing = options.slugs.filter((s) => !found.has(s));
    if (missing.length > 0) {
      // Either the slug is wrong or it is already RUB. Both deserve a stop, because
      // silently converting a subset of what was asked for is worse than failing.
      console.error(`\nNot found on a non-RUB product: ${missing.join(', ')}`);
      console.error('Check the slug, or confirm it is already priced in RUB.');
      process.exit(1);
    }
  }

  if (rows.length === 0) {
    console.log('\nNothing to convert: no products are priced outside RUB.');
    return;
  }

  console.log(`\nRate: ${formatMoney(options.rateMinor, 'RUB')} per Star`);
  console.log(options.apply ? 'Mode: APPLY (writing)\n' : 'Mode: dry run (no writes)\n');

  const header = `${'slug'.padEnd(20)} ${'now'.padEnd(16)} ${'becomes'.padEnd(14)} note`;
  console.log(header);
  console.log('-'.repeat(header.length));

  const planned: { id: string; slug: string; amountMinor: number; compareAtMinor: number | null }[] =
    [];

  for (const row of rows) {
    // Stars -> kopecks. The stored XTR amount is whole Stars (exponent 0).
    const amountMinor = row.amountMinor * options.rateMinor;
    const compareAtMinor =
      row.compareAtMinor === null ? null : row.compareAtMinor * options.rateMinor;

    const notes: string[] = [];
    if (!row.isActive) notes.push('inactive');
    if (row.parentId) notes.push('variation');
    // A parent whose price is 0 is a placeholder: the real prices live on its
    // variations, and converting 0 is a no-op worth pointing out.
    if (row.amountMinor === 0) notes.push('zero price — priced via variations?');

    console.log(
      `${row.slug.padEnd(20)} ${`${row.amountMinor} ${row.currency}`.padEnd(16)} ` +
        `${formatMoney(amountMinor, 'RUB').padEnd(14)} ${notes.join(', ')}`,
    );

    planned.push({ id: row.id, slug: row.slug, amountMinor, compareAtMinor });
  }

  if (!options.apply) {
    console.log(`\n${planned.length} product(s) would change. Re-run with --apply to write.`);
    return;
  }

  // One transaction: a half-converted catalog would mix bases, and orders spanning
  // two base currencies are refused outright.
  await prisma.$transaction(
    planned.map((p) =>
      prisma.product.update({
        where: { id: p.id },
        data: {
          currency: 'RUB',
          amountMinor: p.amountMinor,
          ...(p.compareAtMinor === null ? {} : { compareAtMinor: p.compareAtMinor }),
        },
      }),
    ),
  );

  console.log(`\nConverted ${planned.length} product(s) to RUB.`);
  console.log('Existing orders keep their own snapshots and are unaffected.');
}

main()
  .catch((error: unknown) => {
    console.error('\nMigration failed. Nothing was written unless stated above.');
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });

// Keep the configured rates visible in the log: an operator comparing this output to
// the storefront needs to know what Stars are being derived at.
console.error(
  `[info] checkout derives Stars at ${config.rates.starRubMinorPerUnit / 100} RUB/Star`,
);
