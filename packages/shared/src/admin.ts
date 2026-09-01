import { z } from 'zod';
import { amountMinorSchema, currencySchema } from './money.js';
import { cuidSchema, fulfillmentKindSchema, slugSchema } from './catalog.js';
import { orderStatusSchema } from './order.js';
import { permissionSchema } from './telegram.js';

/**
 * Management contract: what staff endpoints accept and return.
 *
 * Kept separate from `catalog.ts` because the shapes differ in a way that
 * matters. Public reads never expose `staticPayload` — it is the product the
 * buyer pays for. Management writes have to accept it, so the two must not
 * share a schema by accident.
 *
 * Create and update schemas are defined from the same field rules but are NOT
 * `.partial()` versions of each other. `.partial()` keeps `.default()` in
 * place, so `PUT { sortOrder: 5 }` would parse into
 * `{ sortOrder: 5, description: '', currency: 'XTR', isActive: true }` and
 * silently wipe the description and re-activate a hidden product. Verified
 * against zod 4 rather than assumed: update schemas therefore declare their
 * fields without defaults.
 */

// ---- categories ------------------------------------------------------------

const categoryFields = {
  slug: slugSchema,
  title: z.string().min(1).max(120),
  emoji: z.string().max(8).nullish(),
};

/** Fields a manager may set when creating a category. */
export const categoryInputSchema = z.object({
  ...categoryFields,
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type CategoryInput = z.infer<typeof categoryInputSchema>;

/** Every field optional, and absent means "leave as is" — no defaults. */
export const categoryUpdateSchema = z
  .object({
    ...categoryFields,
    sortOrder: z.number().int().min(0).max(10_000),
  })
  .partial();
export type CategoryUpdate = z.infer<typeof categoryUpdateSchema>;

// ---- products --------------------------------------------------------------

/**
 * `staticPayload` is the deliverable for FILE and LINK products, so it is
 * write-only: accepted here, never returned by any read endpoint.
 *
 * `licenseKeys` adds stock. It never removes keys — a claimed key is a
 * delivered purchase and has to stay auditable.
 */
const productFields = {
  slug: slugSchema,
  title: z.string().min(1).max(160),
  subtitle: z.string().max(200).nullish(),
  description: z.string().max(4000),
  imageUrl: z.string().url().max(2000).nullish(),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  compareAtMinor: amountMinorSchema.nullish(),
  fulfillmentKind: fulfillmentKindSchema,
  staticPayload: z.string().max(2000).nullish(),
  categoryId: cuidSchema.nullish(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
  licenseKeys: z.array(z.string().min(1).max(500)).max(500).optional(),
};

export const productInputSchema = z.object({
  ...productFields,
  // Defaults belong to creation only.
  description: productFields.description.default(''),
  currency: currencySchema.default('XTR'),
  fulfillmentKind: fulfillmentKindSchema.default('LICENSE_KEY'),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type ProductInput = z.infer<typeof productInputSchema>;

export const productUpdateSchema = z.object(productFields).partial();
export type ProductUpdate = z.infer<typeof productUpdateSchema>;

// ---- orders ----------------------------------------------------------------

/** Filters for the global order list. */
export const orderListQuerySchema = z.object({
  status: orderStatusSchema.optional(),
  /** Matches an order reference. */
  q: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

/** Who placed an order — only visible to staff holding VIEW_ORDERS. */
export const orderCustomerSchema = z.object({
  id: cuidSchema,
  telegramId: z.string(),
  firstName: z.string(),
  username: z.string().nullable(),
});
export type OrderCustomer = z.infer<typeof orderCustomerSchema>;

// ---- staff -----------------------------------------------------------------

/** Manager list entry, as returned to staff. */
export const managerSchema = z.object({
  id: cuidSchema,
  telegramId: z.string(),
  firstName: z.string(),
  username: z.string().nullable(),
  /** ADMIN entries appear too, so staff can see who holds full access. */
  role: z.enum(['ADMIN', 'MANAGER']),
  permissions: z.array(permissionSchema),
  createdAt: z.string().datetime(),
});
export type Manager = z.infer<typeof managerSchema>;

/**
 * Grants manager rights to a Telegram user.
 *
 * Identified by `telegramId`, not the internal id: staff are appointed before
 * they have ever opened the app, so there may be no row yet.
 */
export const managerInputSchema = z.object({
  telegramId: z.string().regex(/^\d{1,20}$/, 'Telegram id must be digits only'),
  /** Replaces the current set. Empty means a manager with no rights. */
  permissions: z.array(permissionSchema).max(20),
});
export type ManagerInput = z.infer<typeof managerInputSchema>;
