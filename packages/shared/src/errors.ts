import { z } from 'zod';

/** Machine-readable API error codes shared by server and client. */
export const API_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  /** A unique constraint would be violated, e.g. a slug already in use. */
  'CONFLICT',
  'OUT_OF_STOCK',
  'PRODUCT_UNAVAILABLE',
  'CURRENCY_MISMATCH',
  'ORDER_NOT_PAYABLE',
  'PAYMENTS_DISABLED',
  /** Crypto checkout is switched off, or configured without a derivation key. */
  'CRYPTO_PAYMENTS_DISABLED',
  /** The order already has a live payment intent; reuse it instead of opening another. */
  'PAYMENT_INTENT_EXISTS',
  /** The intent's deadline passed. A new one has to be created. */
  'PAYMENT_INTENT_EXPIRED',
  /** No deposit address could be issued (derivation misconfigured or exhausted). */
  'DEPOSIT_ADDRESS_UNAVAILABLE',
  /** Card/SBP payments are switched off, or configured without credentials. */
  'CARD_PAYMENTS_DISABLED',
  /** The payment gateway refused or could not be reached. */
  'PAYMENT_PROVIDER_ERROR',
  /**
   * No trustworthy exchange rate is available, so a USDT amount cannot be quoted.
   * Roubles and Stars are unaffected.
   */
  'RATE_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Field-level details for VALIDATION_ERROR. */
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const HTTP_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  OUT_OF_STOCK: 409,
  PRODUCT_UNAVAILABLE: 409,
  CURRENCY_MISMATCH: 409,
  ORDER_NOT_PAYABLE: 409,
  PAYMENTS_DISABLED: 503,
  CRYPTO_PAYMENTS_DISABLED: 503,
  PAYMENT_INTENT_EXISTS: 409,
  PAYMENT_INTENT_EXPIRED: 409,
  DEPOSIT_ADDRESS_UNAVAILABLE: 503,
  CARD_PAYMENTS_DISABLED: 503,
  // 502: the failure is upstream, and saying so distinguishes "the gateway is
  // unhappy" from "we sent something invalid".
  PAYMENT_PROVIDER_ERROR: 502,
  // 503: the rail is temporarily unusable and retrying later is the right move.
  RATE_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};
