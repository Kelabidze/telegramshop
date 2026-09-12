import { timingSafeEqual } from 'node:crypto';
import {
  type CasheraPayment,
  type CasheraStatus,
  type CasheraWebhook,
  casheraStatusSchema,
  isTerminalCasheraStatus,
} from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, notFound } from '../errors.js';
import {
  createTransaction,
  getTransaction,
  getTransactionByExternalId,
} from '../payments/cashera-client.js';
import { markOrderPaid } from './orders.js';

/**
 * Cashera payments: creation, webhook handling, and the decision to settle.
 *
 * The rule this module exists to enforce: a webhook arriving is not proof of
 * payment. Before anything ships, the event is authenticated, deduplicated, matched
 * to an order, and its amount and currency are compared against what that order
 * actually asked for. Only then, and only for `paid`, does the order settle.
 */

/**
 * `external_id` for an order.
 *
 * The order id itself, prefixed. Derived rather than random so it is stable across
 * retries вЂ” that is what makes Cashera's idempotency usable вЂ” and so a support
 * question about an `external_id` maps back to an order without a lookup table.
 */
export function externalIdForOrder(orderId: string): string {
  return `ord_${orderId}`;
}

function toApiCasheraPayment(row: {
  orderId: string;
  uuid: string;
  status: string;
  amountMinor: number;
  paymentMethod: string;
  paymentUrl: string | null;
  createdAt: Date;
  paidAt: Date | null;
}): CasheraPayment {
  const status = casheraStatusSchema.catch('pending').parse(row.status);
  return {
    orderId: row.orderId,
    provider: 'cashera',
    uuid: row.uuid,
    status,
    amountMinor: row.amountMinor,
    currency: 'RUB',
    paymentMethod: row.paymentMethod,
    // Withheld once the payment is settled or dead: a live-looking link on a paid
    // order invites a second payment for goods already delivered.
    paymentUrl: isTerminalCasheraStatus(status) ? null : row.paymentUrl,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}

/** Public origin for gateway callbacks. Never localhost in production. */
function publicOrigin(): string {
  const origin = config.publicApiUrl || config.publicAppUrl;
  if (!origin) {
    throw new AppError(
      'CARD_PAYMENTS_DISABLED',
      'РќРµ РЅР°СЃС‚СЂРѕРµРЅ РїСѓР±Р»РёС‡РЅС‹Р№ Р°РґСЂРµСЃ РґР»СЏ РѕР±СЂР°С‚РЅС‹С… РІС‹Р·РѕРІРѕРІ РїР»Р°С‚С‘Р¶РЅРѕРіРѕ С€Р»СЋР·Р°.',
    );
  }
  return origin;
}

/**
 * Opens a Cashera payment for an order, or returns the one it already has.
 *
 * Idempotent at two levels: this row is unique per order, and the `external_id`
 * sent to Cashera is derived from the order. A buyer reloading checkout gets the
 * same payment link rather than a second transaction.
 */
export async function createPaymentForOrder(
  orderId: string,
): Promise<CasheraPayment> {
  if (!config.cashera.enabled) {
    throw new AppError(
      'CARD_PAYMENTS_DISABLED',
      'РћРїР»Р°С‚Р° РєР°СЂС‚РѕР№ СЃРµР№С‡Р°СЃ РЅРµРґРѕСЃС‚СѓРїРЅР°.',
    );
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      currency: true,
      totalAmountMinor: true,
      reference: true,
      casheraPayment: { select: { id: true } },
      lines: { select: { titleSnapshot: true, quantity: true } },
    },
  });
  if (!order) throw notFound(`Order ${orderId} was not found.`);

  if (order.casheraPayment) {
    const existing = await getPaymentByOrderId(orderId);
    if (existing) return existing;
  }

  if (order.status !== 'PENDING') {
    throw new AppError(
      'ORDER_NOT_PAYABLE',
      `Р—Р°РєР°Р· СѓР¶Рµ РІ СЃРѕСЃС‚РѕСЏРЅРёРё ${order.status} Рё РЅРµ РјРѕР¶РµС‚ Р±С‹С‚СЊ РѕРїР»Р°С‡РµРЅ.`,
    );
  }
  if (order.currency !== 'RUB') {
    throw new AppError(
      'CURRENCY_MISMATCH',
      `Р—Р°РєР°Р· РѕС„РѕСЂРјР»РµРЅ РІ ${order.currency}, Р° РЅРµ РІ RUB.`,
    );
  }

  const externalId = externalIdForOrder(order.id);
  const origin = publicOrigin();
  const description =
    order.lines.length === 1
      ? `${order.lines[0]!.titleSnapshot} Г— ${order.lines[0]!.quantity}`
      : `Р—Р°РєР°Р· в„–${order.reference}`;

  const dto = await createTransaction({
    // The order's own total, in the unit it is already stored in. No conversion
    // happens on this rail: RUB kopecks are what the base price holds and what
    // the gateway expects.
    amountMinor: order.totalAmountMinor,
    currency: 'RUB',
    paymentMethod: config.cashera.paymentMethod,
    externalId,
    description: description.slice(0, 200),
    callbackUrl: `${origin}/webhooks/cashera`,
    successUrl: `${origin}/pay/ok?order=${encodeURIComponent(order.id)}`,
    failUrl: `${origin}/pay/fail?order=${encodeURIComponent(order.id)}`,
  });

  if (!dto.uuid) {
    throw new AppError(
      'PAYMENT_PROVIDER_ERROR',
      'РџР»Р°С‚С‘Р¶РЅС‹Р№ С€Р»СЋР· РЅРµ РІРµСЂРЅСѓР» РёРґРµРЅС‚РёС„РёРєР°С‚РѕСЂ С‚СЂР°РЅР·Р°РєС†РёРё.',
    );
  }

  /**
   * `upsert` on `externalId`, not `create`.
   *
   * A retried create returns the same transaction from Cashera, and this row may
   * already exist from the attempt whose response was lost. Upserting makes the
   * whole path idempotent rather than only the gateway half of it.
   */
  const row = await prisma.casheraTransaction.upsert({
    where: { externalId },
    create: {
      orderId: order.id,
      externalId,
      uuid: dto.uuid,
      status: casheraStatusSchema.catch('pending').parse(dto.status ?? 'pending'),
      amountMinor: order.totalAmountMinor,
      currency: 'RUB',
      paymentMethod: dto.payment_method ?? config.cashera.paymentMethod,
      paymentUrl: dto.payment_url ?? null,
    },
    update: {
      // Refresh the link: a re-created transaction can carry a new one. The status
      // is deliberately NOT taken from this response вЂ” a webhook may already have
      // moved it on, and a stale `pending` here would undo that.
      paymentUrl: dto.payment_url ?? undefined,
      uuid: dto.uuid,
    },
    select: {
      orderId: true,
      uuid: true,
      status: true,
      amountMinor: true,
      paymentMethod: true,
      paymentUrl: true,
      createdAt: true,
      paidAt: true,
    },
  });

  return toApiCasheraPayment(row);
}

export async function getPaymentByOrderId(
  orderId: string,
): Promise<CasheraPayment | null> {
  const row = await prisma.casheraTransaction.findUnique({
    where: { orderId },
    select: {
      orderId: true,
      uuid: true,
      status: true,
      amountMinor: true,
      paymentMethod: true,
      paymentUrl: true,
      createdAt: true,
      paidAt: true,
    },
  });
  return row ? toApiCasheraPayment(row) : null;
}

/**
 * Constant-time credential check for an inbound webhook.
 *
 * Length is compared first and both operands are hashed to a fixed width, because
 * `timingSafeEqual` throws on a length mismatch вЂ” and the throw itself would leak
 * the expected length. Comparing byte-for-byte in JS would leak it through timing.
 */
function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still do a comparison of equal-length buffers so the work is constant
    // regardless of which branch is taken.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** True when both webhook headers match the configured credentials. */
export function authenticateWebhook(headers: {
  apiKey?: string | undefined;
  secret?: string | undefined;
}): boolean {
  if (!config.cashera.enabled) return false;
  // Both, not either: the key identifies the merchant and the secret proves the
  // caller is Cashera. One without the other is not an authenticated request.
  const keyOk = secretsMatch(headers.apiKey, config.cashera.apiKey);
  const secretOk = secretsMatch(headers.secret, config.cashera.apiSecret);
  return keyOk && secretOk;
}

export type WebhookOutcome =
  | { handled: true; duplicate: boolean; status: CasheraStatus }
  | { handled: false; reason: string };

/**
 * Processes an authenticated webhook.
 *
 * Order of operations matters and is deliberate:
 *
 *  1. Claim the event `(uuid, status)`. A unique constraint arbitrates concurrent
 *     duplicates вЂ” two simultaneous deliveries cannot both proceed.
 *  2. Find the transaction and its order by our own `external_id`.
 *  3. Verify amount and currency against the order.
 *  4. Only for `paid`, settle through the shared `markOrderPaid`.
 *
 * Returns rather than throws for business-level rejections: Cashera should not be
 * asked to retry an event that will never be accepted, so the route answers 200
 * with the outcome recorded.
 */
export async function handleWebhook(
  payload: CasheraWebhook,
): Promise<WebhookOutcome> {
  const tx = payload.transaction;
  const status = tx.status;

  const row = await prisma.casheraTransaction.findUnique({
    where: { externalId: tx.external_id },
    select: {
      id: true,
      orderId: true,
      uuid: true,
      amountMinor: true,
      currency: true,
      status: true,
    },
  });

  /**
   * Claim the event first, before any business logic.
   *
   * The insert is the lock: if a duplicate is already recorded, this throws and the
   * work is skipped. Doing the work first and recording afterwards would leave a
   * window in which two concurrent deliveries both settle the order.
   */
  try {
    await prisma.casheraWebhookEvent.create({
      data: {
        transactionUuid: tx.uuid,
        status,
        transactionId: row?.id ?? null,
      },
    });
  } catch {
    // Unique violation: this exact event has been handled.
    return { handled: true, duplicate: true, status };
  }

  if (!row) {
    return { handled: false, reason: 'unknown external_id' };
  }
  // A uuid that does not match the one we recorded means this event belongs to a
  // different transaction than the reference claims.
  if (row.uuid !== tx.uuid) {
    return { handled: false, reason: 'uuid does not match external_id' };
  }

  // Record the reported status regardless of whether it settles anything, so the
  // buyer's screen and staff diagnostics reflect reality.
  await prisma.casheraTransaction.update({
    where: { id: row.id },
    data: {
      status,
      ...(tx.payment_method ? { paymentMethod: tx.payment_method } : {}),
      ...(status === 'paid'
        ? { paidAt: parsePaidAt(tx.paid_at) ?? new Date() }
        : {}),
      // A dead payment must not keep a usable link.
      ...(isTerminalCasheraStatus(status) ? { paymentUrl: null } : {}),
    },
  });

  if (status !== 'paid') {
    // pending / failed / expired / refunded / chargeback all stop here. None of
    // them may release goods, and a refund or chargeback on a delivered order is a
    // human decision rather than an automatic reversal of fulfilment.
    return { handled: true, duplicate: false, status };
  }

  /**
   * Verify the money before shipping.
   *
   * The webhook is authenticated, but authentication only proves who sent it вЂ” not
   * that the figures agree with what this shop asked for. A mismatch is a
   * configuration or integration fault, and shipping on it would be shipping for a
   * price nobody agreed to.
   */
  if (tx.currency.toUpperCase() !== row.currency.toUpperCase()) {
    return { handled: false, reason: 'currency mismatch' };
  }
  if (tx.amount !== row.amountMinor) {
    return { handled: false, reason: 'amount mismatch' };
  }

  /**
   * Settle. `markOrderPaid` is idempotent вЂ” an already-paid order returns unchanged
   * and each line is skipped once delivered вЂ” so a replay that slipped past the
   * event guard still cannot hand over a second key.
   */
  const paid = await markOrderPaid({ kind: 'cashera', orderId: row.orderId });

  if (paid) {
    const { notifyOrderDelivered } = await import('../telegram/delivery.js');
    await notifyOrderDelivered(paid);
  }

  return { handled: true, duplicate: false, status };
}

function parsePaidAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Re-reads the gateway's own record and applies it locally.
 *
 * The recovery path for a webhook that never arrived. Reuses `handleWebhook`, so a
 * status learned by polling goes through exactly the same verification and
 * deduplication as one that was pushed вЂ” two code paths to settle an order would be
 * two chances to get the checks wrong.
 */
export async function refreshFromGateway(
  orderId: string,
): Promise<CasheraPayment | null> {
  const row = await prisma.casheraTransaction.findUnique({
    where: { orderId },
    select: { uuid: true, externalId: true },
  });
  if (!row) return null;

  const dto = row.uuid
    ? await getTransaction(row.uuid)
    : await getTransactionByExternalId(row.externalId);

  const status = casheraStatusSchema.safeParse(dto.status);
  if (status.success) {
    await handleWebhook({
      event: 'transaction.status_updated',
      transaction: {
        uuid: dto.uuid,
        external_id: row.externalId,
        status: status.data,
        // The gateway's figures, so verification compares against the source
        // rather than against our own copy of it.
        amount: dto.amount ?? -1,
        currency: dto.currency ?? 'RUB',
        ...(dto.payment_method ? { payment_method: dto.payment_method } : {}),
        paid_at: dto.paid_at ?? null,
      },
    });
  }

  return getPaymentByOrderId(orderId);
}

/** Recent transactions for staff diagnostics. No credentials, no raw payloads. */
export async function listCasheraPaymentsForStaff(limit = 100) {
  const rows = await prisma.casheraTransaction.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      uuid: true,
      externalId: true,
      status: true,
      amountMinor: true,
      currency: true,
      paymentMethod: true,
      createdAt: true,
      paidAt: true,
      order: { select: { id: true, reference: true, status: true } },
      _count: { select: { events: true } },
    },
  });

  return rows.map((row) => ({
    uuid: row.uuid,
    externalId: row.externalId,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    paymentMethod: row.paymentMethod,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    orderId: row.order.id,
    orderReference: row.order.reference,
    orderStatus: row.order.status,
    eventCount: row._count.events,
  }));
}

export type StaffCasheraPayment = Awaited<
  ReturnType<typeof listCasheraPaymentsForStaff>
>[number];
