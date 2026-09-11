import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, notFound, validationError } from '../errors.js';
import {
  cancelIntent,
  createIntentForOrder,
  getIntentByOrderId,
  reconcileIntent,
} from '../services/crypto-payments.js';

/**
 * On-chain payment endpoints, nested under the order they settle.
 *
 * Nested rather than a top-level `/crypto-payments/:id` because a payment has no
 * meaning apart from its order, and the ownership check is then the same one the
 * order routes already make: a caller who cannot see the order cannot see its
 * payment either.
 *
 * Ownership failures return 404, never 403, matching the order routes — the
 * existence of another buyer's order is not something to confirm.
 */

const idParamsSchema = z.object({ id: z.string().min(8).max(64) });

/** Asserts the order exists AND belongs to the caller, in one place. */
async function requireOwnedOrder(
  viewerId: string,
  orderId: string,
): Promise<{ id: string; currency: string; status: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, currency: true, status: true },
  });
  if (!order || order.userId !== viewerId) {
    throw notFound(`Order ${orderId} was not found.`);
  }
  return { id: order.id, currency: order.currency, status: order.status };
}

export const cryptoPaymentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Creates the payment, or returns the one this order already has.
   *
   * Idempotent so a reload cannot issue a second address: two addresses for one
   * order would split a payment in half, and neither half would ever reach the
   * expected total.
   *
   * Rate limited because each first call derives a key and writes a wallet row.
   */
  app.post(
    '/orders/:id/crypto-payment',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const viewer = await app.requireViewer(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw validationError('Invalid order id.', params.error.issues);
      }

      if (!config.crypto.enabled) {
        throw new AppError(
          'CRYPTO_PAYMENTS_DISABLED',
          'Оплата USDT сейчас недоступна.',
        );
      }

      const order = await requireOwnedOrder(viewer.id, params.data.id);
      if (order.currency !== 'USDT') {
        throw new AppError(
          'CURRENCY_MISMATCH',
          `Заказ оформлен в ${order.currency}, а не в USDT.`,
        );
      }

      const existing = await getIntentByOrderId(order.id);
      const payment = existing ?? (await createIntentForOrder(order.id));
      reply.code(existing ? 200 : 201);
      return { cryptoPayment: payment };
    },
  );

  /**
   * Current payment state, for the waiting screen to poll.
   *
   * Reconciles before answering so a buyer who is watching sees the settlement in
   * the same tick the monitor confirmed it, instead of waiting out another poll
   * interval. Reconciliation is a recompute from stored rows, so calling it on a
   * read is safe and cannot double-settle.
   */
  app.get('/orders/:id/crypto-payment', async (request) => {
    const viewer = await app.requireViewer(request);
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw validationError('Invalid order id.', params.error.issues);
    }

    const order = await requireOwnedOrder(viewer.id, params.data.id);
    const current = await getIntentByOrderId(order.id);
    if (!current) {
      throw notFound(`Order ${order.id} has no on-chain payment.`);
    }

    const refreshed = await reconcileIntent(current.id);
    return { cryptoPayment: refreshed ?? current };
  });

  /** Buyer abandons the payment. Refused once anything has arrived on chain. */
  app.post('/orders/:id/crypto-payment/cancel', async (request) => {
    const viewer = await app.requireViewer(request);
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw validationError('Invalid order id.', params.error.issues);
    }

    const order = await requireOwnedOrder(viewer.id, params.data.id);
    const current = await getIntentByOrderId(order.id);
    if (!current) {
      throw notFound(`Order ${order.id} has no on-chain payment.`);
    }

    const cancelled = await cancelIntent(current.id);
    return { cryptoPayment: cancelled ?? current };
  });
};
