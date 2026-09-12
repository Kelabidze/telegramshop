import { z } from 'zod';
import { amountMinorSchema, currencySchema } from './money.js';
import { type PaymentCurrency, paymentCurrencySchema } from './base-price.js';
import { cryptoPaymentSchema } from './crypto-payment.js';
import { casheraPaymentSchema, casheraRailSchema, type CasheraRail } from './cashera.js';
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

/**
 * Where a snapshotted rate came from.
 *
 * RAPIRA — a live exchange quote. CONFIG — a configured constant. NONE — no
 * conversion happened (roubles), or the order predates these columns.
 */
export const RATE_SOURCES = ['RAPIRA', 'CONFIG', 'NONE'] as const;
export const rateSourceSchema = z.enum(RATE_SOURCES);
export type RateSource = z.infer<typeof rateSourceSchema>;

/** Side of the order book, when the source was an exchange. */
export const rateSideSchema = z.enum(['ask', 'bid']).nullable();
export type RateSide = z.infer<typeof rateSideSchema>;

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
  /**
   * How the buyer wants to pay. Not a price — the amount is still derived
   * server-side from the product's base price and the server's own rate. This
   * only picks which derivation and which settlement rail to use.
   *
   * Defaults to Stars so an older client that does not send it keeps working.
   */
  paymentCurrency: paymentCurrencySchema.default('XTR'),
  /**
   * Within the RUB/Cashera rail, which flow to open: `card` or `crypto`.
   *
   * Only read when `paymentCurrency` is `RUB`; ignored otherwise. Never a coin —
   * the crypto rail hands off to Cashera, which presents whatever currencies the
   * merchant has enabled on its own page.
   *
   * Defaults to `card` so a client that does not send it behaves as before.
   */
  casheraRail: casheraRailSchema.default('card'),
});
/**
 * `paymentCurrency` is optional on the input type even though zod defaults it:
 * the parsed output always has it, but callers constructing the object by hand
 * (tests, internal service calls) should not have to name it.
 */
export type CreateOrderInput = Omit<
  z.infer<typeof createOrderInputSchema>,
  'paymentCurrency' | 'casheraRail'
> & { paymentCurrency?: PaymentCurrency; casheraRail?: CasheraRail };

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
  /**
   * The order total in the base currency (RUB kopecks) at checkout time.
   *
   * Snapshotted so the order stays readable after a rate change: `currency` +
   * `totalAmountMinor` say what was charged, these two say why that number.
   */
  totalBaseRubMinor: amountMinorSchema,
  /** RUB kopecks per one unit of `currency`, as used at checkout. */
  rateRubMinorPerUnit: z.number().int().positive(),
  /**
   * Where that rate came from. Defaulted for orders created before the column.
   *
   * A live exchange quote and a configured constant are different claims about a
   * price, and an order kept for months should say which one it was.
   */
  rateSource: rateSourceSchema.default('NONE'),
  rateSide: rateSideSchema.default(null),
  rateFetchedAt: z.string().datetime().nullable().default(null),
  comment: z.string().nullable(),
  createdAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
  lines: z.array(orderLineSchema),
});
export type Order = z.infer<typeof orderSchema>;

/**
 * Response after creating an order: what the client needs to start payment.
 *
 * Exactly one of the two payment fields is set, chosen by `order.currency`:
 * Stars get an invoice URL, USDT gets an on-chain payment. Both null means the
 * order needs no payment at all (a free item).
 */
export const checkoutSessionSchema = z.object({
  order: orderSchema,
  /**
   * Telegram invoice link (https://t.me/invoice/...) to be opened with
   * `WebApp.openInvoice`. Null for on-chain and free orders.
   */
  invoiceUrl: z.string().url().nullable(),
  /** On-chain payment details. Null for Stars and free orders. */
  cryptoPayment: cryptoPaymentSchema.nullable().default(null),
  /** Cashera (RUB) payment details. Null for every other rail. */
  casheraPayment: casheraPaymentSchema.nullable().default(null),
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
