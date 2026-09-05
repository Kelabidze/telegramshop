import { z } from 'zod';
import { amountMinorSchema, currencySchema } from './money.js';

/** URL-safe identifier used in deep links and routes. */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be kebab-case');

export const cuidSchema = z.string().min(8).max(64);

/**
 * How a digital product is fulfilled after payment.
 *  - LICENSE_KEY: a unique key is taken from stock and assigned to the buyer
 *  - FILE:        a download link is issued
 *  - LINK:        a static access URL (course, channel invite, etc.)
 */
export const FULFILLMENT_KINDS = ['LICENSE_KEY', 'FILE', 'LINK'] as const;
export const fulfillmentKindSchema = z.enum(FULFILLMENT_KINDS);
export type FulfillmentKind = z.infer<typeof fulfillmentKindSchema>;

export const categorySchema = z.object({
  id: cuidSchema,
  slug: slugSchema,
  title: z.string().min(1).max(120),
  emoji: z.string().max(8).nullable(),
  sortOrder: z.number().int(),
});
export type Category = z.infer<typeof categorySchema>;

export const productSchema = z.object({
  id: cuidSchema,
  slug: slugSchema,
  title: z.string().min(1).max(160),
  subtitle: z.string().max(200).nullable(),
  description: z.string().max(4000),
  imageUrl: z.string().url().nullable(),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  /** Optional strike-through price for showing a discount. */
  compareAtMinor: amountMinorSchema.nullable(),
  fulfillmentKind: fulfillmentKindSchema,
  categoryId: cuidSchema.nullable(),
  /**
   * null  -> unlimited (FILE / LINK products)
   * >= 0  -> remaining license keys in stock
   */
  stock: z.number().int().nonnegative().nullable(),
  isActive: z.boolean(),
});
export type Product = z.infer<typeof productSchema>;

export const productListItemSchema = productSchema.omit({
  description: true,
});
export type ProductListItem = z.infer<typeof productListItemSchema>;

/**
 * Product as staff see it: the public shape plus `description`.
 *
 * Still without `staticPayload`. That field is the product the buyer pays for,
 * and VIEW_ORDERS / MANAGE_KEYS already have a path to it (the delivered
 * payload on a paid order). Shipping it in a list would leak every FILE/LINK
 * secret to anyone who can open the admin catalog.
 */
export const staffProductSchema = productSchema;
export type StaffProduct = Product;

export function isPurchasable(
  product: Pick<Product, 'isActive' | 'stock'>,
): boolean {
  if (!product.isActive) return false;
  return product.stock === null || product.stock > 0;
}
