/**
 * Management endpoint tests.
 *
 * Two things are checked for every route, in this order of importance:
 *   1. it is guarded — an anonymous caller gets 401, a buyer gets 403, and a
 *      manager holding a *different* permission also gets 403;
 *   2. it does what it says once the caller is authorized.
 *
 * The guard half matters more than the CRUD half: a broken create is visible
 * immediately, while a missing pre-handler is invisible until someone exploits
 * it. Every route therefore appears in the ACCESS table below, and the table is
 * driven by data so adding a route without a test is obvious.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Permission } from '@shop/shared';

const BOT_TOKEN = '424242:AAH-admin-routes-test-token';

const IDS = {
  buyer: '810000001',
  admin: '810000002',
  catalogManager: '810000003',
  keyManager: '810000004',
  orderViewer: '810000005',
  staffManager: '810000006',
  appointee: '810000007',
} as const;

const workDir = mkdtempSync(path.join(tmpdir(), 'shop-admin-test-'));
const dbFile = path.join(workDir, 'test.db');
const apiRoot = path.resolve(import.meta.dirname, '..', '..');

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.PAYMENT_PROVIDER = 'none';
process.env.ALLOW_DEV_AUTH = 'false';
process.env.ADMIN_TELEGRAM_IDS = '';
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = '';
process.env.TELEGRAM_API_ROOT = 'http://127.0.0.1:9';

type App = Awaited<ReturnType<typeof import('../server.ts')['buildServer']>>;

let app: App;
let createSignedInitData: typeof import('../telegram/init-data.ts')['createSignedInitData'];
let prisma: typeof import('../db.ts')['prisma'];
let config: typeof import('../config.ts')['config'];

function authHeader(telegramId: string): Record<string, string> {
  const initData = createSignedInitData(
    {
      auth_date: Math.floor(Date.now() / 1000),
      query_id: 'admin-test',
      user: { id: Number(telegramId), first_name: 'Tester' },
    },
    BOT_TOKEN,
  );
  return { authorization: `tma ${initData}` };
}

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  as?: string;
}

function call({ method, url, body, as }: Call) {
  return app.inject({
    method,
    url,
    ...(as ? { headers: authHeader(as) } : {}),
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

/** Signs in, which creates the row and applies the config-derived role. */
async function login(telegramId: string): Promise<string> {
  const res = await call({ method: 'GET', url: '/api/me', as: telegramId });
  assert.equal(res.statusCode, 200, `login failed for ${telegramId}`);
  return res.json().viewer.id as string;
}

/** Makes the user a MANAGER holding exactly `permissions`. */
async function makeManager(
  telegramId: string,
  permissions: Permission[],
): Promise<string> {
  const id = await login(telegramId);
  await prisma.user.update({ where: { id }, data: { role: 'MANAGER' } });
  await prisma.managerPermission.deleteMany({ where: { userId: id } });
  await prisma.managerPermission.createMany({
    data: permissions.map((permission) => ({ userId: id, permission })),
  });
  return id;
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
  await app.ready();

  config.adminTelegramIds.add(IDS.admin);
  await login(IDS.admin);
  await login(IDS.buyer);
  await makeManager(IDS.catalogManager, ['EDIT_CATALOG']);
  await makeManager(IDS.keyManager, ['MANAGE_KEYS']);
  await makeManager(IDS.orderViewer, ['VIEW_ORDERS']);
  await makeManager(IDS.staffManager, ['MANAGE_MANAGERS']);
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Every management route with the permission it requires. Used to assert that
 * each one rejects anonymous callers, plain buyers and managers holding some
 * other permission.
 */
const ACCESS: Array<Call & { needs: Permission }> = [
  { method: 'POST', url: '/api/categories', needs: 'EDIT_CATALOG', body: {} },
  { method: 'PUT', url: '/api/categories/cat00000000', needs: 'EDIT_CATALOG', body: {} },
  { method: 'DELETE', url: '/api/categories/cat00000000', needs: 'EDIT_CATALOG' },
  { method: 'POST', url: '/api/products', needs: 'MANAGE_KEYS', body: {} },
  { method: 'PUT', url: '/api/products/prod00000000', needs: 'MANAGE_KEYS', body: {} },
  { method: 'DELETE', url: '/api/products/prod00000000', needs: 'MANAGE_KEYS' },
  { method: 'GET', url: '/api/orders/all', needs: 'VIEW_ORDERS' },
  { method: 'GET', url: '/api/managers', needs: 'MANAGE_MANAGERS' },
  { method: 'POST', url: '/api/managers', needs: 'MANAGE_MANAGERS', body: {} },
  { method: 'DELETE', url: '/api/managers/810000099', needs: 'MANAGE_MANAGERS' },
];

/** A manager who holds every permission except the one under test. */
const OTHER_PERMISSION_HOLDER: Record<Permission, string> = {
  EDIT_CATALOG: IDS.keyManager,
  MANAGE_KEYS: IDS.catalogManager,
  VIEW_ORDERS: IDS.catalogManager,
  REFUND_ORDERS: IDS.catalogManager,
  MANAGE_MANAGERS: IDS.catalogManager,
};

describe('management routes are guarded', () => {
  for (const route of ACCESS) {
    const label = `${route.method} ${route.url}`;

    it(`${label} rejects anonymous callers with 401`, async () => {
      const res = await call(route);
      assert.equal(res.statusCode, 401, res.body);
      assert.equal(res.json().error.code, 'UNAUTHORIZED');
    });

    it(`${label} rejects a plain buyer with 403`, async () => {
      const res = await call({ ...route, as: IDS.buyer });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(res.json().error.code, 'FORBIDDEN');
    });

    it(`${label} rejects a manager without ${route.needs}`, async () => {
      const res = await call({
        ...route,
        as: OTHER_PERMISSION_HOLDER[route.needs],
      });
      assert.equal(res.statusCode, 403, res.body);
    });
  }
});

describe('category management', () => {
  let categoryId = '';

  it('creates a category and returns 201 with the id', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/categories',
      as: IDS.catalogManager,
      body: { slug: 'admin-cat', title: 'Админская', emoji: '🧪', sortOrder: 7 },
    });
    assert.equal(res.statusCode, 201, res.body);
    const { category } = res.json();
    assert.equal(category.slug, 'admin-cat');
    assert.equal(category.sortOrder, 7);
    categoryId = category.id;
  });

  it('rejects a duplicate slug with CONFLICT, not a 500', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/categories',
      as: IDS.catalogManager,
      body: { slug: 'admin-cat', title: 'Дубль' },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'CONFLICT');
  });

  it('rejects invalid input with field-level details', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/categories',
      as: IDS.catalogManager,
      body: { slug: 'Not A Slug', title: '' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(res.json().error.details));
  });

  it('updates only the fields that were sent', async () => {
    const res = await call({
      method: 'PUT',
      url: `/api/categories/${categoryId}`,
      as: IDS.catalogManager,
      body: { sortOrder: 3 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const { category } = res.json();
    assert.equal(category.sortOrder, 3);
    assert.equal(
      category.title,
      'Админская',
      'an absent field must not be overwritten with a default',
    );
    assert.equal(category.emoji, '🧪');
  });

  it('answers 404 for an unknown category', async () => {
    const res = await call({
      method: 'PUT',
      url: '/api/categories/cmt00000000missing',
      as: IDS.catalogManager,
      body: { title: 'X' },
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  it('deletes a category but keeps its products', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/products',
      as: IDS.keyManager,
      body: {
        slug: 'orphan-me',
        title: 'Orphan',
        amountMinor: 10,
        categoryId,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id;

    const res = await call({
      method: 'DELETE',
      url: `/api/categories/${categoryId}`,
      as: IDS.catalogManager,
    });
    assert.equal(res.statusCode, 200, res.body);

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: { categoryId: true },
    });
    assert.equal(
      product.categoryId,
      null,
      'the product must survive with its category detached',
    );
  });
});

describe('product management', () => {
  let productId = '';

  it('creates a product with license keys', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/products',
      as: IDS.keyManager,
      body: {
        slug: 'admin-product',
        title: 'Ключевой товар',
        description: 'Описание',
        amountMinor: 250,
        fulfillmentKind: 'LICENSE_KEY',
        licenseKeys: ['KEY-1', 'KEY-2', 'KEY-2', '  '],
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    productId = body.id;
    assert.equal(body.keysAdded, 2, 'duplicates and blanks must be dropped');
  });

  it('exposes the new stock through the public catalog', async () => {
    const res = await call({ method: 'GET', url: '/api/products' });
    const item = res
      .json()
      .products.find((p: { slug: string }) => p.slug === 'admin-product');
    assert.equal(item.stock, 2);
  });

  it('adds keys idempotently on update', async () => {
    const res = await call({
      method: 'PUT',
      url: `/api/products/${productId}`,
      as: IDS.keyManager,
      body: { licenseKeys: ['KEY-2', 'KEY-3'] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().keysAdded, 1, 'KEY-2 already exists');

    const total = await prisma.licenseKey.count({ where: { productId } });
    assert.equal(total, 3);
  });

  it('never returns staticPayload through the public catalog', async () => {
    await call({
      method: 'PUT',
      url: `/api/products/${productId}`,
      as: IDS.keyManager,
      body: { fulfillmentKind: 'LINK', staticPayload: 'https://secret.example' },
    });

    const list = await call({ method: 'GET', url: '/api/products' });
    const detail = await call({
      method: 'GET',
      url: '/api/products/admin-product',
    });
    assert.equal(list.body.includes('secret.example'), false);
    assert.equal(detail.body.includes('secret.example'), false);
  });

  it('does not wipe fields that were not sent', async () => {
    const res = await call({
      method: 'PUT',
      url: `/api/products/${productId}`,
      as: IDS.keyManager,
      body: { sortOrder: 4 },
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    });
    assert.equal(row.sortOrder, 4);
    assert.equal(row.description, 'Описание', 'description must survive');
    assert.equal(row.isActive, true, 'a partial update must not re-activate');
  });

  it('deactivates instead of deleting', async () => {
    const res = await call({
      method: 'DELETE',
      url: `/api/products/${productId}`,
      as: IDS.keyManager,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().isActive, false);

    const row = await prisma.product.findUnique({ where: { id: productId } });
    assert.ok(row, 'the row must still exist so old orders stay readable');

    const publicList = await call({ method: 'GET', url: '/api/products' });
    const found = publicList
      .json()
      .products.some((p: { slug: string }) => p.slug === 'admin-product');
    assert.equal(found, false, 'it must be gone from the public catalog');
  });
});

describe('global order list', () => {
  it('does not shadow GET /api/orders/:id', async () => {
    // `/orders/all` and `/orders/:id` coexist in Fastify's router; this pins
    // that down, because a collision would turn a buyer's own order lookup
    // into a permission error.
    const res = await call({
      method: 'GET',
      url: '/api/orders/cmt00000000missing',
      as: IDS.buyer,
    });
    assert.equal(
      res.statusCode,
      404,
      'the parametric route must still be reachable',
    );
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });

  it('returns every order with its customer', async () => {
    const buyerId = await login(IDS.buyer);
    const product = await prisma.product.create({
      data: {
        slug: 'order-fixture',
        title: 'Fixture',
        amountMinor: 100,
        currency: 'XTR',
        fulfillmentKind: 'LINK',
        staticPayload: 'https://example.test/x',
      },
    });
    await prisma.order.create({
      data: {
        reference: 'ADMIN1',
        userId: buyerId,
        status: 'PAID',
        currency: 'XTR',
        totalAmountMinor: 100,
        invoicePayload: 'ord_admin_fixture',
        lines: {
          create: {
            productId: product.id,
            titleSnapshot: 'Fixture',
            unitAmountMinor: 100,
            quantity: 1,
            totalAmountMinor: 100,
            fulfillmentKind: 'LINK',
          },
        },
      },
    });

    const res = await call({
      method: 'GET',
      url: '/api/orders/all',
      as: IDS.orderViewer,
    });
    assert.equal(res.statusCode, 200, res.body);
    const { orders } = res.json();
    const order = orders.find((o: { reference: string }) => o.reference === 'ADMIN1');
    assert.ok(order, 'the seeded order must be listed');
    assert.equal(order.customer.telegramId, IDS.buyer);
  });

  it('filters by status', async () => {
    const paid = await call({
      method: 'GET',
      url: '/api/orders/all?status=PAID',
      as: IDS.orderViewer,
    });
    const cancelled = await call({
      method: 'GET',
      url: '/api/orders/all?status=CANCELLED',
      as: IDS.orderViewer,
    });
    assert.ok(paid.json().count >= 1);
    assert.equal(cancelled.json().count, 0);
  });

  it('rejects an unknown status instead of ignoring it', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/orders/all?status=WHATEVER',
      as: IDS.orderViewer,
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('staff management', () => {
  it('appoints a manager with permissions', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/managers',
      as: IDS.staffManager,
      body: {
        telegramId: IDS.appointee,
        permissions: ['EDIT_CATALOG', 'VIEW_ORDERS'],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const { manager } = res.json();
    assert.equal(manager.role, 'MANAGER');
    assert.deepEqual(manager.permissions.sort(), ['EDIT_CATALOG', 'VIEW_ORDERS']);
  });

  it('grants working access to the appointed manager', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/categories',
      as: IDS.appointee,
      body: { slug: 'appointed-cat', title: 'От назначенного' },
    });
    assert.equal(res.statusCode, 201, res.body);
  });

  it('replaces the permission set rather than merging it', async () => {
    await call({
      method: 'POST',
      url: '/api/managers',
      as: IDS.staffManager,
      body: { telegramId: IDS.appointee, permissions: ['VIEW_ORDERS'] },
    });

    const denied = await call({
      method: 'POST',
      url: '/api/categories',
      as: IDS.appointee,
      body: { slug: 'should-fail', title: 'Нет прав' },
    });
    assert.equal(
      denied.statusCode,
      403,
      'EDIT_CATALOG must be gone after the replacement',
    );
  });

  it('rejects an unknown permission name', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/managers',
      as: IDS.staffManager,
      body: { telegramId: IDS.appointee, permissions: ['SUPERUSER'] },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });

  it('refuses to touch a config-driven administrator', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/managers',
      as: IDS.staffManager,
      body: { telegramId: IDS.admin, permissions: [] },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'CONFLICT');
  });

  it('cannot grant ADMIN through this endpoint', async () => {
    // The appointee is not in ADMIN_TELEGRAM_IDS, so no combination of input
    // may end with role ADMIN.
    const row = await prisma.user.findUniqueOrThrow({
      where: { telegramId: IDS.appointee },
      select: { role: true },
    });
    assert.equal(row.role, 'MANAGER');

    const admins = await call({
      method: 'GET',
      url: '/api/managers',
      as: IDS.staffManager,
    });
    const appointee = admins
      .json()
      .managers.find((m: { telegramId: string }) => m.telegramId === IDS.appointee);
    assert.equal(appointee.role, 'MANAGER');
  });

  it('lists config admins even before their first login', async () => {
    const neverSeen = '810000042';
    config.adminTelegramIds.add(neverSeen);
    try {
      const res = await call({
        method: 'GET',
        url: '/api/managers',
        as: IDS.staffManager,
      });
      const entry = res
        .json()
        .managers.find((m: { telegramId: string }) => m.telegramId === neverSeen);
      assert.ok(entry, 'an admin without a row must still be visible');
      assert.equal(entry.role, 'ADMIN');
    } finally {
      config.adminTelegramIds.delete(neverSeen);
    }
  });

  it('revokes a manager back to USER', async () => {
    const res = await call({
      method: 'DELETE',
      url: `/api/managers/${IDS.appointee}`,
      as: IDS.staffManager,
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await prisma.user.findUniqueOrThrow({
      where: { telegramId: IDS.appointee },
      select: { role: true, managerPermissions: true },
    });
    assert.equal(row.role, 'USER');
    assert.equal(row.managerPermissions.length, 0);
  });

  it('lets an ADMIN manage staff without any explicit permission', async () => {
    const perms = await prisma.managerPermission.count({
      where: { user: { telegramId: IDS.admin } },
    });
    assert.equal(perms, 0);

    const res = await call({
      method: 'GET',
      url: '/api/managers',
      as: IDS.admin,
    });
    assert.equal(res.statusCode, 200, res.body);
  });
});
