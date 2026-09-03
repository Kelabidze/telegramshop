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

/**
 * Roles persisted in `User.role`. Strings rather than a Prisma enum, like every
 * other "enum" in this schema, so SQLite and Postgres behave identically.
 *
 * `ADMIN` is granted exclusively by `ADMIN_TELEGRAM_IDS` and cannot be assigned
 * from the database: see `plugins/auth.ts`.
 */
export const userRoleSchema = z.enum(['ADMIN', 'MANAGER', 'USER']);
export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * Every permission a MANAGER can be granted, as rows in `ManagerPermission`.
 *
 * A closed list rather than free-form strings: `requirePermission('EDIT_CATALGO')`
 * would otherwise compile, deploy and then silently refuse every caller — a typo
 * in a guard fails closed and looks exactly like a legitimate 403.
 *
 * Adding a permission means adding it here first; the guard and the seed both
 * validate against this list.
 */
export const permissionSchema = z.enum([
  /** Create, edit and hide products and categories. */
  'EDIT_CATALOG',
  /** Upload and revoke license keys (the stock of a digital shop). */
  'MANAGE_KEYS',
  /** Read other users' orders and resolve FAILED deliveries. */
  'VIEW_ORDERS',
  /** Refund a paid order. */
  'REFUND_ORDERS',
  /** Grant and revoke manager permissions. ADMIN-adjacent: hand out sparingly. */
  'MANAGE_MANAGERS',
]);
export type Permission = z.infer<typeof permissionSchema>;

/** All permissions, for iteration in seeds, admin UIs and tests. */
export const PERMISSIONS = permissionSchema.options;

/**
 * Marker the bot puts on the "я подписался" button's URL, and which the Mini
 * App sends back to ask for a fresh membership lookup.
 *
 * Shared because three places must agree on the literal: the bot builds the
 * URL, the Mini App recognises it, the API acts on it. Drift would be silent —
 * the button would simply stop refreshing the club status, which is
 * indistinguishable from the membership check being broken.
 *
 * Note it travels as an **ordinary query parameter**, not Telegram's
 * `start_param`: Telegram only populates that for direct `t.me/bot/app?startapp`
 * links and the attachment menu, never for an inline `web_app` button. Relying
 * on `initData.start_param` here would compile, deploy, and never once fire.
 *
 * It is only ever a hint to re-ask Telegram. The answer always comes from
 * `getChatMember`, so an unsigned parameter cannot grant anybody a lower price.
 */
export const CLUB_RECHECK_PARAM = 'club_check';

/** The authenticated caller, as resolved by the API. */
export const viewerSchema = z.object({
  id: z.string(),
  telegramId: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  username: z.string().nullable(),
  languageCode: z.string().nullable(),
  role: userRoleSchema,
  /**
   * Granted permissions. Unknown strings in the database are dropped rather
   * than surfaced: a permission deleted from the code must stop granting
   * access, not leak through as an unrecognised value.
   */
  permissions: z.array(permissionSchema),
  /**
   * Membership in the club channel, as verified server-side. Drives the club
   * tier: a member pays the stored price, everyone else the standard one.
   *
   * The client never asserts this — like every other identity fact it comes
   * from the API, which asks Telegram. Defaulted to `false` so a viewer coming
   * from an older API still parses and simply gets no club rate.
   */
  isSubscribedChannel: z.boolean().default(false),
  /**
   * Legacy mirror of `role === 'ADMIN'`, kept so existing clients keep working.
   * No authorization check reads it.
   */
  isAdmin: z.boolean(),
});
export type Viewer = z.infer<typeof viewerSchema>;
