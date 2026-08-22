import { randomBytes, randomUUID } from 'node:crypto';
import {
  type CreateOrderInput,
  type Currency,
  type Order,
  type OrderLine,
  type Viewer,
  currencySchema,
  fulfillmentKindSchema,
  orderStatusSchema,
} from '@shop/shared';
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
    comment: order.comment,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    lines,
  };
}

export interface CreatedOrder {
  order: Order;
  invoiceUrl: string | null;
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
  });

  if (products.length !== productIds.length) {
    const found = new Set(products.map((p) => p.id));
    const missing = productIds.filter((id) => !found.has(id));
    throw notFound(`Unknown product(s): ${missing.join(', ')}`);
  }

  const currencies = new Set(products.map((p) => p.currency));
  if (currencies.size > 1) {
    throw new AppError(
      'CURRENCY_MISMATCH',
      `An order cannot mix currencies: ${[...currencies].join(', ')}.`,
    );
  }

  const currency = currencySchema.parse(products[0]!.currency);

  const linesToCreate = products.map((product) => {
    const quantity = quantityByProduct.get(product.id)!;

    if (!product.isActive) {
      throw new AppError(
        'PRODUCT_UNAVAILABLE',
        `"${product.title}" is no longer available.`,
      );
    }

    const kind = fulfillmentKindSchema.parse(product.fulfillmentKind);

    return {
      productId: product.id,
      titleSnapshot: product.title,
      unitAmountMinor: product.amountMinor,
      quantity,
      totalAmountMinor: product.amountMinor * quantity,
      fulfillmentKind: kind,
    };
  });

  // Verify license stock before charging, using unclaimed rows as the source
  // of truth rather than a counter that can drift.
  for (const line of linesToCreate) {
    if (line.fulfillmentKind !== 'LICENSE_KEY') continue;
    const available = await prisma.licenseKey.count({
      where: { productId: line.productId, claimedAt: null },
    });
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

  const order = await prisma.order.create({
    data: {
      reference: generateReference(),
      userId: viewer.id,
      status: 'PENDING',
      currency,
      totalAmountMinor,
      comment: input.comment ?? null,
      invoicePayload: generateInvoicePayload(),
      lines: { create: linesToCreate },
    },
    include: { lines: { orderBy: { id: 'asc' } } },
  });

  // Free orders need no payment: deliver immediately.
  if (totalAmountMinor === 0) {
    const paid = await markOrderPaid({
      invoicePayload: order.invoicePayload,
      telegramPaymentChargeId: null,
      providerPaymentChargeId: null,
    });
    return { order: paid ?? toApiOrder(order), invoiceUrl: null };
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
      currency,
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

  return { order: toApiOrder({ ...order, invoiceUrl }), invoiceUrl };
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
    const candidate = await prisma.licenseKey.findFirst({
      where: { productId, claimedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, secret: true },
    });
    if (!candidate) return null;

    const claimed = await prisma.licenseKey.updateMany({
      where: { id: candidate.id, claimedAt: null },
      data: { claimedAt: new Date(), orderLineId },
    });

    if (claimed.count === 1) return candidate.secret;
    // Lost the race; try the next key.
  }
  return null;
}

export interface MarkPaidInput {
  invoicePayload: string;
  telegramPaymentChargeId: string | null;
  providerPaymentChargeId: string | null;
}

/**
 * Marks an order paid and delivers the goods.
 * Safe to call repeatedly with the same payload: already-paid orders are
 * returned unchanged.
 */
export async function markOrderPaid(
  input: MarkPaidInput,
): Promise<Order | null> {
  const order = await prisma.order.findUnique({
    where: { invoicePayload: input.invoicePayload },
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
      telegramPaymentChargeId: input.telegramPaymentChargeId,
      providerPaymentChargeId: input.providerPaymentChargeId,
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
