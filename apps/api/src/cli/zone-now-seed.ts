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
      /*
       * No button. `actionUrl` accepts only `https://…` or `category:slug`, and a
       * seed cannot know which categories this shop has — a guessed slug would
       * render a button that filters the catalog down to nothing. Staff add the
       * link in the admin panel, where the categories are a dropdown.
       */
      actionLabel: null,
      actionUrl: null,
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
