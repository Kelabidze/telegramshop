import {
  type Order,
  type OrderCustomer,
  type OrderListQuery,
  currencySchema,
  fulfillmentKindSchema,
  orderStatusSchema,
} from '@shop/shared';
import { prisma } from '../db.js';

/**
 * Global order reads for staff holding VIEW_ORDERS.
 *
 * Deliberately separate from `listOrdersForViewer` in `services/orders.ts`:
 * that function is scoped to the caller and its `where: { userId }` is the
 * reason one buyer cannot read another's orders. Mixing "all orders" into it
 * with an optional flag would put that invariant one wrong argument away from
 * being disabled.
 */

/** A staff-facing order: the buyer's own view plus who placed it. */
export interface StaffOrder extends Order {
  customer: OrderCustomer;
}

/**
 * `deliveredPayload` is included on purpose. Resolving a FAILED delivery means
 * seeing which key the buyer did or did not receive, and VIEW_ORDERS is exactly
 * the permission that authorizes it.
 */
export async function listAllOrders(
  query: OrderListQuery,
): Promise<StaffOrder[]> {
  const rows = await prisma.order.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      // Reference is the code a customer quotes in support requests.
      ...(query.q ? { reference: { contains: query.q.toUpperCase() } } : {}),
    },
    include: {
      lines: { orderBy: { id: 'asc' } },
      user: {
        select: {
          id: true,
          telegramId: true,
          firstName: true,
          username: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
  });

  return rows.map((order) => ({
    id: order.id,
    reference: order.reference,
    status: orderStatusSchema.catch('PENDING').parse(order.status),
    currency: currencySchema.catch('XTR').parse(order.currency),
    totalAmountMinor: order.totalAmountMinor,
    comment: order.comment,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    lines: order.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      titleSnapshot: line.titleSnapshot,
      unitAmountMinor: line.unitAmountMinor,
      quantity: line.quantity,
      totalAmountMinor: line.totalAmountMinor,
      fulfillmentKind: fulfillmentKindSchema
        .catch('LICENSE_KEY')
        .parse(line.fulfillmentKind),
      deliveredPayload: line.deliveredPayload,
    })),
    customer: {
      id: order.user.id,
      telegramId: order.user.telegramId,
      firstName: order.user.firstName,
      username: order.user.username,
    },
  }));
}
