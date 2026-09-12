import { randomBytes, randomUUID } from 'node:crypto';
import {
  type CreateOrderInput,
  type CasheraPayment,
  type CryptoPayment,
  type Order,
  type OrderLine,
  type PaymentCurrency,
  type Viewer,
  currencySchema,
  effectiveUnitMinor,
  fulfillmentKindSchema,
  orderStatusSchema,
  rateSideSchema,
  rateSourceSchema,
  payableMinorForCurrency,
  rateForCurrency,
} from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { payments } from '../payments/gateway.js';

/**
 * Order + fulfillment logic.
 *
 * Invariants enforced here:
 *  1. Prices always come from the database, never from the client.
 *  2. A single order cannot mix currencies (Telegram invoices are one currency).
 *  3. License keys are claimed with a conditional UPDATE, so concurrent buyers
 *     can never receive the same key and stock cannot go negative.
 *  4. Payment processing is idempotent: replaying a Telegram update does not
 *     deliver goods twice.
 *  5. The club rate is applied from the viewer's verified membership, never
 *     from anything the client sends.
 *  6. A product has ONE price, in RUB. What the buyer is charged — Stars, USDT —
 *     is derived here from the server's configured rate and then snapshotted, so
 *     a later rate change cannot rewrite an order that already exists.
 */

/** Human-friendly order code. Avoids ambiguous characters (0/O, 1/I). */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateReference(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (const byte of bytes) {
    out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return out;
}

/** Invoice payload must stay within 128 bytes. A UUID is 36 chars. */
function generateInvoicePayload(): string {
  return `ord_${randomUUID()}`;
}

type DbOrder = Awaited<ReturnType<typeof loadOrderRecord>>;

async function loadOrderRecord(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
}

/** Maps a database row to the shared API shape. */
function toApiOrder(order: NonNullable<DbOrder>): Order {
  const lines: OrderLine[] = order.lines.map((line) => ({
    id: line.id,
    productId: line.productId,
    titleSnapshot: line.titleSnapshot,
    unitAmountMinor: line.unitAmountMinor,
    quantity: line.quantity,
    totalAmountMinor: line.totalAmountMinor,
    fulfillmentKind: fulfillmentKindSchema.catch('LICENSE_KEY').parse(
      line.fulfillmentKind,
    ),
    deliveredPayload: line.deliveredPayload,
  }));

  return {
    id: order.id,
    reference: order.reference,
    status: orderStatusSchema.catch('PENDING').parse(order.status),
    currency: currencySchema.catch('XTR').parse(order.currency),
    totalAmountMinor: order.totalAmountMinor,
    totalBaseRubMinor: order.totalBaseRubMinor,
    // `catch` is not available for a plain positive-int guard, and a zero or
    // negative rate would divide badly downstream. Rows created before the
    // column existed carry the default 1.
    rateRubMinorPerUnit:
      order.rateRubMinorPerUnit > 0 ? order.rateRubMinorPerUnit : 1,
    // `catch` rather than a strict parse: rows predating these columns carry
    // defaults, and an unreadable audit field must not make an order unreadable.
    rateSource: rateSourceSchema.catch('NONE').parse(order.rateSource),
    rateSide: rateSideSchema.catch(null).parse(order.rateSide),
    rateFetchedAt: order.rateFetchedAt
      ? order.rateFetchedAt.toISOString()
      : null,
    comment: order.comment,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    lines,
  };
}

/** Exported so the crypto payment service maps orders the same way. */
export { toApiOrder };

/**
 * The USDT rate to price this order at.
 *
 * Live from Rapira when enabled; the configured fallback otherwise. Imported
 * lazily so the rate module — and its network access — is only loaded by the path
 * that needs it, keeping Stars and card checkout free of it entirely.
 */
interface ResolvedRate {
  rateRubMinorPerUnit: number;
  source: 'RAPIRA' | 'CONFIG' | 'NONE';
  side: 'ask' | 'bid' | null;
  fetchedAt: Date | null;
}

async function resolveUsdtRate(): Promise<ResolvedRate> {
  if (!config.rapira.enabled) {
    return {
      rateRubMinorPerUnit: config.rates.usdtRubMinorPerUnit,
      source: 'CONFIG',
      side: null,
      fetchedAt: null,
    };
  }
  const { getUsdtRubRate } = await import('../payments/rapira-rates.js');
  const quote = await getUsdtRubRate();
  return {
    rateRubMinorPerUnit: quote.rateRubMinorPerUnit,
    source: quote.source,
    side: quote.side,
    fetchedAt: quote.fetchedAt,
  };
}

export interface CreatedOrder {
  order: Order;
  invoiceUrl: string | null;
  cryptoPayment: CryptoPayment | null;
  casheraPayment: CasheraPayment | null;
}

export async function createOrder(
  viewer: Viewer,
  input: CreateOrderInput,
): Promise<CreatedOrder> {
  // Merge duplicate product ids so "add twice" behaves like quantity 2.
  const quantityByProduct = new Map<string, number>();
  for (const item of input.items) {
    quantityByProduct.set(
      item.productId,
      (quantityByProduct.get(item.productId) ?? 0) + item.quantity,
    );
  }

  const productIds = [...quantityByProduct.keys()];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    // `_count` rather than loading the children: only the number matters here.
    include: { _count: { select: { variations: true } } },
  });

  if (products.length !== productIds.length) {
    const found = new Set(products.map((p) => p.id));
    const missing = productIds.filter((id) => !found.has(id));
    throw notFound(`Unknown product(s): ${missing.join(', ')}`);
  }

  // Every product must be priced in the same base currency. This is about the
  // *base*, not about how the buyer pays: RUB-priced items can be charged in
  // Stars or USDT, but a RUB item and a legacy XTR-priced item have no common
  // base and cannot share one total.
  const baseCurrencies = new Set(products.map((p) => p.currency));
  if (baseCurrencies.size > 1) {
    throw new AppError(
      'CURRENCY_MISMATCH',
      `An order cannot mix base currencies: ${[...baseCurrencies].join(', ')}.`,
    );
  }

  const baseCurrency = currencySchema.parse(products[0]!.currency);

  /**
   * Which currency the buyer is charged in.
   *
   * Products priced in RUB are converted to the requested payment currency.
   * Products still priced directly in XTR (rows predating the RUB model) are
   * charged as-is at a 1:1 rate — asking for USDT on those would need a rate
   * from a base we do not have, so it is refused rather than guessed.
   */
  // `?? 'XTR'` covers a direct service call that omits the field. The route
  // always has it, because zod defaults it — but a missing value here would
  // reach Prisma as `undefined` and fail on a NOT NULL column, so the default
  // belongs where the value is used rather than only where it is parsed.
  const requestedCurrency: PaymentCurrency = input.paymentCurrency ?? 'XTR';
  const chargeCurrency: PaymentCurrency =
    baseCurrency === 'RUB' ? requestedCurrency : 'XTR';

  if (baseCurrency !== 'RUB' && requestedCurrency !== 'XTR') {
    throw new AppError(
      'CURRENCY_MISMATCH',
      `"${products[0]!.title}" is priced in ${baseCurrency} and can only be paid with Stars.`,
    );
  }

  if (chargeCurrency === 'USDT' && !config.crypto.enabled) {
    throw new AppError(
      'CRYPTO_PAYMENTS_DISABLED',
      'Оплата USDT сейчас недоступна.',
    );
  }

  if (chargeCurrency === 'RUB' && !config.cashera.enabled) {
    throw new AppError(
      'CARD_PAYMENTS_DISABLED',
      'Оплата картой сейчас недоступна.',
    );
  }

  /**
   * The rate this order is priced at, resolved once and then snapshotted.
   *
   * For USDT that means asking the exchange now — and if no trustworthy rate is
   * available, refusing rather than quoting a guess. Roubles and Stars do not
   * consult it: RUB is the base currency (nothing converts), and Stars use a
   * configured rate.
   */
  const resolvedRate: ResolvedRate =
    baseCurrency === 'RUB'
      ? chargeCurrency === 'USDT'
        ? await resolveUsdtRate()
        : {
            rateRubMinorPerUnit: rateForCurrency(chargeCurrency, config.rates),
            // Stars come from configuration; roubles convert nothing at all.
            source: chargeCurrency === 'XTR' ? 'CONFIG' : 'NONE',
            side: null,
            fetchedAt: null,
          }
      : { rateRubMinorPerUnit: 1, source: 'NONE', side: null, fetchedAt: null };
  const rateRubMinorPerUnit = resolvedRate.rateRubMinorPerUnit;

  const linesToCreate = products.map((product) => {
    const quantity = quantityByProduct.get(product.id)!;

    if (!product.isActive) {
      throw new AppError(
        'PRODUCT_UNAVAILABLE',
        `"${product.title}" is no longer available.`,
      );
    }

    // A parent with variations is a grouping, not something with stock: its
    // license keys live on the children. Ordering it would create a PENDING
    // order that can never be fulfilled, so it is refused here rather than
    // discovered at delivery time. The client hides its buy button, but the
    // client is not what enforces this.
    if (product._count.variations > 0) {
      throw new AppError(
        'PRODUCT_UNAVAILABLE',
        `"${product.title}": выберите конкретный вариант товара.`,
      );
    }

    const kind = fulfillmentKindSchema.parse(product.fulfillmentKind);

    // The stored price is the club tier. A verified channel member pays it as
    // is; everyone else pays the standard price derived from it. `viewer` is the
    // server's own resolution of the caller, so this cannot be influenced from
    // the client — and the Mini App calls the same shared function, so the
    // invoice always matches the screen.
    const unitBaseRubMinor = effectiveUnitMinor(
      product.amountMinor,
      viewer.isSubscribedChannel,
    );

    /**
     * Convert per unit, then multiply — not the reverse.
     *
     * `unitAmountMinor × quantity` is what the order line stores and what the
     * invoice charges, so the rounding has to happen at the unit. Converting the
     * line total instead would leave the line's own numbers not multiplying out,
     * and Telegram rejects an invoice whose prices do not sum to the total.
     */
    /**
     * Priced with the rate that was actually resolved above, not `config.rates`.
     *
     * These must be the same number: the snapshot records what the buyer was
     * charged at, so pricing from one rate while recording another would make the
     * order's own audit trail a lie — and would quote a live-rate rail at a stale
     * configured rate.
     */
    const unitAmountMinor =
      baseCurrency === 'RUB'
        ? payableMinorForCurrency(unitBaseRubMinor, chargeCurrency, {
            ...config.rates,
            ...(chargeCurrency === 'USDT'
              ? { usdtRubMinorPerUnit: rateRubMinorPerUnit }
              : {}),
          })
        : unitBaseRubMinor;

    return {
      productId: product.id,
      titleSnapshot: product.title,
      unitAmountMinor,
      quantity,
      totalAmountMinor: unitAmountMinor * quantity,
      unitBaseRubMinor,
      fulfillmentKind: kind,
    };
  });

  /**
   * Verify license stock before charging.
   *
   * Unclaimed rows are the source of truth rather than a counter that can drift,
   * and keys currently held for another in-flight payment do not count as
   * available — see `reserveLicenseKeys` for why holds exist at all.
   */
  for (const line of linesToCreate) {
    if (line.fulfillmentKind !== 'LICENSE_KEY') continue;
    const available = await countAvailableKeys(line.productId);
    if (available < line.quantity) {
      throw new AppError(
        'OUT_OF_STOCK',
        `"${line.titleSnapshot}": only ${available} left, ${line.quantity} requested.`,
      );
    }
  }

  const totalAmountMinor = linesToCreate.reduce(
    (sum, line) => sum + line.totalAmountMinor,
    0,
  );
  const totalBaseRubMinor = linesToCreate.reduce(
    (sum, line) => sum + line.unitBaseRubMinor * line.quantity,
    0,
  );

  const order = await prisma.order.create({
    data: {
      reference: generateReference(),
      userId: viewer.id,
      status: 'PENDING',
      currency: chargeCurrency,
      totalAmountMinor,
      totalBaseRubMinor,
      rateRubMinorPerUnit,
      // The snapshot: what the rate was, where it came from, and when it was read.
      // Nothing downstream recomputes any of it.
      rateSource: resolvedRate.source,
      rateSide: resolvedRate.side,
      rateFetchedAt: resolvedRate.fetchedAt,
      comment: input.comment ?? null,
      invoicePayload: generateInvoicePayload(),
      lines: { create: linesToCreate },
    },
    include: { lines: { orderBy: { id: 'asc' } } },
  });

  // Free orders need no payment: deliver immediately.
  if (totalAmountMinor === 0) {
    const paid = await markOrderPaid({
      kind: 'telegram',
      invoicePayload: order.invoicePayload,
      telegramPaymentChargeId: null,
      providerPaymentChargeId: null,
    });
    return {
      order: paid ?? toApiOrder(order),
      invoiceUrl: null,
      cryptoPayment: null,
      casheraPayment: null,
    };
  }

  /**
   * On-chain orders get an intent instead of an invoice link.
   *
   * Created here rather than in a second client round trip so an order can never
   * exist in a state where it is payable in principle but has no address to pay
   * to — the buyer would see a total and nowhere to send it.
   */
  if (chargeCurrency === 'USDT') {
    const { createIntentForOrder } = await import('./crypto-payments.js');
    const cryptoPayment = await createIntentForOrder(order.id);
    return {
      order: toApiOrder(order),
      invoiceUrl: null,
      cryptoPayment,
      casheraPayment: null,
    };
  }

  /**
   * Card / SBP goes to an external gateway, which answers with a hosted page.
   *
   * Created here for the same reason as the on-chain intent: an order that is
   * payable in principle but has nowhere to pay is a dead end for the buyer.
   */
  if (chargeCurrency === 'RUB') {
    const { createPaymentForOrder } = await import('./cashera-payments.js');
    const casheraPayment = await createPaymentForOrder(order.id);
    return {
      order: toApiOrder(order),
      invoiceUrl: null,
      cryptoPayment: null,
      casheraPayment,
    };
  }

  let invoiceUrl: string | null = null;
  if (payments.enabled) {
    invoiceUrl = await payments.createInvoiceLink({
      title: order.lines.length === 1 ? order.lines[0]!.titleSnapshot : 'Order',
      description:
        order.lines.length === 1
          ? `${order.lines[0]!.titleSnapshot} × ${order.lines[0]!.quantity}`
          : order.lines
              .map((l) => `${l.titleSnapshot} × ${l.quantity}`)
              .join(', '),
      payload: order.invoicePayload,
      currency: chargeCurrency,
      lines: order.lines.map((line) => ({
        label: `${line.titleSnapshot} × ${line.quantity}`,
        amountMinor: line.totalAmountMinor,
      })),
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { invoiceUrl },
    });
  }

  return {
    order: toApiOrder({ ...order, invoiceUrl }),
    invoiceUrl,
    cryptoPayment: null,
    casheraPayment: null,
  };
}

/**
 * Ceiling on reservation attempts.
 *
 * Generous relative to any real cart (50 lines × 99 units is the contract's
 * maximum), so a legitimate large order still gets every key it asked for, while
 * a pathological loop still terminates.
 */
const RESERVE_MAX_ATTEMPTS = 200;

/**
 * Keys that a new checkout may count on.
 *
 * Excludes both claimed keys and keys currently held for someone else's in-flight
 * payment. An expired hold counts as available again, which is what makes the
 * expiry self-healing: no cleanup job has to run for stock to come back.
 */
export async function countAvailableKeys(
  productId: string,
  now = new Date(),
): Promise<number> {
  return prisma.licenseKey.count({
    where: {
      productId,
      claimedAt: null,
      OR: [{ reservedUntil: null }, { reservedUntil: { lt: now } }],
    },
  });
}

/**
 * Holds keys for an order line until `until`.
 *
 * Why holds exist: a Stars invoice settles in seconds, so the gap between the
 * stock check and the claim was small enough to accept — the loser simply got an
 * `OUT_OF_STOCK` error before paying anything. An on-chain payment takes minutes
 * and is irreversible, so the same race becomes: the buyer sends USDT, someone
 * else takes the last key, and the order lands in `FAILED` with money already
 * spent and no way to hand it back.
 *
 * The hold is advisory. It does not replace the conditional UPDATE in
 * `claimLicenseKey` — that is still what decides ownership, so overselling remains
 * impossible even if two holds somehow overlapped. This only stops a *later*
 * checkout from counting on a key that a *paying* buyer is waiting on.
 *
 * Best effort by design: it reserves what it can and reports the number. Fewer
 * than requested is not an error here, because the stock check already passed and
 * the claim will produce the authoritative answer at payment time.
 */
export async function reserveLicenseKeys(
  productId: string,
  orderLineId: string,
  quantity: number,
  until: Date,
  now = new Date(),
): Promise<number> {
  let reserved = 0;
  let needed = quantity;
  // Bounded, like the claim loop below. A lost race retries the slot, and without
  // a ceiling a row that keeps matching the filter but refusing the UPDATE — a
  // third party writing a past `reservedUntil` over and over — would spin here
  // forever, inside a request that is holding a checkout open.
  let attempts = 0;

  while (needed > 0 && attempts < RESERVE_MAX_ATTEMPTS) {
    attempts += 1;

    const candidate = await prisma.licenseKey.findFirst({
      where: {
        productId,
        claimedAt: null,
        OR: [{ reservedUntil: null }, { reservedUntil: { lt: now } }],
      },
      // Oldest first, matching `claimLicenseKey`, so a hold and its later claim
      // tend to land on the same row.
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!candidate) break;

    // Conditional, like the claim: two concurrent reservations cannot take the
    // same row, and the loser simply moves on to the next candidate.
    const held = await prisma.licenseKey.updateMany({
      where: {
        id: candidate.id,
        claimedAt: null,
        OR: [{ reservedUntil: null }, { reservedUntil: { lt: now } }],
      },
      data: { reservedUntil: until, reservedForLineId: orderLineId },
    });

    if (held.count === 1) {
      reserved += 1;
      needed -= 1;
    }
  }

  return reserved;
}

/** Drops the holds for an order, so an abandoned payment returns stock at once. */
export async function releaseLicenseKeys(orderId: string): Promise<number> {
  const lines = await prisma.orderLine.findMany({
    where: { orderId },
    select: { id: true },
  });
  if (lines.length === 0) return 0;

  const released = await prisma.licenseKey.updateMany({
    // Only unclaimed rows: a key already delivered must keep its link to the line.
    where: {
      reservedForLineId: { in: lines.map((line) => line.id) },
      claimedAt: null,
    },
    data: { reservedUntil: null, reservedForLineId: null },
  });
  return released.count;
}

/**
 * Claims one unclaimed license key for an order line.
 * Returns null when stock ran out between checkout and payment.
 */
async function claimLicenseKey(
  productId: string,
  orderLineId: string,
): Promise<string | null> {
  // Pick a candidate, then claim it with a guard on `claimedAt` so two
  // concurrent payments cannot take the same row.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const now = new Date();

    /**
     * This line's own hold first, then anything genuinely free.
     *
     * Order matters. A key held for THIS line was set aside precisely so this
     * payment could complete, so it must be reachable here — while a key held for
     * a *different* line belongs to another buyer whose funds may already be in
     * flight, and taking it would hand one key to two people's money.
     *
     * The hold is still only advisory: the conditional UPDATE below is what
     * decides ownership, so a stale or overlapping hold cannot cause an oversell.
     */
    const candidate =
      (await prisma.licenseKey.findFirst({
        where: { productId, claimedAt: null, reservedForLineId: orderLineId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, secret: true },
      })) ??
      (await prisma.licenseKey.findFirst({
        where: {
          productId,
          claimedAt: null,
          OR: [{ reservedUntil: null }, { reservedUntil: { lt: now } }],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, secret: true },
      }));
    if (!candidate) return null;

    const claimed = await prisma.licenseKey.updateMany({
      where: { id: candidate.id, claimedAt: null },
      data: {
        claimedAt: now,
        orderLineId,
        // The hold has served its purpose; clearing it keeps the reservation
        // columns meaningful only for payments still in flight.
        reservedUntil: null,
        reservedForLineId: null,
      },
    });

    if (claimed.count === 1) return candidate.secret;
    // Lost the race; try the next key.
  }
  return null;
}

/**
 * How a settled payment identifies its order.
 *
 * A discriminated union rather than a widening set of nullable Telegram fields:
 * Telegram finds the order by the payload it echoed back, an on-chain payment
 * knows the order id directly, and the two carry different receipts. Collapsing
 * them into one shape would mean every caller passing nulls for the half that
 * does not apply, and nothing would stop a crypto settlement from arriving with a
 * Telegram charge id attached.
 */
export type MarkPaidInput =
  | {
      kind: 'telegram';
      invoicePayload: string;
      telegramPaymentChargeId: string | null;
      providerPaymentChargeId: string | null;
    }
  | {
      kind: 'crypto';
      orderId: string;
    }
  | {
      // The external gateway's own receipt lives on `CasheraTransaction`, so
      // nothing extra needs carrying here — the order id is enough.
      kind: 'cashera';
      orderId: string;
    };

/**
 * Marks an order paid and delivers the goods.
 *
 * Safe to call repeatedly for the same payment: an already-paid order is returned
 * unchanged, and each line is skipped once it holds a delivered payload. Both
 * guards matter — the first stops a replayed webhook, the second stops a partial
 * delivery from re-claiming the keys it already handed over.
 */
export async function markOrderPaid(
  input: MarkPaidInput,
): Promise<Order | null> {
  const order = await prisma.order.findUnique({
    where:
      input.kind === 'telegram'
        ? { invoicePayload: input.invoicePayload }
        : { id: input.orderId },
    include: { lines: { orderBy: { id: 'asc' } } },
  });

  if (!order) return null;

  // Idempotency: never deliver twice.
  if (order.status === 'PAID') {
    return toApiOrder(order);
  }

  if (order.status === 'REFUNDED' || order.status === 'CANCELLED') {
    throw new AppError(
      'ORDER_NOT_PAYABLE',
      `Order ${order.reference} is ${order.status} and cannot be paid.`,
    );
  }

  let allDelivered = true;

  for (const line of order.lines) {
    if (line.deliveredPayload) continue;

    const kind = fulfillmentKindSchema.parse(line.fulfillmentKind);

    if (kind === 'LICENSE_KEY') {
      const secrets: string[] = [];
      for (let i = 0; i < line.quantity; i += 1) {
        const secret = await claimLicenseKey(line.productId, line.id);
        if (secret === null) break;
        secrets.push(secret);
      }

      if (secrets.length < line.quantity) {
        // Paid but cannot fulfil: flag for manual resolution instead of
        // silently short-changing the buyer.
        allDelivered = false;
        if (secrets.length > 0) {
          await prisma.orderLine.update({
            where: { id: line.id },
            data: { deliveredPayload: secrets.join('\n') },
          });
        }
        continue;
      }

      await prisma.orderLine.update({
        where: { id: line.id },
        data: { deliveredPayload: secrets.join('\n') },
      });
    } else {
      const product = await prisma.product.findUnique({
        where: { id: line.productId },
        select: { staticPayload: true },
      });
      const payload = product?.staticPayload ?? null;
      if (!payload) {
        allDelivered = false;
        continue;
      }
      await prisma.orderLine.update({
        where: { id: line.id },
        data: { deliveredPayload: payload },
      });
    }
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: allDelivered ? 'PAID' : 'FAILED',
      paidAt: new Date(),
      // Only Telegram carries these. An on-chain payment's receipt is its
      // transaction rows, which already point at the intent.
      ...(input.kind === 'telegram'
        ? {
            telegramPaymentChargeId: input.telegramPaymentChargeId,
            providerPaymentChargeId: input.providerPaymentChargeId,
          }
        : {}),
    },
  });

  const updated = await loadOrderRecord(order.id);
  return updated ? toApiOrder(updated) : null;
}

export async function getOrderForViewer(
  viewer: Viewer,
  orderId: string,
): Promise<Order> {
  const order = await loadOrderRecord(orderId);
  // Do not leak existence of other users' orders.
  if (!order || order.userId !== viewer.id) {
    throw notFound(`Order ${orderId} was not found.`);
  }
  return toApiOrder(order);
}

export async function listOrdersForViewer(viewer: Viewer): Promise<Order[]> {
  const orders = await prisma.order.findMany({
    where: { userId: viewer.id },
    include: { lines: { orderBy: { id: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return orders.map(toApiOrder);
}

export async function cancelOrder(
  viewer: Viewer,
  orderId: string,
): Promise<Order> {
  const order = await loadOrderRecord(orderId);
  if (!order || order.userId !== viewer.id) {
    throw notFound(`Order ${orderId} was not found.`);
  }
  if (order.status !== 'PENDING') {
    throw new AppError(
      'ORDER_NOT_PAYABLE',
      `Only pending orders can be cancelled; this one is ${order.status}.`,
    );
  }
  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'CANCELLED' },
  });
  const updated = await loadOrderRecord(order.id);
  return toApiOrder(updated!);
}

/** Looks up an order by the payload Telegram echoes back. */
export async function findOrderByPayload(payload: string) {
  return prisma.order.findUnique({
    where: { invoicePayload: payload },
    include: { lines: true, user: true },
  });
}
