import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  bannerInputSchema,
  bannerUpdateSchema,
  categoryInputSchema,
  categoryUpdateSchema,
  cuidSchema,
  managerInputSchema,
  orderListQuerySchema,
  productInputSchema,
  productUpdateSchema,
} from '@shop/shared';
import { validationError } from '../errors.js';
import {
  createBanner,
  deleteBanner,
  listAllBanners,
  updateBanner,
} from '../services/banners.js';
import {
  createCategory,
  createProduct,
  deactivateProduct,
  deleteCategory,
  updateCategory,
  updateProduct,
} from '../services/admin-catalog.js';
import { listAllOrders } from '../services/admin-orders.js';
import {
  listManagers,
  revokeManager,
  upsertManager,
} from '../services/managers.js';

/**
 * Management endpoints.
 *
 * Every route here is guarded by a pre-handler from `plugins/auth.ts`. The
 * guards are the only thing separating staff operations from any buyer who can
 * sign an initData, so they are attached in the route definition rather than
 * checked inside handlers: a `preHandler` cannot be forgotten halfway through a
 * function, and an unguarded route is visible at a glance during review.
 *
 * Permission mapping:
 *   EDIT_CATALOG   categories
 *   MANAGE_KEYS    products and their license-key stock
 *   VIEW_ORDERS    every order, including delivered payloads
 *   MANAGE_MANAGERS appointing managers (ADMIN also passes, as everywhere)
 *
 * `requirePermission` lets ADMIN through without an explicit grant, so an
 * administrator needs no permission rows at all.
 */

const idParamsSchema = z.object({ id: cuidSchema });
const telegramIdParamsSchema = z.object({
  telegramId: z.string().regex(/^\d{1,20}$/),
});

/** Parses input or throws VALIDATION_ERROR with field-level details. */
function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError(`Invalid ${what}.`, result.error.issues);
  }
  return result.data;
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // ---- categories: EDIT_CATALOG --------------------------------------------

  app.post(
    '/categories',
    { preHandler: app.requirePermission('EDIT_CATALOG') },
    async (request, reply) => {
      const input = parse(categoryInputSchema, request.body, 'category');
      const category = await createCategory(input);
      // 201 + the created resource: the client needs the generated id.
      return reply.code(201).send({ category });
    },
  );

  app.put(
    '/categories/:id',
    { preHandler: app.requirePermission('EDIT_CATALOG') },
    async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'category id');
      const input = parse(categoryUpdateSchema, request.body, 'category');
      return { category: await updateCategory(id, input) };
    },
  );

  app.delete(
    '/categories/:id',
    { preHandler: app.requirePermission('EDIT_CATALOG') },
    async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'category id');
      // Products survive: the relation is SetNull, so they only lose grouping.
      return { category: await deleteCategory(id) };
    },
  );

  // ---- banners: EDIT_CATALOG -----------------------------------------------
  // Same permission as categories: both are how the storefront is arranged, and
  // a separate right would be one more thing to grant for no extra safety.

  app.get(
    '/banners/all',
    { preHandler: app.requirePermission('EDIT_CATALOG') },
    async () => ({ banners: await listAllBanners() }),
  );

  app.post(
    '/banners',
    { preHandler: app.requirePermission('EDIT_CATALOG') },
    async (request, reply) => {
      const input = parse(bannerInputSchema, request.body, 'banner');
      return reply.code(201).send({ banner: await createBanner(input) });
    },
  );

  app.put(
    '/banners/:id',
    { preHandler: app.requirePermission('EDIT_CATALOG') },
    async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'banner id');
      const input = parse(bannerUpdateSchema, request.body, 'banner');
      return { banner: await updateBanner(id, input) };
    },
  );

  app.delete(
    '/banners/:id',
    { preHandler: app.requirePermission('EDIT_CATALOG') },
    async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'banner id');
      return { banner: await deleteBanner(id) };
    },
  );

  // ---- products and stock: MANAGE_KEYS -------------------------------------

  app.post(
    '/products',
    { preHandler: app.requirePermission('MANAGE_KEYS') },
    async (request, reply) => {
      const input = parse(productInputSchema, request.body, 'product');
      const result = await createProduct(input);
      return reply.code(201).send(result);
    },
  );

  app.put(
    '/products/:id',
    { preHandler: app.requirePermission('MANAGE_KEYS') },
    async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'product id');
      const input = parse(productUpdateSchema, request.body, 'product');
      return updateProduct(id, input);
    },
  );

  app.delete(
    '/products/:id',
    { preHandler: app.requirePermission('MANAGE_KEYS') },
    async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'product id');
      // Deactivation, not deletion: orders reference products with Restrict and
      // must stay readable. See services/admin-catalog.ts.
      return deactivateProduct(id);
    },
  );

  // ---- all orders: VIEW_ORDERS ---------------------------------------------

  /**
   * Registered as `/orders/all`, which cannot collide with `/orders/:id` from
   * `routes/orders.ts`: Fastify's radix router prefers the static segment over
   * the parametric one regardless of registration order.
   */
  app.get(
    '/orders/all',
    { preHandler: app.requirePermission('VIEW_ORDERS') },
    async (request) => {
      const query = parse(orderListQuerySchema, request.query, 'query');
      const orders = await listAllOrders(query);
      return { orders, count: orders.length };
    },
  );

  // ---- staff: MANAGE_MANAGERS ----------------------------------------------

  app.get(
    '/managers',
    { preHandler: app.requirePermission('MANAGE_MANAGERS') },
    async () => ({ managers: await listManagers() }),
  );

  app.post(
    '/managers',
    { preHandler: app.requirePermission('MANAGE_MANAGERS') },
    async (request) => {
      const input = parse(managerInputSchema, request.body, 'manager');
      // Cannot grant ADMIN: that role comes from ADMIN_TELEGRAM_IDS only.
      return { manager: await upsertManager(input) };
    },
  );

  app.delete(
    '/managers/:telegramId',
    { preHandler: app.requirePermission('MANAGE_MANAGERS') },
    async (request) => {
      const { telegramId } = parse(
        telegramIdParamsSchema,
        request.params,
        'telegram id',
      );
      return revokeManager(telegramId);
    },
  );
};
