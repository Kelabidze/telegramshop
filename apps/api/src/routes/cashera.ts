import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  casheraWebhookSchema,
  casheraWebhookEventSchema,
  casheraPaymentInputSchema,
  CASHERA_HANDLED_EVENT,
} from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, notFound, validationError } from '../errors.js';
import {
  authenticateWebhook,
  createPaymentForOrder,
  getPaymentByOrderId,
  handleWebhook,
  refreshFromGateway,
} from '../services/cashera-payments.js';

/**
 * Cashera routes: the buyer-facing payment endpoints and the gateway's webhook.
 *
 * The webhook is deliberately NOT under `/api`: it is not part of the Mini App's
 * contract, it authenticates with its own headers rather than a Telegram signature,
 * and it is registered without the API prefix so the auth plugin's expectations do
 * not apply to it.
 */

const idParamsSchema = z.object({ id: z.string().min(8).max(64) });

/** Asserts the order exists AND belongs to the caller. 404 either way. */
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

export const casheraRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Opens the Cashera payment, or returns the one this order already has.
   *
   * Rate limited: each first call reaches an external gateway.
   */
  app.post(
    '/orders/:id/cashera-payment',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const viewer = await app.requireViewer(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw validationError('Invalid order id.', params.error.issues);
      }

      const input = casheraPaymentInputSchema.safeParse(request.body ?? {});
      if (!input.success) {
        throw validationError('Invalid payment rail.', input.error.issues);
      }
      const rail = input.data.rail;

      if (!config.cashera.enabled) {
        throw new AppError(
          'CARD_PAYMENTS_DISABLED',
          'Оплата через платёжный шлюз сейчас недоступна.',
        );
      }

      const order = await requireOwnedOrder(viewer.id, params.data.id);
      if (order.currency !== 'RUB') {
        throw new AppError(
          'CURRENCY_MISMATCH',
          `Заказ оформлен в ${order.currency}, а не в RUB.`,
        );
      }

      const existing = await getPaymentByOrderId(order.id);
      /**
       * An existing payment is returned whatever rail was asked for.
       *
       * Cashera will not re-open one order on a second method — a different payload
       * under the same `external_id` is a 409 — and the buyer's rail choice is
       * therefore fixed at order creation. Reporting the payment that exists is the
       * honest answer; `createPaymentForOrder` raises the conflict if the rails
       * genuinely differ and no row is present yet.
       */
      const payment = existing ?? (await createPaymentForOrder(order.id, rail));
      reply.code(existing ? 200 : 201);
      return { casheraPayment: payment };
    },
  );

  /**
   * Current payment state, for the waiting screen to poll.
   *
   * Reads the local record. It does NOT ask the gateway on every poll — that would
   * turn one buyer watching a screen into a stream of upstream requests. Recovery
   * from a missing webhook is the explicit refresh below.
   */
  app.get('/orders/:id/cashera-payment', async (request) => {
    const viewer = await app.requireViewer(request);
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw validationError('Invalid order id.', params.error.issues);
    }

    const order = await requireOwnedOrder(viewer.id, params.data.id);
    const payment = await getPaymentByOrderId(order.id);
    if (!payment) throw notFound(`Order ${order.id} has no card payment.`);
    return { casheraPayment: payment };
  });

  /**
   * Asks the gateway directly and applies what it says.
   *
   * The recovery path when a webhook never arrived — which is also what the return
   * screen uses, because a buyer coming back from the hosted page is exactly the
   * moment the answer matters and the webhook may still be in flight.
   *
   * Rate limited harder than the poll: it costs an upstream call.
   */
  app.post(
    '/orders/:id/cashera-payment/refresh',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const viewer = await app.requireViewer(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw validationError('Invalid order id.', params.error.issues);
      }

      const order = await requireOwnedOrder(viewer.id, params.data.id);
      const refreshed = await refreshFromGateway(order.id);
      if (!refreshed) throw notFound(`Order ${order.id} has no card payment.`);
      return { casheraPayment: refreshed };
    },
  );
};

/**
 * The gateway's webhook, mounted without the `/api` prefix.
 *
 * Answers 200 for anything it has definitively dealt with — including events it
 * rejects on business grounds — because asking Cashera to retry an event that will
 * never be accepted only produces noise. 401 is reserved for a failed credential
 * check, and 400 for a body that is not a webhook at all.
 */
export const casheraWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/webhooks/cashera',
    {
      // Not rate limited: throttling a payment notification would drop money on
      // the floor. The credential check is the gate here.
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const headers = request.headers as Record<string, string | undefined>;

      /**
       * Credentials first, before the body is even looked at.
       *
       * Constant-time comparison inside `authenticateWebhook`. Nothing about the
       * failure is disclosed — not which header was wrong, not how long the
       * expected value is.
       */
      if (
        !authenticateWebhook({
          apiKey: headers['x-api-key'],
          secret: headers['x-secret'],
        })
      ) {
        // Logged without either header value.
        request.log.warn(
          { path: '/webhooks/cashera' },
          'Rejected an unauthenticated Cashera webhook',
        );
        return reply.code(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Invalid credentials.' },
        });
      }

      /**
       * Look at the event type before committing to a body shape.
       *
       * Cashera delivers several event types to one `callback_url` — payment,
       * payout and subscription status, plus a `webhook.test` ping from the
       * dashboard. Its documented rule is to answer `2xx` to anything we do not
       * handle: a `4xx` is treated as a configuration error and stops retries, so
       * rejecting `webhook.test` would make the merchant's own test button look
       * broken. Authentication has already happened, so acknowledging is safe.
       */
      const envelope = casheraWebhookEventSchema.safeParse(request.body);
      const event = envelope.success ? envelope.data.event : '';

      if (event !== CASHERA_HANDLED_EVENT) {
        request.log.info({ event: event || '<missing>' }, 'Ignored a Cashera event');
        return reply.code(200).send({ ok: true, accepted: false, ignored: true });
      }

      const parsed = casheraWebhookSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn(
          { issues: parsed.error.issues.slice(0, 5) },
          'Malformed Cashera webhook body',
        );
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'Malformed webhook body.' },
        });
      }

      const outcome = await handleWebhook(parsed.data);

      if (!outcome.handled) {
        /*
         * Rejected on business grounds: an amount that does not match, an unknown
         * reference, a uuid that belongs to another transaction. Recorded and
         * logged for a human, and answered 200 so the gateway stops resending
         * something that will never be accepted.
         */
        request.log.error(
          {
            reason: outcome.reason,
            uuid: parsed.data.transaction.uuid,
            externalId: parsed.data.transaction.external_id,
          },
          'Cashera webhook rejected',
        );
        return reply.code(200).send({ ok: true, accepted: false });
      }

      // A settled payment whose method differs from the rail we opened is accepted
      // but noted: the money arrived and was verified, so goods ship; the mismatch
      // is telemetry for whoever maintains the Cashera settings.
      if (outcome.warning) {
        request.log.warn({ detail: outcome.warning }, 'Cashera payment method mismatch');
      }

      if (outcome.duplicate) {
        request.log.info(
          { uuid: parsed.data.transaction.uuid, status: outcome.status },
          'Duplicate Cashera webhook ignored',
        );
      }

      return reply
        .code(200)
        .send({ ok: true, accepted: true, duplicate: outcome.duplicate });
    },
  );

  /**
   * Return pages for the hosted checkout.
   *
   * Navigation only. Landing here proves the buyer's browser followed a redirect
   * and nothing more — a URL anyone can open cannot be evidence of payment. The
   * order's state comes from the webhook, or from the explicit refresh above.
   */
  for (const [path, outcome] of [
    ['/pay/ok', 'ok'],
    ['/pay/fail', 'fail'],
  ] as const) {
    app.get(path, async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const orderId = query.order ?? '';
      // Straight back into the Mini App, which then asks the API what actually
      // happened rather than trusting this redirect.
      const target = config.publicAppUrl
        ? `${config.publicAppUrl}/?pay=${outcome}${orderId ? `&order=${encodeURIComponent(orderId)}` : ''}`
        : null;

      if (target) return reply.redirect(target, 302);

      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Оплата</title>` +
            `<p>${outcome === 'ok' ? 'Платёж отправлен. Проверяем оплату…' : 'Платёж не завершён.'}</p>` +
            `<p>Вернитесь в Telegram, чтобы увидеть статус заказа.</p>`,
        );
    });
  }
};
