import { z } from 'zod';
import { cuidSchema } from './catalog.js';

/**
 * The "Сейчас в ZONE" editorial card shown on the home screen.
 *
 * A single featured message: what's happening right now, new products, updates,
 * or short-term promotions. Server-driven so it can be changed without a deploy.
 */

export const zoneNowCardSchema = z.object({
  id: cuidSchema,
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(500),
  imageUrl: z.string().max(2000).nullable(),
  actionLabel: z.string().max(60).nullable(),
  /** Where the action button leads. Null = no button shown. */
  actionUrl: z.string().max(2000).nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});

export type ZoneNowCard = z.infer<typeof zoneNowCardSchema>;

const zoneNowCardFields = {
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(500),
  imageUrl: z.string().max(2000).nullish(),
  actionLabel: z.string().max(60).nullish(),
  actionUrl: z.string().max(2000).nullish(),
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
