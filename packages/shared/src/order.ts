import { z } from 'zod';
import { amountMinorSchema, currencySchema } from './money.js';
import { cuidSchema, fulfillmentKindSchema } from './catalog.js';

export const MAX_LINE_QUANTITY = 99;
export const MAX_CART_LINES = 50;

/**
 * Order lifecycle:
 *   PENDING  -> invoice created, waiting for payment
 *   PAID     -> payment confirmed by Telegram, goods delivered
 *   CANCELLED-> abandoned or rejected before payment
 *   REFUNDED -> Stars payment refunded
 *   FAILED   -> payment confirmed but delivery failed (needs manual action)
 */
export const ORDER_STATUSES = [
  'PENDING',
  'PAID',
  'CANCELLED',
  'REFUNDED',
  'FAILED',
] as const;
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/** What the client is allowed to send. Prices are NEVER trusted from client. */
export const cartLineInputSchema = z.object({
  productId: cuidSchema,
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
});
export type CartLineInput = z.infer<typeof cartLineInputSchema>;

export const createOrderInputSchema = z.object({
  items: z.array(cartLineInputSchema).min(1).max(MAX_CART_LINES),
  /** Optional buyer note / email for receipts. */
  comment: z.string().max(500).optional(),
});
export type CreateOrderInput = z.infer<typeof createOrderInputSchema>;

/** Server-computed line, safe to render. */
export const orderLineSchema = z.object({
  id: cuidSchema,
  productId: cuidSchema,
  titleSnapshot: z.string(),
  unitAmountMinor: amountMinorSchema,
  quantity: z.number().int().min(1),
  totalAmountMinor: amountMinorSchema,
  fulfillmentKind: fulfillmentKindSchema,
  /** Delivered secret (key / link). Only present after successful payment. */
  deliveredPayload: z.string().nullable(),
});
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderSchema = z.object({
  id: cuidSchema,
  /** Short human-readable number shown in UI, e.g. "A7F3C1". */
  reference: z.string().min(4).max(24),
  status: orderStatusSchema,
  currency: currencySchema,
  totalAmountMinor: amountMinorSchema,
  comment: z.string().nullable(),
  createdAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
  lines: z.array(orderLineSchema),
});
export type Order = z.infer<typeof orderSchema>;

/** Response after creating an order: what the client needs to start payment. */
export const checkoutSessionSchema = z.object({
  order: orderSchema,
  /**
   * Telegram invoice link (https://t.me/invoice/...) to be opened with
   * `WebApp.openInvoice`. Null when the order needs no payment (free items).
   */
  invoiceUrl: z.string().url().nullable(),
});
export type CheckoutSession = z.infer<typeof checkoutSessionSchema>;

/** Result reported back by the Mini App after `openInvoice` closes. */
export const INVOICE_RESULT_STATUSES = [
  'paid',
  'cancelled',
  'failed',
  'pending',
] as const;
export const invoiceResultStatusSchema = z.enum(INVOICE_RESULT_STATUSES);
export type InvoiceResultStatus = z.infer<typeof invoiceResultStatusSchema>;

/** Computes a line total without floating point drift. */
export function lineTotal(unitAmountMinor: number, quantity: number): number {
  return unitAmountMinor * quantity;
}

export function sumMinor(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}
