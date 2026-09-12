import { z } from 'zod';
import { cuidSchema } from './catalog.js';
import { amountMinorSchema } from './money.js';

/**
 * Cashera payment contract (RUB, redirect flow).
 *
 * Cashera is an external gateway: the buyer is sent to a hosted page and pays
 * there, and the shop learns the outcome from a signed webhook. Nothing about the
 * gateway's credentials appears here — this file describes only what the Mini App
 * is allowed to see.
 *
 * Amounts are RUB kopecks throughout, which is both the shop's base unit and what
 * Cashera's API expects, so no conversion happens anywhere on this path.
 */

/**
 * Transaction lifecycle, as Cashera reports it.
 *
 * Only `paid` settles an order. Every other value is recorded and shown, and none
 * of them may release goods — the whole point of validating a webhook is that its
 * arrival is not itself proof of payment.
 */
export const CASHERA_STATUSES = [
  'pending',
  'paid',
  'failed',
  'expired',
  'refunded',
  'chargeback',
] as const;
export const casheraStatusSchema = z.enum(CASHERA_STATUSES);
export type CasheraStatus = z.infer<typeof casheraStatusSchema>;

/** Statuses after which no payment is expected any more. */
export const TERMINAL_CASHERA_STATUSES: readonly CasheraStatus[] = [
  'paid',
  'failed',
  'expired',
  'refunded',
  'chargeback',
];

export function isTerminalCasheraStatus(status: CasheraStatus): boolean {
  return TERMINAL_CASHERA_STATUSES.includes(status);
}

/**
 * What the Mini App needs to send a buyer to the gateway and follow the outcome.
 *
 * Deliberately absent: the API key, the shared secret, and any raw provider
 * payload. `uuid` is included because support needs a reference a buyer can quote,
 * and it is an opaque identifier that grants nothing on its own.
 */
export const casheraPaymentSchema = z.object({
  orderId: cuidSchema,
  provider: z.literal('cashera'),
  /** Cashera's own transaction id. Opaque; safe to display. */
  uuid: z.string().min(1).max(128),
  status: casheraStatusSchema,
  /** RUB kopecks. The same figure the order holds and the gateway was sent. */
  amountMinor: amountMinorSchema,
  currency: z.literal('RUB'),
  /** Which Cashera method settles this, e.g. "sbp". */
  paymentMethod: z.string().min(1).max(64),
  /**
   * Hosted page to open. Null once the transaction reaches a terminal state:
   * a stale payment link is worse than no link, because it invites a second
   * payment for an order that is already settled.
   */
  paymentUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
});
export type CasheraPayment = z.infer<typeof casheraPaymentSchema>;

/**
 * Webhook body.
 *
 * Parsed with the same strictness as any client input: a webhook is an
 * unauthenticated HTTP request until its headers have been checked, and even then
 * its body is a third party's data rather than ours.
 */
export const casheraWebhookSchema = z.object({
  event: z.string().min(1).max(128),
  transaction: z.object({
    uuid: z.string().min(1).max(128),
    external_id: z.string().min(1).max(128),
    status: casheraStatusSchema,
    /** Minor units, integer. Compared against the order before anything ships. */
    amount: z.number().int().nonnegative(),
    currency: z.string().min(1).max(8),
    payment_method: z.string().min(1).max(64).optional(),
    paid_at: z.string().nullish(),
  }),
});
export type CasheraWebhook = z.infer<typeof casheraWebhookSchema>;

/** Human-facing copy for each status, so both screens agree on wording. */
export const CASHERA_STATUS_LABEL: Record<CasheraStatus, string> = {
  pending: 'Ожидаем оплату',
  paid: 'Оплачено',
  failed: 'Оплата не прошла',
  expired: 'Время оплаты истекло',
  refunded: 'Возврат',
  chargeback: 'Оспорено',
};
