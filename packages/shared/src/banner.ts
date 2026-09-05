import { z } from 'zod';
import { cuidSchema } from './catalog.js';

/**
 * Promo banners shown above the catalog.
 *
 * A separate domain from the catalog on purpose: a banner is presentation, not
 * inventory. It has no price, no stock and nothing to deliver, so folding it
 * into `Product` would mean every product query carrying fields that can never
 * apply to a purchase.
 */

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
  imageUrl: z.string().url().max(2000).nullable(),
  linkUrl: bannerLinkSchema.nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});
export type Banner = z.infer<typeof bannerSchema>;

const bannerFields = {
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).nullish(),
  imageUrl: z.string().url().max(2000).nullish(),
  linkUrl: bannerLinkSchema.nullish(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
};

export const bannerInputSchema = z.object({
  ...bannerFields,
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
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
