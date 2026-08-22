import { z } from 'zod';

/** Machine-readable API error codes shared by server and client. */
export const API_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'OUT_OF_STOCK',
  'PRODUCT_UNAVAILABLE',
  'CURRENCY_MISMATCH',
  'ORDER_NOT_PAYABLE',
  'PAYMENTS_DISABLED',
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
  OUT_OF_STOCK: 409,
  PRODUCT_UNAVAILABLE: 409,
  CURRENCY_MISMATCH: 409,
  ORDER_NOT_PAYABLE: 409,
  PAYMENTS_DISABLED: 503,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};
