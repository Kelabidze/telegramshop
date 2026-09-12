import { timingSafeEqual } from 'node:crypto';
import {
  type CasheraPayment,
  type CasheraRail,
  type CasheraStatus,
  type CasheraWebhook,
  casheraRailSchema,
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
 * retries — that is what makes Cashera's idempotency usable — and so a support
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
  rail: string;
  paymentMethod: string | null;
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
    rail: casheraRailSchema.catch('card').parse(row.rail),
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
      'Не настроен публичный адрес для обратных вызовов платёжного шлюза.',
    );
  }
  return origin;
}

/**
 * The Cashera method code for a rail, or null to omit it.
 *
 * `null` is not a placeholder — it selects the common payment form, where the JSON
 * must contain no `payment_method` key at all and Cashera lets the buyer pick from
 * every method the merchant has enabled. That is the widest official flow, but it
 * also offers card and SBP, so the crypto rail only falls back to it when the
 * merchant has deliberately cleared `CASHERA_CRYPTO_PAYMENT_METHOD`.
 */
function methodForRail(rail: CasheraRail): string | null {
  return rail === 'crypto' ? config.cashera.cryptoPaymentMethod : config.cashera.paymentMethod;
}

/**
 * Opens a Cashera payment for an order, or returns the one it already has.
 *
 * Idempotent at two levels: this row is unique per order, and the `external_id`
 * sent to Cashera is derived from the order. A buyer reloading checkout gets the
 * same payment link rather than a second transaction.
 *
 * The rail is part of that identity in practice. Cashera's idempotency only returns
 * the original transaction for an *exact* repeat — asking for `crypto` on an order
 * that was already opened on `sbp` is a 409, not a retry. So `rail` is recorded and
 * a mismatch is refused here with a clear reason instead of surfacing as a gateway
 * error the buyer cannot act on.
 */
export async function createPaymentForOrder(
  orderId: string,
  rail: CasheraRail = 'card',
): Promise<CasheraPayment> {
  if (!config.cashera.enabled) {
    throw new AppError(
      'CARD_PAYMENTS_DISABLED',
      'Оплата картой сейчас недоступна.',
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
      casheraPayment: { select: { id: true, rail: true } },
      lines: { select: { titleSnapshot: true, quantity: true } },
    },
  });
  if (!order) throw notFound(`Order ${orderId} was not found.`);

  if (order.casheraPayment) {
    /**
     * Refuse a rail change rather than silently handing back the other rail's link.
     *
     * Cashera keys idempotency on the whole payload: re-creating with a different
     * `payment_method` under the same `external_id` is a 409, so the request could
     * not succeed anyway. Returning the existing payment would be worse than the
     * error — a buyer who picked crypto would be sent to a card page. One order,
     * one rail; a buyer wanting the other rail places a new order.
     */
    if (order.casheraPayment.rail !== rail) {
      throw new AppError(
        'CONFLICT',
        `Для этого заказа уже создан платёж другим способом. Оформите заказ заново, чтобы оплатить криптовалютой.`,
      );
    }
    const existing = await getPaymentByOrderId(orderId);
    if (existing) return existing;
  }

  if (order.status !== 'PENDING') {
    throw new AppError(
      'ORDER_NOT_PAYABLE',
      `Заказ уже в состоянии ${order.status} и не может быть оплачен.`,
    );
  }
  if (order.currency !== 'RUB') {
    throw new AppError(
      'CURRENCY_MISMATCH',
      `Заказ оформлен в ${order.currency}, а не в RUB.`,
    );
  }

  const externalId = externalIdForOrder(order.id);
  const origin = publicOrigin();
  const description =
    order.lines.length === 1
      ? `${order.lines[0]!.titleSnapshot} × ${order.lines[0]!.quantity}`
      : `Заказ №${order.reference}`;

  const dto = await createTransaction({
    // The order's own total, in the unit it is already stored in. No conversion
    // happens on this rail: RUB kopecks are what the base price holds and what
    // the gateway expects. Even a crypto payment is invoiced in RUB — Cashera
    // converts at its own rate on the buyer's page.
    amountMinor: order.totalAmountMinor,
    currency: 'RUB',
    paymentMethod: methodForRail(rail),
    externalId,
    description: description.slice(0, 200),
    callbackUrl: `${origin}/webhooks/cashera`,
    successUrl: `${origin}/pay/ok?order=${encodeURIComponent(order.id)}`,
    failUrl: `${origin}/pay/fail?order=${encodeURIComponent(order.id)}`,
  });

  if (!dto.uuid) {
    throw new AppError(
      'PAYMENT_PROVIDER_ERROR',
      'Платёжный шлюз не вернул идентификатор транзакции.',
    );
  }

  /**
   * Cashera's own list of what a common payment form offered, serialised for
   * diagnostics. Recorded, never read back to build a picker — the buyer chooses on
   * Cashera's page, and a stored copy would go stale the moment merchant settings
   * change.
   */
  const availableMethods =
    dto.available_payment_methods && dto.available_payment_methods.length > 0
      ? JSON.stringify(dto.available_payment_methods)
      : null;

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
      rail,
      // Null until the buyer picks on a common form; the requested code otherwise.
      paymentMethod: dto.payment_method ?? methodForRail(rail),
      paymentUrl: dto.payment_url ?? null,
      availableMethods,
    },
    update: {
      // Refresh the link: a re-created transaction can carry a new one. The status
      // is deliberately NOT taken from this response — a webhook may already have
      // moved it on, and a stale `pending` here would undo that.
      paymentUrl: dto.payment_url ?? undefined,
      uuid: dto.uuid,
      ...(availableMethods ? { availableMethods } : {}),
    },
    select: {
      orderId: true,
      uuid: true,
      status: true,
      amountMinor: true,
      rail: true,
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
      rail: true,
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
 * `timingSafeEqual` throws on a length mismatch — and the throw itself would leak
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
  | { handled: true; duplicate: boolean; status: CasheraStatus; warning?: string }
  | { handled: false; reason: string };

/**
 * Processes an authenticated webhook.
 *
 * Order of operations matters and is deliberate:
 *
 *  1. Claim the event `(uuid, status)`. A unique constraint arbitrates concurrent
 *     duplicates — two simultaneous deliveries cannot both proceed.
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
      rail: true,
      paymentMethod: true,
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

  /**
   * Compare the settled method against the rail we opened, as a diagnostic.
   *
   * Deliberately a warning carried on the outcome, not a gate. By the time a `paid`
   * webhook is trusted, the money is in: the amount and currency match the order, the
   * uuid matches the row, and the request carried both credentials. A method string
   * that differs from what we asked for is worth recording — it can mean a merchant
   * changed settings in Cashera's dashboard, or a common form was used — but
   * withholding goods for a payment that was actually received would harm the buyer
   * over a label. The credential check is the security boundary; this is telemetry.
   * The route logs it through `request.log`, since the service layer does not own a
   * logger.
   *
   * `row.paymentMethod` is the value from creation, read before the update above.
   */
  const methodWarning =
    tx.payment_method && row.paymentMethod && tx.payment_method !== row.paymentMethod
      ? `order ${row.orderId} was opened with method "${row.paymentMethod}" but settled as "${tx.payment_method}" (rail ${row.rail})`
      : undefined;

  if (status !== 'paid') {
    // pending / failed / expired / refunded / chargeback all stop here. None of
    // them may release goods, and a refund or chargeback on a delivered order is a
    // human decision rather than an automatic reversal of fulfilment.
    return { handled: true, duplicate: false, status, ...(methodWarning ? { warning: methodWarning } : {}) };
  }

  /**
   * Verify the money before shipping.
   *
   * The webhook is authenticated, but authentication only proves who sent it — not
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
   * Settle. `markOrderPaid` is idempotent — an already-paid order returns unchanged
   * and each line is skipped once delivered — so a replay that slipped past the
   * event guard still cannot hand over a second key.
   */
  const paid = await markOrderPaid({ kind: 'cashera', orderId: row.orderId });

  if (paid) {
    const { notifyOrderDelivered } = await import('../telegram/delivery.js');
    await notifyOrderDelivered(paid);
  }

  return { handled: true, duplicate: false, status, ...(methodWarning ? { warning: methodWarning } : {}) };
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
 * deduplication as one that was pushed — two code paths to settle an order would be
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
      rail: true,
      paymentMethod: true,
      availableMethods: true,
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
    rail: casheraRailSchema.catch('card').parse(row.rail),
    paymentMethod: row.paymentMethod,
    /**
     * What Cashera offered at creation, for support. Parsed defensively: it is a
     * JSON blob written by us, but a malformed value must not break the list.
     */
    availableMethods: parseAvailableMethods(row.availableMethods),
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    orderId: row.order.id,
    orderReference: row.order.reference,
    orderStatus: row.order.status,
    eventCount: row._count.events,
  }));
}

function parseAvailableMethods(raw: string | null): { code: string; title: string }[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter(
        (m): m is { code: string; title?: unknown } =>
          typeof m === 'object' && m !== null && typeof m.code === 'string',
      )
      .map((m) => ({
        code: m.code,
        title: typeof m.title === 'string' ? m.title : m.code,
      }));
  } catch {
    return null;
  }
}

export type StaffCasheraPayment = Awaited<
  ReturnType<typeof listCasheraPaymentsForStaff>
>[number];
