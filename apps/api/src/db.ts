import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from './generated/prisma/client.js';
import { config } from './config.js';

/**
 * Prisma 7 talks to SQLite through a driver adapter.
 *
 * `timestampFormat: 'iso8601'` keeps DateTime columns human-readable in the
 * SQLite file, which makes debugging and a later Postgres migration easier.
 */
const adapter = new PrismaBetterSqlite3(
  { url: config.databaseUrl },
  { timestampFormat: 'iso8601' },
);

export const prisma = new PrismaClient({
  adapter,
  log: config.isDev ? ['warn', 'error'] : ['error'],
});

export type Db = typeof prisma;

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
