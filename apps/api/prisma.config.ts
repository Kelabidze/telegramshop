/**
 * Prisma 7 CLI configuration.
 *
 * Prisma 7 no longer reads the datasource URL from the schema at CLI time when
 * driver adapters are used: the CLI needs an adapter factory to talk to the DB
 * for `db push`, `migrate` and `studio`.
 */
import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

/** Resolve the SQLite file relative to this package, not the shell's cwd. */
function resolveDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL ?? 'file:./prisma/dev.db';
  if (raw === ':memory:') return raw;
  const withoutScheme = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
  if (path.isAbsolute(withoutScheme)) return withoutScheme;
  return path.join(import.meta.dirname, withoutScheme);
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  /** Required by migration/introspection commands (`db push`, `migrate`, `studio`). */
  datasource: {
    url: `file:${resolveDatabaseUrl()}`,
  },
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  adapter: async () =>
    new PrismaBetterSqlite3({ url: resolveDatabaseUrl() }),
});
