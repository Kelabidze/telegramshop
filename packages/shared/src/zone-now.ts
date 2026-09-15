import { z } from 'zod';
import { bannerLinkSchema } from './banner.js';
import { cuidSchema } from './catalog.js';

/**
 * The "Сейчас в ZONE" editorial card shown on the home screen.
 *
 * A single featured message: what's happening right now, new products, updates,
 * or short-term promotions. Server-driven so it can be changed without a deploy.
 *
 * The action link reuses `bannerLinkSchema` rather than declaring its own rule.
 * Two reasons, and both have bitten this codebase before:
 *
 *  1. **Safety.** The value is handed to a navigation call, so a free-form string
 *     would let `javascript:` into the app by way of a CMS field. The banner
 *     schema already refuses everything except `https://` and `category:slug`.
 *  2. **One vocabulary.** An in-app target has to be spelled the same way in both
 *     places or the storefront cannot resolve it — a second, slightly different
 *     rule is exactly the sort of thing that gets written twice with one copy wrong.
 */

export const zoneNowCardSchema = z.object({
  id: cuidSchema,
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(500),
  imageUrl: z.string().max(2000).nullable(),
  actionLabel: z.string().max(60).nullable(),
  /** Where the action button leads. Null = no button shown. */
  actionUrl: bannerLinkSchema.nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});

export type ZoneNowCard = z.infer<typeof zoneNowCardSchema>;

const zoneNowCardFields = {
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(500),
  imageUrl: z.string().max(2000).nullish(),
  actionLabel: z.string().max(60).nullish(),
  actionUrl: bannerLinkSchema.nullish(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
};

export const zoneNowCardInputSchema = z.object({
  ...zoneNowCardFields,
  isActive: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

export type ZoneNowCardInput = z.infer<typeof zoneNowCardInputSchema>;

export const zoneNowCardUpdateSchema = z.object(zoneNowCardFields).partial();
export type ZoneNowCardUpdate = z.infer<typeof zoneNowCardUpdateSchema>;
