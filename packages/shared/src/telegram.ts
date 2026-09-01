import { z } from 'zod';

/** Telegram user as delivered inside `initData`. */
export const telegramUserSchema = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  is_premium: z.literal(true).optional(),
  allows_write_to_pm: z.literal(true).optional(),
  photo_url: z.string().optional(),
});
export type TelegramUser = z.infer<typeof telegramUserSchema>;

/**
 * Parsed `initData` payload. Complex fields arrive as JSON strings and are
 * decoded before validation.
 */
export const initDataSchema = z.object({
  query_id: z.string().optional(),
  user: telegramUserSchema.optional(),
  receiver: telegramUserSchema.optional(),
  chat_type: z.string().optional(),
  chat_instance: z.string().optional(),
  start_param: z.string().optional(),
  auth_date: z.number().int().positive(),
  hash: z.string().min(1),
  signature: z.string().optional(),
});
export type InitData = z.infer<typeof initDataSchema>;

/** Roles persisted in User.role. Kept as strings for SQLite/Postgres parity. */
export const userRoleSchema = z.enum(['ADMIN', 'MANAGER', 'USER']);
export type UserRole = z.infer<typeof userRoleSchema>;

/** The authenticated caller, as resolved by the API. */
export const viewerSchema = z.object({
  id: z.string(),
  telegramId: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  username: z.string().nullable(),
  languageCode: z.string().nullable(),
  role: userRoleSchema,
  permissions: z.array(z.string()),
  /** Legacy response field; authorization uses role instead. */
  isAdmin: z.boolean(),
});
export type Viewer = z.infer<typeof viewerSchema>;
