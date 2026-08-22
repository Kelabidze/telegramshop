import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createOrderInputSchema } from '@shop/shared';
import { validationError } from '../errors.js';
import {
  cancelOrder,
  createOrder,
  getOrderForViewer,
  listOrdersForViewer,
} from '../services/orders.js';

const idParamsSchema = z.object({ id: z.string().min(8).max(64) });

export const orderRoutes: FastifyPluginAsync = async (app) => {
  /** Current user. Also the cheapest way for the client to verify auth works. */
  app.get('/me', async (request) => {
    const viewer = await app.requireViewer(request);
    return { viewer };
  });

  app.get('/orders', async (request) => {
    const viewer = await app.requireViewer(request);
    return { orders: await listOrdersForViewer(viewer) };
  });

  app.get('/orders/:id', async (request) => {
    const viewer = await app.requireViewer(request);
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw validationError('Invalid order id.', params.error.issues);
    }
    return { order: await getOrderForViewer(viewer, params.data.id) };
  });

  /**
   * Creates an order and, when payments are enabled, a Telegram invoice link.
   * Rate limited: each call can hit the Telegram API.
   */
  app.post(
    '/orders',
    {
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const viewer = await app.requireViewer(request);
      const parsed = createOrderInputSchema.safeParse(request.body);
      if (!parsed.success) {
        throw validationError('Invalid order payload.', parsed.error.issues);
      }
      const result = await createOrder(viewer, parsed.data);
      reply.code(201);
      return result;
    },
  );

  app.post('/orders/:id/cancel', async (request) => {
    const viewer = await app.requireViewer(request);
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw validationError('Invalid order id.', params.error.issues);
    }
    return { order: await cancelOrder(viewer, params.data.id) };
  });
};
