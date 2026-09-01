import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { UserRole, Viewer } from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, unauthorized } from '../errors.js';
import { InitDataError, verifyInitData } from '../telegram/init-data.js';

/** Authentication uses only Telegram-signed initData to identify the caller. */
declare module 'fastify' {
  interface FastifyRequest {
    viewer?: Viewer;
  }
  interface FastifyInstance {
    requireViewer: (request: FastifyRequest) => Promise<Viewer>;
    requireAdmin: (request: FastifyRequest) => Promise<Viewer>;
    requireRole: (...roles: UserRole[]) => (request: FastifyRequest) => Promise<Viewer>;
    requirePermission: (permission: string) => (request: FastifyRequest) => Promise<Viewer>;
  }
}

const AUTH_SCHEME = /^tma\s+(.+)$/i;

type DevViewer = { telegramId: string; firstName: string };

function extractInitData(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const match = AUTH_SCHEME.exec(header.trim());
    if (match?.[1]) return match[1];
  }
  const alt = request.headers['x-telegram-init-data'];
  return typeof alt === 'string' && alt.length > 0 ? alt : null;
}

function devViewer(request: FastifyRequest): DevViewer | null {
  if (!config.devAuthEnabled) return null;
  const raw = request.headers['x-dev-telegram-id'];
  const telegramId = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,20}$/.test(telegramId)) return null;
  const nameRaw = request.headers['x-dev-first-name'];
  const firstName = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : 'Dev User';
  return { telegramId, firstName };
}

interface UpsertInput {
  telegramId: string;
  firstName: string;
  lastName?: string | null;
  username?: string | null;
  languageCode?: string | null;
  isPremium?: boolean;
}

async function upsertUser(input: UpsertInput): Promise<Viewer> {
  const configAdmin = config.adminTelegramIds.has(input.telegramId);
  const data = {
    firstName: input.firstName,
    lastName: input.lastName ?? null,
    username: input.username ?? null,
    languageCode: input.languageCode ?? null,
    isPremium: input.isPremium ?? false,
  };

  const user = await prisma.user.upsert({
    where: { telegramId: input.telegramId },
    update: { ...data, isAdmin: configAdmin },
    create: { telegramId: input.telegramId, ...data, isAdmin: configAdmin },
    include: { managerPermissions: { select: { permission: true }, orderBy: { permission: 'asc' } } },
  });

  // Config identifies bootstrap administrators; persisted role remains the RBAC source.
  if (configAdmin && user.role !== 'ADMIN') {
    const promoted = await prisma.user.update({
      where: { id: user.id },
      data: { role: 'ADMIN' },
      include: { managerPermissions: { select: { permission: true }, orderBy: { permission: 'asc' } } },
    });
    return toViewer(promoted);
  }
  return toViewer(user);
}

function toViewer(user: {
  id: string;
  telegramId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  role: string;
  isAdmin: boolean;
  managerPermissions: Array<{ permission: string }>;
}): Viewer {
  const role: UserRole = user.role === 'ADMIN' || user.role === 'MANAGER' ? user.role : 'USER';
  return {
    id: user.id,
    telegramId: user.telegramId,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    languageCode: user.languageCode,
    role,
    permissions: user.managerPermissions.map(({ permission }) => permission),
    isAdmin: user.isAdmin,
  };
}

async function resolveViewer(request: FastifyRequest): Promise<Viewer> {
  if (request.viewer) return request.viewer;
  const raw = extractInitData(request);
  if (!raw) {
    const dev = devViewer(request);
    if (dev) {
      const viewer = await upsertUser(dev);
      request.viewer = viewer;
      request.log.warn({ telegramId: viewer.telegramId }, 'Using DEV auth bypass; never enable in production.');
      return viewer;
    }
    throw unauthorized('Missing initData. Open the app from Telegram, or send "Authorization: tma <initData>".');
  }
  if (!config.telegram.hasBotToken) {
    throw new AppError('INTERNAL_ERROR', 'Server is missing TELEGRAM_BOT_TOKEN and cannot verify initData.');
  }

  let initData;
  try {
    initData = verifyInitData(raw, { botToken: config.telegram.botToken, maxAgeSeconds: config.initDataMaxAgeSeconds });
  } catch (error) {
    if (error instanceof InitDataError) {
      request.log.warn({ reason: error.reason }, 'initData rejected');
      throw unauthorized(`initData is not valid (${error.reason}).`);
    }
    throw error;
  }
  const tgUser = initData.user;
  if (!tgUser) throw unauthorized('initData contains no user; cannot identify the caller.');

  const viewer = await upsertUser({
    telegramId: String(tgUser.id),
    firstName: tgUser.first_name,
    lastName: tgUser.last_name ?? null,
    username: tgUser.username ?? null,
    languageCode: tgUser.language_code ?? null,
    isPremium: tgUser.is_premium === true,
  });
  request.viewer = viewer;
  return viewer;
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('viewer', undefined);
  app.decorate('requireViewer', (request: FastifyRequest) => resolveViewer(request));
  app.decorate('requireRole', (...roles: UserRole[]) => async (request: FastifyRequest) => {
    const viewer = await resolveViewer(request);
    if (!roles.includes(viewer.role)) throw new AppError('FORBIDDEN', 'Insufficient role.');
    return viewer;
  });
  app.decorate('requireAdmin', app.requireRole('ADMIN'));
  app.decorate('requirePermission', (permission: string) => async (request: FastifyRequest) => {
    const viewer = await resolveViewer(request);
    if (viewer.role !== 'ADMIN' && (viewer.role !== 'MANAGER' || !viewer.permissions.includes(permission))) {
      throw new AppError('FORBIDDEN', 'Required permission is missing.');
    }
    return viewer;
  });
};

export const authPlugin = fp(plugin, { name: 'shop-auth', fastify: '5.x' });

