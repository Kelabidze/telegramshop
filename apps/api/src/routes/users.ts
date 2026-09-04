import type { FastifyPluginAsync } from 'fastify';
import { profileUpdateSchema } from '@shop/shared';
import { validationError } from '../errors.js';
import { updateDisplayName } from '../services/profile.js';

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

  /**
   * Rename yourself inside the shop.
   *
   * Acts on the *authenticated* viewer only: there is no id in the path or the
   * body, so this cannot be pointed at another account. The name is validated
   * by zod rather than by hand — an empty or 500-character name would otherwise
   * reach the header and the order snapshots.
   */
  app.patch('/me', async (request) => {
    const viewer = await app.requireViewer(request);

    const parsed = profileUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationError('Не удалось сохранить имя.', parsed.error.issues);
    }

    return { viewer: await updateDisplayName(viewer, parsed.data) };
  });
};
