import type { FastifyPluginAsync } from 'fastify';
import {
  zoneNowCardSchema,
  zoneNowCardInputSchema,
  zoneNowCardUpdateSchema,
  type ZoneNowCard,
} from '@shop/shared';
import { prisma } from '../db.js';
import { AppError, validationError } from '../errors.js';

/**
 * Zone Now card endpoints.
 *
 * GET  /zone-now       — the active card, public
 * GET  /admin/zone-now — all cards, staff only
 * POST /admin/zone-now — create a card, staff only
 * PUT  /admin/zone-now/:id — update a card, staff only
 * DELETE /admin/zone-now/:id — delete a card, staff only
 */

export const zoneNowRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Public read: the active Zone Now card.
   *
   * Returns the first active card, sorted by `sortOrder`. Returns `null` when
   * none is active, so the storefront can hide the section entirely.
   */
  app.get('/zone-now', async () => {
    const card = await prisma.zoneNowCard.findFirst({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    if (!card) return null;

    return zoneNowCardSchema.parse({
      id: card.id,
      title: card.title,
      text: card.text,
      imageUrl: card.imageUrl,
      actionLabel: card.actionLabel,
      actionUrl: card.actionUrl,
      isActive: card.isActive,
      sortOrder: card.sortOrder,
    });
  });

  /**
   * Staff: list all cards.
   *
   * Returns every card, not just the active one, so the admin panel can manage
   * prepared content.
   */
  app.get(
    '/admin/zone-now',
    { preHandler: app.requireRole('ADMIN', 'MANAGER') },
    async () => {
      const cards = await prisma.zoneNowCard.findMany({
        orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }],
      });

      return cards.map(
        (card): ZoneNowCard =>
          zoneNowCardSchema.parse({
            id: card.id,
            title: card.title,
            text: card.text,
            imageUrl: card.imageUrl,
            actionLabel: card.actionLabel,
            actionUrl: card.actionUrl,
            isActive: card.isActive,
            sortOrder: card.sortOrder,
          }),
      );
    },
  );

  /**
   * Staff: create a Zone Now card.
   *
   * Enforces that only one card can be active at a time: if `isActive: true`
   * is requested and another card is already active, the old one is deactivated.
   */
  app.post(
    '/admin/zone-now',
    { preHandler: app.requireRole('ADMIN', 'MANAGER') },
    async (req) => {
      const input = zoneNowCardInputSchema.safeParse(req.body);
      if (!input.success) {
        throw validationError('Неверные данные карточки.', input.error.issues);
      }

      // Enforce single active card: deactivate others if this one is active.
      if (input.data.isActive) {
        await prisma.zoneNowCard.updateMany({
          where: { isActive: true },
          data: { isActive: false },
        });
      }

      const card = await prisma.zoneNowCard.create({
        data: {
          title: input.data.title,
          text: input.data.text,
          imageUrl: input.data.imageUrl ?? null,
          actionLabel: input.data.actionLabel ?? null,
          actionUrl: input.data.actionUrl ?? null,
          isActive: input.data.isActive,
          sortOrder: input.data.sortOrder,
        },
      });

      return zoneNowCardSchema.parse({
        id: card.id,
        title: card.title,
        text: card.text,
        imageUrl: card.imageUrl,
        actionLabel: card.actionLabel,
        actionUrl: card.actionUrl,
        isActive: card.isActive,
        sortOrder: card.sortOrder,
      });
    },
  );

  /**
   * Staff: update a Zone Now card.
   *
   * Every field is optional. Enforces single-active on `isActive: true`.
   */
  app.put<{ Params: { id: string } }>(
    '/admin/zone-now/:id',
    { preHandler: app.requireRole('ADMIN', 'MANAGER') },
    async (req) => {
      const input = zoneNowCardUpdateSchema.safeParse(req.body);
      if (!input.success) {
        throw validationError('Неверные данные обновления.', input.error.issues);
      }

      const existing = await prisma.zoneNowCard.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });

      if (!existing) {
        throw new AppError('ZONE_NOW_CARD_NOT_FOUND', 'Карточка не найдена.');
      }

      // If activating this card, deactivate all others.
      if (input.data.isActive === true) {
        await prisma.zoneNowCard.updateMany({
          where: { id: { not: req.params.id }, isActive: true },
          data: { isActive: false },
        });
      }

      const card = await prisma.zoneNowCard.update({
        where: { id: req.params.id },
        data: {
          ...(input.data.title !== undefined && { title: input.data.title }),
          ...(input.data.text !== undefined && { text: input.data.text }),
          ...(input.data.imageUrl !== undefined && {
            imageUrl: input.data.imageUrl ?? null,
          }),
          ...(input.data.actionLabel !== undefined && {
            actionLabel: input.data.actionLabel ?? null,
          }),
          ...(input.data.actionUrl !== undefined && {
            actionUrl: input.data.actionUrl ?? null,
          }),
          ...(input.data.isActive !== undefined && {
            isActive: input.data.isActive,
          }),
          ...(input.data.sortOrder !== undefined && {
            sortOrder: input.data.sortOrder,
          }),
        },
      });

      return zoneNowCardSchema.parse({
        id: card.id,
        title: card.title,
        text: card.text,
        imageUrl: card.imageUrl,
        actionLabel: card.actionLabel,
        actionUrl: card.actionUrl,
        isActive: card.isActive,
        sortOrder: card.sortOrder,
      });
    },
  );

  /**
   * Staff: delete a Zone Now card.
   */
  app.delete<{ Params: { id: string } }>(
    '/admin/zone-now/:id',
    { preHandler: app.requireRole('ADMIN', 'MANAGER') },
    async (req, reply) => {
      const existing = await prisma.zoneNowCard.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });

      if (!existing) {
        throw new AppError('ZONE_NOW_CARD_NOT_FOUND', 'Карточка не найдена.');
      }

      await prisma.zoneNowCard.delete({
        where: { id: req.params.id },
      });

      return reply.code(204).send();
    },
  );
};
