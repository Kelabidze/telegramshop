import type { FastifyPluginAsync } from 'fastify';

/**
 * Profile of the authenticated caller.
 *
 * Single endpoint on purpose: there used to be both `/api/me` and
 * `/api/users/me` returning the same thing under different key names, which is
 * how clients end up depending on whichever one they found first. `/api/me` is
 * the one that survived — it is what the Mini App already calls.
 */
export const userRoutes: FastifyPluginAsync = async (app) => {
  /** Also the cheapest way for the client to verify that auth works at all. */
  app.get('/me', async (request) => {
    const viewer = await app.requireViewer(request);
    return { viewer };
  });
};
