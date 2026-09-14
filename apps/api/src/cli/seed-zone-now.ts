/**
 * Seeds one demo Zone Now card.
 *
 * Separate script so it can be run manually without affecting the catalog.
 * Idempotent: re-running skips if a card already exists.
 */
import { disconnectDb, prisma } from '../db.js';

async function main() {
  console.log('Seeding demo Zone Now card...');

  const existing = await prisma.zoneNowCard.findFirst();
  if (existing) {
    console.log('  A Zone Now card already exists, skipping.');
    return;
  }

  await prisma.zoneNowCard.create({
    data: {
      title: 'Три способа оплаты',
      text: 'Telegram Stars, карта или USDT — цена одна, выбирайте что удобнее.',
      imageUrl: null,
      actionLabel: null,
      actionUrl: null,
      isActive: true,
      sortOrder: 0,
    },
  });

  console.log('  Created demo Zone Now card.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void disconnectDb());
