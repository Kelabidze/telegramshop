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

/**
 * Which storefront tab a product belongs to.
 *
 * `SHOP` is the ordinary catalog; `ABUSE` is the «Всё для Абуза» tab, whose
 * products are filtered by country rather than by category. A field on the
 * product rather than a magic category, because the two tabs filter along
 * different axes and a category named "abuse" would still show up in the
 * category carousel of the main catalog.
 */
export const PRODUCT_SECTIONS = ['SHOP', 'ABUSE'] as const;
export const productSectionSchema = z.enum(PRODUCT_SECTIONS);
export type ProductSection = z.infer<typeof productSectionSchema>;

/** A country a variation is tied to (jurisdiction of a KYC account, etc). */
export const countrySchema = z.object({
  id: cuidSchema,
  slug: slugSchema,
  title: z.string().min(1).max(120),
  emoji: z.string().max(8).nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});
export type Country = z.infer<typeof countrySchema>;

export const productSchema = z.object({
  id: cuidSchema,
  slug: slugSchema,
  title: z.string().min(1).max(160),
  subtitle: z.string().max(200).nullable(),
  description: z.string().max(4000),
  /**
   * Uploaded artwork. A same-origin `/uploads/...` path, or an absolute URL for
   * media hosted elsewhere — hence no `.url()` here, which would reject the
   * former.
   */
  imageUrl: z.string().max(2000).nullable(),
  /** Fallback artwork when there is no image. */
  emoji: z.string().max(16).nullable().default(null),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  /** Optional strike-through price for showing a discount. */
  compareAtMinor: amountMinorSchema.nullable(),
  fulfillmentKind: fulfillmentKindSchema,
  categoryId: cuidSchema.nullable(),
  /**
   * null  -> unlimited (FILE / LINK products)
   * >= 0  -> remaining license keys in stock
   *
   * On a parent with variations this is the SUM across them, so a card can say
   * "sold out" only when every variation is.
   */
  stock: z.number().int().nonnegative().nullable(),
  isActive: z.boolean(),
  section: productSectionSchema.default('SHOP'),
  /** Set on a variation; null on a parent or a standalone product. */
  parentId: cuidSchema.nullable().default(null),
  /** Which country this variation is for. Null unless it is a country variation. */
  countryId: cuidSchema.nullable().default(null),
  /**
   * How many active variations this product has. 0 means "buy this directly".
   *
   * Sent so the grid can label a card «N вариантов» and the product screen knows
   * to render a selector, both without a second request per card.
   */
  variationCount: z.number().int().nonnegative().default(0),
  /**
   * Cheapest variation price, when there are variations. The card shows
   * "from X" — a parent's own `amountMinor` is not what anyone pays.
   */
  minVariationAmountMinor: amountMinorSchema.nullable().default(null),
});
export type Product = z.infer<typeof productSchema>;

export const productListItemSchema = productSchema.omit({
  description: true,
});
export type ProductListItem = z.infer<typeof productListItemSchema>;

/** A selectable variation on the product screen. */
export const productVariationSchema = z.object({
  id: cuidSchema,
  slug: slugSchema,
  title: z.string().min(1).max(160),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  compareAtMinor: amountMinorSchema.nullable(),
  fulfillmentKind: fulfillmentKindSchema,
  stock: z.number().int().nonnegative().nullable(),
  isActive: z.boolean(),
  country: countrySchema.nullable(),
});
export type ProductVariation = z.infer<typeof productVariationSchema>;

/** A product page: the parent plus whatever can actually be bought. */
export const productDetailSchema = productSchema.extend({
  variations: z.array(productVariationSchema).default([]),
});
export type ProductDetail = z.infer<typeof productDetailSchema>;

/**
 * True when this product is bought through a variation rather than directly.
 *
 * The one check both ends must agree on: the client hides the buy button for a
 * parent, and `createOrder` refuses a parent outright. Getting it wrong in one
 * place only would mean an order for a product that has no stock of its own.
 */
export function hasVariations(
  product: Pick<Product, 'variationCount'>,
): boolean {
  return product.variationCount > 0;
}

/**
 * True for a section root nobody has filled in yet.
 *
 * An ABUSE product is sold through its country variations, so a root without any
 * has neither a price nor stock of its own: `amountMinor` is 0 by convention
 * (see `cli/seed-abuse.ts`) and there are no license keys. Rendered naively that
 * comes out as «Бесплатно» next to «Нет в наличии» — two false claims about one
 * empty placeholder, and the first of them invites a tap that can never end in a
 * purchase.
 *
 * The section is part of the check deliberately. Without it a genuinely free
 * SHOP item, or a standalone product that has honestly sold out, would be
 * relabelled «Ожидается поступление» — a promise the shop has not made.
 */
export function isAwaitingVariations(
  product: Pick<Product, 'section' | 'parentId' | 'variationCount'>,
): boolean {
  return (
    product.section === 'ABUSE' &&
    product.parentId === null &&
    product.variationCount === 0
  );
}

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
