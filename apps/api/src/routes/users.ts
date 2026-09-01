import type { FastifyPluginAsync } from 'fastify';

/** Authenticated user profile endpoints. */
export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/users/me', {
    preHandler: app.requireViewer,
  }, async (request) => ({
    user: await app.requireViewer(request),
  }));
};
