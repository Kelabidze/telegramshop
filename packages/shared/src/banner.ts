import { z } from 'zod';
import { cuidSchema, productSectionSchema, type ProductSection } from './catalog.js';

/**
 * Promo banners shown above a storefront section.
 *
 * A separate domain from the catalog on purpose: a banner is presentation, not
 * inventory. It has no price, no stock and nothing to deliver, so folding it
 * into `Product` would mean every product query carrying fields that can never
 * apply to a purchase.
 *
 * A banner belongs to a section, and it is the **same** `ProductSection` the
 * products use rather than a second enum of screen names. A separate
 * `'CATALOG' | 'ABUSE'` list would have to be mapped onto `'SHOP' | 'ABUSE'`
 * somewhere, and that mapping is exactly the kind of thing that ends up written
 * twice with one copy wrong.
 */

/**
 * How many banners each section may show at once.
 *
 * Capped in the read rather than in the UI: the strip sits above the content, so
 * a careless extra banner pushes it off the first screen entirely. «Абуз» gets
 * one because its artwork is square — a 1:1 poster is roughly twice the height
 * of the 16:9 strip, and two of them would be the whole first screen.
 *
 * Lives in the contract because both ends need the number: the API to limit the
 * read, the admin panel to say out loud how many of the listed banners will
 * actually be visible.
 */
export const BANNER_MAX_VISIBLE: Readonly<Record<ProductSection, number>> = {
  SHOP: 2,
  ABUSE: 1,
};

/**
 * Where a banner tap leads.
 *
 * Two shapes only, both validated: an external `https` link, or an in-app
 * target. Free-form strings are refused because this value is handed to a
 * navigation call and to an anchor `href` — `javascript:` in an href is a
 * scripting vector, and the shop must not become one by way of a CMS field.
 */
export const bannerLinkSchema = z
  .string()
  .max(2000)
  .refine(
    (value) =>
      /^https:\/\//i.test(value) || /^category:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
    'Ссылка должна начинаться с https:// или быть вида "category:slug"',
  );

export const bannerSchema = z.object({
  id: cuidSchema,
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).nullable(),
  // Same-origin `/uploads/...` for an uploaded file, or an absolute URL.
  imageUrl: z.string().max(2000).nullable(),
  linkUrl: bannerLinkSchema.nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  /** Which storefront screen shows this banner. */
  section: productSectionSchema.default('SHOP'),
});
export type Banner = z.infer<typeof bannerSchema>;

const bannerFields = {
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).nullish(),
  imageUrl: z.string().max(2000).nullish(),
  linkUrl: bannerLinkSchema.nullish(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
  section: productSectionSchema,
};

export const bannerInputSchema = z.object({
  ...bannerFields,
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  // Defaults to the main catalog, which is where every banner lived before
  // sections existed: an older client that does not send the field keeps
  // working, and its banners land where they used to.
  section: productSectionSchema.default('SHOP'),
});
export type BannerInput = z.infer<typeof bannerInputSchema>;

/**
 * Every field optional, absent means "leave as is".
 *
 * Not `.partial()` of the input schema: that keeps `.default()` in place, so
 * `PUT { sortOrder: 3 }` would also silently set `isActive: true` and
 * re-publish a banner somebody had just hidden.
 */
export const bannerUpdateSchema = z.object(bannerFields).partial();
export type BannerUpdate = z.infer<typeof bannerUpdateSchema>;

/** An in-app banner target, or null when the link points somewhere else. */
export function bannerCategorySlug(linkUrl: string | null): string | null {
  if (!linkUrl) return null;
  const match = /^category:(.+)$/.exec(linkUrl);
  return match?.[1] ?? null;
}
