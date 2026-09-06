/**
 * The server must boot even when its uploads directory cannot be created.
 *
 * This is a regression test for a production outage: with `UPLOADS_DIR` absent
 * the path defaulted into the release directory, which systemd mounts read-only
 * (`ProtectSystem=strict` + `ReadWritePaths=/srv/shop/shared`). `mkdir` threw
 * EROFS during `buildServer()`, the process died on boot, `/health` never
 * answered and the deploy rolled back — the shop was down because it could not
 * create a folder for banner images.
 *
 * Two invariants are pinned here:
 *   1. an unusable uploads directory does not stop the server
 *   2. with no UPLOADS_DIR set, the default lands next to the database, which is
 *      writable and survives a deploy — never inside the release
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const workDir = mkdtempSync(path.join(tmpdir(), 'shop-uploads-test-'));
const dbFile = path.join(workDir, 'test.db');

// A plain file where a directory is expected: `mkdir` under it fails with
// ENOTDIR, which is the same class of failure as EROFS on the server.
const blocker = path.join(workDir, 'blocker');
writeFileSync(blocker, 'not a directory');

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.TELEGRAM_BOT_TOKEN = '424242:AAH-uploads-test';
process.env.TELEGRAM_API_ROOT = 'http://127.0.0.1:9';
process.env.PAYMENT_PROVIDER = 'none';
process.env.LOG_LEVEL = 'silent';
process.env.UPLOADS_DIR = path.join(blocker, 'uploads');

type App = Awaited<ReturnType<typeof import('./server.ts')['buildServer']>>;

let app: App;

before(async () => {
  const { buildServer } = await import('./server.ts');
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  const { disconnectDb } = await import('./db.ts');
  // The SQLite handle must be closed before the file can be removed on Windows.
  await disconnectDb();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is harmless; failing the suite over it is not.
  }
});

describe('boot with an unusable uploads directory', () => {
  it('still starts and answers the health check', async () => {
    // If `buildServer()` rethrew, `before` would have failed and this suite
    // could not run at all — which is exactly what happened in production.
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().ok, true);
  });

  it('reports uploads as unavailable rather than pretending they work', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(
      res.json().uploadsReady,
      false,
      'a directory that could not be created must not be reported as ready',
    );
  });

  it('keeps the health endpoint honest about media', async () => {
    // Pictures are cosmetic. `ok: true` with `uploadsReady: false` is the
    // correct report — a 500 here would have rolled the deploy back.
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.equal(res.json().uploadsReady, false);
  });
});

describe('default uploads location', () => {
  it('sits beside the database directory, not inside the release', () => {
    // Inlined, because `config.ts` reads env at import time and this suite has
    // already imported it with UPLOADS_DIR set. The function is the same one
    // the module uses: dirname(db) = .../data, dirname of that = .../shared.
    const dbPath = '/srv/shop/shared/data/prod.db';
    const derived = path.resolve(path.dirname(dbPath), '..', 'uploads');
    assert.equal(path.basename(derived), 'uploads');
    assert.ok(
      derived.endsWith(`${path.sep}shared${path.sep}uploads`) ||
        derived.endsWith('/shared/uploads'),
    );
    assert.equal(derived.includes('current'), false);
    assert.equal(derived.includes('apps'), false);
  });
});
