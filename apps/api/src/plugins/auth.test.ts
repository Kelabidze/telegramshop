/**
 * Authorization tests: roles, permissions and the config-driven admin invariant.
 *
 * These guards are the only thing standing between a normal buyer and the
 * management endpoints, so they are tested end-to-end through `app.inject()`
 * against a real database rather than by calling the helpers directly.
 *
 * The suite runs its own Fastify instance with a few throwaway routes, because
 * no production route uses the guards yet — the point is to pin down the guard
 * behaviour before routes start depending on it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Permission } from '@shop/shared';

const BOT_TOKEN = '424242:AAH-authorization-test-token';

/** One id per scenario: a shared user would leak state between tests. */
const IDS = {
  plainUser: '800000001',
  manager: '800000002',
  configAdmin: '800000003',
  demoted: '800000004',
  exManager: '800000005',
  multiRole: '800000006',
} as const;

const workDir = mkdtempSync(path.join(tmpdir(), 'shop-authz-test-'));
const dbFile = path.join(workDir, 'test.db');
const apiRoot = path.resolve(import.meta.dirname, '..', '..');

// Configure the app BEFORE importing it: config.ts reads env at module load.
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.PAYMENT_PROVIDER = 'none';
process.env.ALLOW_DEV_AUTH = 'false'; // force real signature checks
process.env.ADMIN_TELEGRAM_IDS = '';
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = '';
process.env.TELEGRAM_API_ROOT = 'http://127.0.0.1:9';

type App = Awaited<ReturnType<typeof import('../server.ts')['buildServer']>>;

let app: App;
let createSignedInitData: typeof import('../telegram/init-data.ts')['createSignedInitData'];
let prisma: typeof import('../db.ts')['prisma'];
let config: typeof import('../config.ts')['config'];

/** Signed auth header for a given Telegram user. */
function authHeader(telegramId: string): Record<string, string> {
  const initData = createSignedInitData(
    {
      auth_date: Math.floor(Date.now() / 1000),
      query_id: 'authz-test',
      user: { id: Number(telegramId), first_name: 'Tester' },
    },
    BOT_TOKEN,
  );
  return { authorization: `tma ${initData}` };
}

function get(url: string, telegramId?: string) {
  return app.inject({
    method: 'GET',
    url,
    ...(telegramId ? { headers: authHeader(telegramId) } : {}),
  });
}

/** Logs the user in, which is what creates the row and applies the config role. */
async function login(telegramId: string) {
  const res = await get('/api/me', telegramId);
  assert.equal(res.statusCode, 200, `login failed for ${telegramId}`);
  return res.json().viewer;
}

function storedRole(telegramId: string) {
  return prisma.user
    .findUniqueOrThrow({ where: { telegramId }, select: { role: true } })
    .then((u) => u.role);
}

/**
 * `config.adminTelegramIds` is a Set, so tests can grant and revoke admin the
 * same way redeploying with a different env var would.
 */
function setConfigAdmins(...telegramIds: string[]): void {
  config.adminTelegramIds.clear();
  for (const id of telegramIds) config.adminTelegramIds.add(id);
}

before(async () => {
  execFileSync('npx', ['prisma', 'db', 'push', '--url', `file:${dbFile}`], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  ({ createSignedInitData } = await import('../telegram/init-data.ts'));
  ({ prisma } = await import('../db.ts'));
  ({ config } = await import('../config.ts'));
  const { buildServer } = await import('../server.ts');
  app = await buildServer();

  // Throwaway routes exercising each guard.
  app.get('/t/admin-only', { preHandler: app.requireAdmin }, async () => ({
    ok: true,
  }));
  app.get(
    '/t/staff',
    { preHandler: app.requireRole('ADMIN', 'MANAGER') },
    async () => ({ ok: true }),
  );
  app.get(
    '/t/edit-catalog',
    { preHandler: app.requirePermission('EDIT_CATALOG') },
    async () => ({ ok: true }),
  );
  app.get(
    '/t/manage-keys',
    { preHandler: app.requirePermission('MANAGE_KEYS') },
    async () => ({ ok: true }),
  );

  await app.ready();
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(workDir, { recursive: true, force: true });
});

describe('requireRole', () => {
  it('answers 401, not 403, when there are no credentials', async () => {
    const res = await get('/t/admin-only');
    assert.equal(res.statusCode, 401);
    assert.equal(
      res.json().error.code,
      'UNAUTHORIZED',
      'authentication must be resolved before authorization',
    );
  });

  it('refuses a plain USER', async () => {
    setConfigAdmins();
    await login(IDS.plainUser);

    const res = await get('/t/admin-only', IDS.plainUser);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'FORBIDDEN');
  });

  it('admits an admin', async () => {
    setConfigAdmins(IDS.configAdmin);
    await login(IDS.configAdmin);

    const res = await get('/t/admin-only', IDS.configAdmin);
    assert.equal(res.statusCode, 200);
  });

  it('refuses a MANAGER on an admin-only route', async () => {
    setConfigAdmins();
    const viewer = await login(IDS.manager);
    await prisma.user.update({
      where: { id: viewer.id },
      data: { role: 'MANAGER' },
    });

    const res = await get('/t/admin-only', IDS.manager);
    assert.equal(res.statusCode, 403);
  });

  it('admits any of the listed roles', async () => {
    setConfigAdmins(IDS.configAdmin);
    const viewer = await login(IDS.multiRole);
    await prisma.user.update({
      where: { id: viewer.id },
      data: { role: 'MANAGER' },
    });

    const asManager = await get('/t/staff', IDS.multiRole);
    const asAdmin = await get('/t/staff', IDS.configAdmin);
    const asUser = await get('/t/staff', IDS.plainUser);

    assert.equal(asManager.statusCode, 200);
    assert.equal(asAdmin.statusCode, 200);
    assert.equal(asUser.statusCode, 403, 'USER is not staff');
  });
});

describe('requirePermission', () => {
  it('admits a MANAGER holding the permission and refuses one without it', async () => {
    setConfigAdmins();
    const viewer = await login(IDS.manager);
    await prisma.user.update({
      where: { id: viewer.id },
      data: { role: 'MANAGER' },
    });

    const before = await get('/t/edit-catalog', IDS.manager);
    assert.equal(before.statusCode, 403, 'no permission rows yet');

    await prisma.managerPermission.create({
      data: { userId: viewer.id, permission: 'EDIT_CATALOG' },
    });

    const after = await get('/t/edit-catalog', IDS.manager);
    assert.equal(after.statusCode, 200);
  });

  it('checks the specific permission, not merely having some', async () => {
    // The manager from the previous test holds EDIT_CATALOG only.
    const res = await get('/t/manage-keys', IDS.manager);
    assert.equal(res.statusCode, 403);
  });

  it('lets an ADMIN through without granting the permission explicitly', async () => {
    setConfigAdmins(IDS.configAdmin);
    await login(IDS.configAdmin);

    const perms = await prisma.managerPermission.count({
      where: { user: { telegramId: IDS.configAdmin } },
    });
    assert.equal(perms, 0, 'the admin must hold no permission rows');

    const res = await get('/t/manage-keys', IDS.configAdmin);
    assert.equal(res.statusCode, 200);
  });

  it('refuses a demoted manager whose permission rows still exist', async () => {
    setConfigAdmins();
    const viewer = await login(IDS.exManager);
    await prisma.user.update({
      where: { id: viewer.id },
      data: { role: 'MANAGER' },
    });
    await prisma.managerPermission.create({
      data: { userId: viewer.id, permission: 'EDIT_CATALOG' },
    });

    const asManager = await get('/t/edit-catalog', IDS.exManager);
    assert.equal(asManager.statusCode, 200);

    // Demote, but deliberately leave the permission row behind: revoking the
    // role must be enough to revoke access.
    await prisma.user.update({
      where: { id: viewer.id },
      data: { role: 'USER' },
    });

    const asUser = await get('/t/edit-catalog', IDS.exManager);
    assert.equal(
      asUser.statusCode,
      403,
      'a USER must not inherit access from stale permission rows',
    );
  });

  it('drops unknown permission strings instead of exposing them', async () => {
    setConfigAdmins();
    const viewer = await prisma.user.findUniqueOrThrow({
      where: { telegramId: IDS.exManager },
    });
    await prisma.managerPermission.create({
      data: { userId: viewer.id, permission: 'PERMISSION_REMOVED_FROM_CODE' },
    });
    await prisma.user.update({
      where: { id: viewer.id },
      data: { role: 'MANAGER' },
    });

    const me = await get('/api/me', IDS.exManager);
    assert.deepEqual(
      me.json().viewer.permissions,
      ['EDIT_CATALOG'],
      'only permissions the code knows about may reach the client',
    );
  });

  it('refuses to build a guard for an unknown permission', () => {
    assert.throws(
      () => app.requirePermission('EDIT_CATALGO' as Permission),
      /Unknown permission/,
      'a typo must fail loudly at registration, not as a silent 403',
    );
  });
});

describe('ADMIN_TELEGRAM_IDS is the only source of the ADMIN role', () => {
  it('promotes an id present in the config and persists the role', async () => {
    setConfigAdmins(IDS.demoted);
    const viewer = await login(IDS.demoted);

    assert.equal(viewer.role, 'ADMIN');
    assert.equal(viewer.isAdmin, true, 'isAdmin mirrors the role');
    assert.equal(await storedRole(IDS.demoted), 'ADMIN');
    assert.equal((await get('/t/admin-only', IDS.demoted)).statusCode, 200);
  });

  it('demotes an id removed from the config, without touching the database', async () => {
    // The regression this suite exists for: authorization moved from `isAdmin`
    // to `role`, and only the promotion half was implemented. Removing someone
    // from ADMIN_TELEGRAM_IDS left a persisted ADMIN row behind, so revoking
    // access required editing the database by hand.
    assert.equal(await storedRole(IDS.demoted), 'ADMIN', 'precondition');

    setConfigAdmins(); // redeploy without this id

    const viewer = await login(IDS.demoted);
    assert.equal(viewer.role, 'USER');
    assert.equal(viewer.isAdmin, false);
    assert.equal(
      await storedRole(IDS.demoted),
      'USER',
      'the stored role must be corrected, not just the response',
    );
    assert.equal(
      (await get('/t/admin-only', IDS.demoted)).statusCode,
      403,
      'access must be gone after the config no longer lists the id',
    );
  });

  it('cannot be granted from the database alone', async () => {
    setConfigAdmins();
    const viewer = await login(IDS.plainUser);
    await prisma.user.update({
      where: { id: viewer.id },
      data: { role: 'ADMIN', isAdmin: true },
    });

    const res = await get('/t/admin-only', IDS.plainUser);
    assert.equal(
      res.statusCode,
      403,
      'a hand-edited ADMIN row must not grant access',
    );
    assert.equal(
      await storedRole(IDS.plainUser),
      'USER',
      'the row must be corrected back on login',
    );
  });

  it('leaves the MANAGER role alone', async () => {
    setConfigAdmins(IDS.configAdmin);
    const viewer = await login(IDS.manager);

    assert.equal(viewer.role, 'MANAGER', 'config changes must not touch managers');
    assert.equal(await storedRole(IDS.manager), 'MANAGER');
  });
});
