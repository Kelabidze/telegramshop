#!/usr/bin/env node
/**
 * Seed a default Zone Now card if none exists.
 *
 * Safe to run multiple times: idempotent, creates only if the table is empty.
 */
import { disconnectDb, prisma } from '../db.js';

async function main() {
  const existing = await prisma.zoneNowCard.count();
  
  if (existing > 0) {
    console.log(`Zone Now cards already exist (${existing}). Skipping.`);
    return;
  }

  const card = await prisma.zoneNowCard.create({
    data: {
      title: 'Добро пожаловать в ZONE',
      text: 'Новые товары каждую неделю. Следите за обновлениями!',
      imageUrl: null,
      actionLabel: 'Перейти в каталог',
      actionUrl: '/catalog',
      isActive: true,
      sortOrder: 0,
    },
  });

  console.log('✓ Default Zone Now card created:', card.id);
}

main()
  .catch((error) => {
    console.error('Zone Now seed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void disconnectDb();
  });
