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
// Uploads go to the throwaway work directory, which `after` removes: otherwise
// the suite would litter the real uploads folder and its quota.
process.env.UPLOADS_DIR = path.join(workDir, 'uploads');

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
  { method: 'GET', url: '/api/banners/all', needs: 'EDIT_CATALOG' },
  { method: 'POST', url: '/api/banners', needs: 'EDIT_CATALOG', body: {} },
  { method: 'PUT', url: '/api/banners/ban00000000', needs: 'EDIT_CATALOG', body: {} },
  { method: 'DELETE', url: '/api/banners/ban00000000', needs: 'EDIT_CATALOG' },
  { method: 'GET', url: '/api/countries/all', needs: 'EDIT_CATALOG' },
  { method: 'POST', url: '/api/countries', needs: 'EDIT_CATALOG', body: {} },
  { method: 'PUT', url: '/api/countries/cnt00000000', needs: 'EDIT_CATALOG', body: {} },
  { method: 'DELETE', url: '/api/countries/cnt00000000', needs: 'EDIT_CATALOG' },
  { method: 'GET', url: '/api/products/all', needs: 'MANAGE_KEYS' },
  // Media is reachable with EITHER catalog permission, so the shared table
  // (which asserts one specific permission) cannot describe it. Covered by its
  // own tests below.
  { method: 'POST', url: '/api/products', needs: 'MANAGE_KEYS', body: {} },
  { method: 'PUT', url: '/api/products/prod00000000', needs: 'MANAGE_KEYS', body: {} },
  { method: 'DELETE', url: '/api/products/prod00000000', needs: 'MANAGE_KEYS' },
  { method: 'GET', url: '/api/orders/all', needs: 'VIEW_ORDERS' },
  // On-chain payments are order data, so they sit behind the same permission.
  { method: 'GET', url: '/api/crypto-payments', needs: 'VIEW_ORDERS' },
  { method: 'GET', url: '/api/users', needs: 'MANAGE_MANAGERS' },
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

describe('media uploads', () => {
  /** A tiny but structurally valid PNG. */
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);

  function multipart(body: Buffer, filename: string, contentType: string) {
    const boundary = '----shoptestboundary';
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      payload: Buffer.concat([head, body, tail]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  it('rejects an anonymous upload', async () => {
    const { payload, headers } = multipart(PNG, 'a.png', 'image/png');
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers,
      payload,
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects a plain buyer', async () => {
    const { payload, headers } = multipart(PNG, 'a.png', 'image/png');
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: { ...headers, ...authHeader(IDS.buyer) },
      payload,
    });
    assert.equal(res.statusCode, 403);
  });

  it('accepts either catalog permission, since both edit the storefront', async () => {
    for (const who of [IDS.catalogManager, IDS.keyManager]) {
      const { payload, headers } = multipart(PNG, 'a.png', 'image/png');
      const res = await app.inject({
        method: 'POST',
        url: '/api/media',
        headers: { ...headers, ...authHeader(who) },
        payload,
      });
      assert.equal(res.statusCode, 201, `${who}: ${res.body}`);
      const { asset } = res.json();
      assert.match(
        asset.url,
        /^\/uploads\/[0-9a-f]{32}\.png$/,
        'the stored name must be generated, never taken from the client',
      );
      assert.equal(asset.mimeType, 'image/png');
      assert.equal(asset.kind, 'IMAGE');
    }
  });

  it('refuses a file whose content is not an accepted image', async () => {
    // Named .png and labelled image/png, but the bytes are a script. Trusting
    // the declared type here is how an upload endpoint starts serving scripts.
    const { payload, headers } = multipart(
      Buffer.from('<script>alert(1)</script>'),
      'evil.png',
      'image/png',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: { ...headers, ...authHeader(IDS.catalogManager) },
      payload,
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });

  it('serves an uploaded file back with nosniff', async () => {
    const { payload, headers } = multipart(PNG, 'a.png', 'image/png');
    const created = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: { ...headers, ...authHeader(IDS.catalogManager) },
      payload,
    });
    const { asset } = created.json();

    const res = await app.inject({ method: 'GET', url: asset.url });
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.headers['x-content-type-options'],
      'nosniff',
      'user-supplied bytes must never be re-sniffed by the browser',
    );
  });

  it('reports storage usage for the admin UI', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/media/usage',
      headers: authHeader(IDS.catalogManager),
    });
    assert.equal(res.statusCode, 200, res.body);
    const usage = res.json();
    assert.ok(usage.fileCount >= 1);
    assert.ok(usage.usedBytes > 0);
    assert.ok(usage.quotaBytes > usage.usedBytes);
  });

  it('ignores a delete request pointing outside the uploads directory', async () => {
    // Path traversal: the basename must match the generated pattern, so this is
    // a no-op rather than an unlink of something else.
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/media',
      headers: authHeader(IDS.catalogManager),
      payload: { url: '/uploads/../../../etc/passwd' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().deleted, false);
  });
});

describe('banner management', () => {
  let bannerId = '';

  it('creates a banner and returns 201', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/banners',
      as: IDS.catalogManager,
      body: {
        title: 'Скидки недели',
        subtitle: 'до -30%',
        linkUrl: 'category:admin-cat',
        sortOrder: 1,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const { banner } = res.json();
    bannerId = banner.id;
    assert.equal(banner.title, 'Скидки недели');
    assert.equal(banner.isActive, true, 'a new banner defaults to visible');
    assert.equal(
      banner.section,
      'SHOP',
      'a banner with no section belongs to the main catalog',
    );
  });

  it('serves active banners publicly, without a signature', async () => {
    // The home screen renders the strip before it knows who is looking, so this
    // must work anonymously exactly like the catalog does.
    const res = await call({ method: 'GET', url: '/api/banners' });
    assert.equal(res.statusCode, 200, res.body);
    const titles = res.json().banners.map((b: { title: string }) => b.title);
    assert.ok(titles.includes('Скидки недели'));
  });

  it('keeps each section reading only its own banners', async () => {
    // The whole point of the field: «Всё для абуза» must not inherit the
    // catalog's promos, and the catalog must not show the section's poster.
    const created = await call({
      method: 'POST',
      url: '/api/banners',
      as: IDS.catalogManager,
      body: { title: 'Постер абуза', section: 'ABUSE', sortOrder: 0 },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().banner.section, 'ABUSE');

    const abuse = await call({ method: 'GET', url: '/api/banners?section=ABUSE' });
    assert.equal(abuse.statusCode, 200, abuse.body);
    const abuseTitles = abuse.json().banners.map((b: { title: string }) => b.title);
    assert.deepEqual(abuseTitles, ['Постер абуза']);

    const shop = await call({ method: 'GET', url: '/api/banners?section=SHOP' });
    const shopTitles = shop.json().banners.map((b: { title: string }) => b.title);
    assert.equal(
      shopTitles.includes('Постер абуза'),
      false,
      'a section banner must not leak into the catalog strip',
    );
  });

  it('defaults an unqualified read to the catalog section', async () => {
    // A client that predates sections sends no parameter and must keep getting
    // exactly what it used to: the catalog's banners, never another screen's.
    const bare = await call({ method: 'GET', url: '/api/banners' });
    const qualified = await call({ method: 'GET', url: '/api/banners?section=SHOP' });
    assert.deepEqual(bare.json(), qualified.json());
  });

  it('rejects an unknown section instead of serving everything', async () => {
    // A typo that fell through to "no filter" would put the catalog's promos on
    // top of every screen, which is the failure this parameter exists to prevent.
    const res = await call({ method: 'GET', url: '/api/banners?section=HOME' });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });

  it('ships one banner at most to «Всё для абуза»', async () => {
    // Its artwork is square, so a second poster would be the entire first
    // screen. The cap is per section and lives in the read.
    for (const sortOrder of [1, 2]) {
      const res = await call({
        method: 'POST',
        url: '/api/banners',
        as: IDS.catalogManager,
        body: { title: `Абуз ${sortOrder}`, section: 'ABUSE', sortOrder },
      });
      assert.equal(res.statusCode, 201, res.body);
    }

    const res = await call({ method: 'GET', url: '/api/banners?section=ABUSE' });
    assert.equal(
      res.json().banners.length,
      1,
      'the square poster is shown one at a time',
    );
    assert.equal(
      res.json().banners[0].title,
      'Постер абуза',
      'the lowest sortOrder wins',
    );
  });

  it('moves a banner between sections on request', async () => {
    // Staff can retarget a banner instead of deleting and re-uploading it, and
    // the storefront read has to follow immediately.
    const moved = await call({
      method: 'PUT',
      url: `/api/banners/${bannerId}`,
      as: IDS.catalogManager,
      body: { section: 'ABUSE' },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().banner.section, 'ABUSE');

    const shop = await call({ method: 'GET', url: '/api/banners?section=SHOP' });
    const shopIds = shop.json().banners.map((b: { id: string }) => b.id);
    assert.equal(shopIds.includes(bannerId), false);

    // Put it back: the tests below describe a catalog banner.
    const back = await call({
      method: 'PUT',
      url: `/api/banners/${bannerId}`,
      as: IDS.catalogManager,
      body: { section: 'SHOP' },
    });
    assert.equal(back.json().banner.section, 'SHOP');
  });

  it('rejects a link that is neither https nor an in-app category', async () => {
    // This value ends up in a navigation call and an href. A `javascript:` URL
    // getting through would turn a CMS field into a scripting vector.
    for (const linkUrl of [
      'javascript:alert(1)',
      'http://insecure.example.com',
      'category:Not A Slug',
    ]) {
      const res = await call({
        method: 'POST',
        url: '/api/banners',
        as: IDS.catalogManager,
        body: { title: 'Плохая ссылка', linkUrl },
      });
      assert.equal(res.statusCode, 400, `must reject ${linkUrl}`);
      assert.equal(res.json().error.code, 'VALIDATION_ERROR');
    }
  });

  it('hides a banner from the public list once deactivated', async () => {
    const updated = await call({
      method: 'PUT',
      url: `/api/banners/${bannerId}`,
      as: IDS.catalogManager,
      body: { isActive: false },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().banner.isActive, false);

    const publicList = await call({ method: 'GET', url: '/api/banners' });
    const ids = publicList.json().banners.map((b: { id: string }) => b.id);
    assert.equal(ids.includes(bannerId), false, 'hidden banners must not ship');

    // Staff still see it, otherwise it could never be switched back on.
    const staffList = await call({
      method: 'GET',
      url: '/api/banners/all',
      as: IDS.catalogManager,
    });
    const staffIds = staffList.json().banners.map((b: { id: string }) => b.id);
    assert.ok(staffIds.includes(bannerId));
  });

  it('does not resurrect a hidden banner on an unrelated partial update', async () => {
    // `isActive` has a default on create. If the update schema were a
    // `.partial()` of it, this PUT would silently re-publish the banner.
    const res = await call({
      method: 'PUT',
      url: `/api/banners/${bannerId}`,
      as: IDS.catalogManager,
      body: { sortOrder: 5 },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().banner.sortOrder, 5);
    assert.equal(
      res.json().banner.isActive,
      false,
      'a field absent from the request must keep its stored value',
    );
  });

  it('never ships more than two banners to the home screen', async () => {
    // The strip sits above the catalog: a careless extra banner would push the
    // products off the first screen, so the cap lives in the read, not the UI.
    for (const sortOrder of [10, 11, 12, 13]) {
      const res = await call({
        method: 'POST',
        url: '/api/banners',
        as: IDS.catalogManager,
        body: { title: `Баннер ${sortOrder}`, sortOrder },
      });
      assert.equal(res.statusCode, 201, res.body);
    }

    const res = await call({ method: 'GET', url: '/api/banners' });
    assert.ok(
      res.json().banners.length <= 2,
      `expected at most 2 banners, got ${res.json().banners.length}`,
    );
  });

  it('deletes a banner and 404s afterwards', async () => {
    const deleted = await call({
      method: 'DELETE',
      url: `/api/banners/${bannerId}`,
      as: IDS.catalogManager,
    });
    assert.equal(deleted.statusCode, 200, deleted.body);

    const again = await call({
      method: 'PUT',
      url: `/api/banners/${bannerId}`,
      as: IDS.catalogManager,
      body: { title: 'Уже нет' },
    });
    assert.equal(again.statusCode, 404);
    assert.equal(again.json().error.code, 'NOT_FOUND');
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

  it('still lists a deactivated product for staff, without the secret payload', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/products/all',
      as: IDS.keyManager,
    });
    assert.equal(res.statusCode, 200, res.body);
    const item = res
      .json()
      .products.find((p: { slug: string }) => p.slug === 'admin-product');
    assert.ok(item, 'staff must see hidden products or they could never re-enable one');
    assert.equal(item.isActive, false);
    assert.equal(
      'staticPayload' in item,
      false,
      'the paid secret must not leak into a staff list',
    );
  });
});

describe('base currency', () => {
  it('creates in RUB when currency is omitted', async () => {
    // The default used to be XTR, so any caller that forgot the field created a
    // legacy Stars-priced product — one that cannot be paid by card or USDT at all,
    // and whose stored number is billed as whole Stars.
    const res = await call({
      method: 'POST',
      url: '/api/products',
      as: IDS.keyManager,
      body: {
        slug: 'currency-default',
        title: 'Без валюты',
        amountMinor: 49_900,
        fulfillmentKind: 'LINK',
        staticPayload: 'https://example.test/x',
      },
    });
    assert.equal(res.statusCode, 201, res.body);

    const row = await prisma.product.findUniqueOrThrow({
      where: { slug: 'currency-default' },
    });
    assert.equal(row.currency, 'RUB');
    assert.equal(row.amountMinor, 49_900, '499 ₽ in kopecks, unchanged');
  });

  it('refuses to reprice a legacy XTR product without an explicit currency', async () => {
    // Staff typing a rouble figure into the price field of a Stars-priced product is
    // the dangerous case: 1290 would be charged as 1290 Stars, roughly 1677 ₽, with
    // nothing in the UI to hint at it. The admin form does not send `currency` on
    // update, so this guard is the only thing standing between the two readings.
    const legacy = await prisma.product.create({
      data: {
        slug: 'legacy-stars',
        title: 'Старый товар',
        description: '',
        amountMinor: 150,
        currency: 'XTR',
        fulfillmentKind: 'LINK',
        staticPayload: 'https://example.test/legacy',
      },
    });

    const res = await call({
      method: 'PUT',
      url: `/api/products/${legacy.id}`,
      as: IDS.keyManager,
      body: { amountMinor: 129_000 },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.body, /XTR/, 'the error has to name the unit it is refusing');

    const unchanged = await prisma.product.findUniqueOrThrow({
      where: { id: legacy.id },
    });
    assert.equal(unchanged.amountMinor, 150, 'the price must not have moved');
    assert.equal(unchanged.currency, 'XTR');
  });

  it('allows the reprice when the currency is stated', async () => {
    const legacy = await prisma.product.findUniqueOrThrow({
      where: { slug: 'legacy-stars' },
    });
    const res = await call({
      method: 'PUT',
      url: `/api/products/${legacy.id}`,
      as: IDS.keyManager,
      body: { amountMinor: 19_500, currency: 'RUB' },
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(row.currency, 'RUB');
    assert.equal(row.amountMinor, 19_500);
  });

  it('explains that a deleted product still holds its slug', async () => {
    // The path staff hit when rebuilding a catalogue: delete a product, then create
    // it again with the same slug. Deletion is deactivation, because an ordered
    // product has to stay readable, so the slug is still taken — by a row that is no
    // longer visible anywhere in the catalogue. A bare "already in use" would be
    // impossible to act on.
    const created = await call({
      method: 'POST',
      url: '/api/products',
      as: IDS.keyManager,
      body: {
        slug: 'to-be-replaced',
        title: 'Старая версия',
        amountMinor: 10_000,
        fulfillmentKind: 'LINK',
        staticPayload: 'https://example.test/old',
      },
    });
    assert.equal(created.statusCode, 201, created.body);

    await call({
      method: 'DELETE',
      url: `/api/products/${created.json().id}`,
      as: IDS.keyManager,
    });

    const again = await call({
      method: 'POST',
      url: '/api/products',
      as: IDS.keyManager,
      body: {
        slug: 'to-be-replaced',
        title: 'Новая версия',
        amountMinor: 49_900,
        fulfillmentKind: 'LINK',
        staticPayload: 'https://example.test/new',
      },
    });

    assert.equal(again.statusCode, 409, again.body);
    const { message } = again.json().error;
    assert.match(message, /Старая версия/, 'name the product holding the slug');
    assert.match(message, /hidden/i, 'say that it is hidden, not missing');
  });

  it('leaves a RUB product repriceable without ceremony', async () => {
    const row = await prisma.product.findUniqueOrThrow({
      where: { slug: 'currency-default' },
    });
    const res = await call({
      method: 'PUT',
      url: `/api/products/${row.id}`,
      as: IDS.keyManager,
      body: { amountMinor: 59_900 },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(
      (await prisma.product.findUniqueOrThrow({ where: { id: row.id } })).amountMinor,
      59_900,
    );
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
  it('lists every shop user, including buyers, for staff', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/users',
      as: IDS.staffManager,
    });
    assert.equal(res.statusCode, 200, res.body);
    const telegramIds = res
      .json()
      .users.map((u: { telegramId: string }) => u.telegramId);
    assert.ok(telegramIds.includes(IDS.buyer), 'buyers must appear');
    assert.ok(telegramIds.includes(IDS.admin), 'admins must appear');
  });

  it('does not leak users to a manager who cannot appoint staff', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/users',
      as: IDS.catalogManager,
    });
    assert.equal(res.statusCode, 403);
  });

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
