import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Viewer } from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, unauthorized } from '../errors.js';
import { InitDataError, verifyInitData } from '../telegram/init-data.js';

/**
 * Authentication for Mini App requests.
 *
 * The client sends the raw `initData` string in the `Authorization` header:
 *   Authorization: tma <initData>
 *
 * The server verifies the HMAC signature with the bot token. This is the only
 * trusted source of the caller's identity: the client can never assert its own
 * user id, otherwise anyone could order as someone else.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set only after `requireViewer`/`optionalViewer` succeeded. */
    viewer?: Viewer;
  }
  interface FastifyInstance {
    /** Rejects the request unless a valid Telegram viewer is present. */
    requireViewer: (request: FastifyRequest) => Promise<Viewer>;
    /** Rejects unless the viewer is an admin. */
    requireAdmin: (request: FastifyRequest) => Promise<Viewer>;
  }
}

const AUTH_SCHEME = /^tma\s+(.+)$/i;

function extractInitData(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const match = AUTH_SCHEME.exec(header.trim());
    if (match?.[1]) return match[1];
  }
  // Fallback used by some clients / easier manual curl testing.
  const alt = request.headers['x-telegram-init-data'];
  if (typeof alt === 'string' && alt.length > 0) return alt;
  return null;
}

/**
 * Dev-only escape hatch so the app can be opened in a normal browser without
 * Telegram. Guarded by ALLOW_DEV_AUTH and disabled in production by config.ts.
 */
function devViewer(request: FastifyRequest): { telegramId: string; firstName: string } | null {
  if (!config.devAuthEnabled) return null;
  const raw = request.headers['x-dev-telegram-id'];
  const telegramId = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,20}$/.test(telegramId)) return null;
  const nameRaw = request.headers['x-dev-first-name'];
  const firstName =
    typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : 'Dev User';
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

/** Creates or refreshes the local user record for a verified Telegram user. */
async function upsertUser(input: UpsertInput): Promise<Viewer> {
  const isAdmin = config.adminTelegramIds.has(input.telegramId);
  const data = {
    firstName: input.firstName,
    lastName: input.lastName ?? null,
    username: input.username ?? null,
    languageCode: input.languageCode ?? null,
    isPremium: input.isPremium ?? false,
  };

  const user = await prisma.user.upsert({
    where: { telegramId: input.telegramId },
    // Admin flag is derived from config on every login so access can be
    // granted or revoked without touching the database.
    update: { ...data, isAdmin },
    create: { telegramId: input.telegramId, ...data, isAdmin },
  });

  return {
    id: user.id,
    telegramId: user.telegramId,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    languageCode: user.languageCode,
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
      request.log.warn(
        { telegramId: viewer.telegramId },
        'Using DEV auth bypass; never enable ALLOW_DEV_AUTH in production.',
      );
      return viewer;
    }
    throw unauthorized(
      'Missing initData. Open the app from Telegram, or send "Authorization: tma <initData>".',
    );
  }

  if (!config.telegram.hasBotToken) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Server is missing TELEGRAM_BOT_TOKEN and cannot verify initData.',
    );
  }

  let initData;
  try {
    initData = verifyInitData(raw, {
      botToken: config.telegram.botToken,
      maxAgeSeconds: config.initDataMaxAgeSeconds,
    });
  } catch (error) {
    if (error instanceof InitDataError) {
      request.log.warn({ reason: error.reason }, 'initData rejected');
      throw unauthorized(`initData is not valid (${error.reason}).`);
    }
    throw error;
  }

  const tgUser = initData.user;
  if (!tgUser) {
    // Happens when the app is launched from an inline context without a user.
    throw unauthorized('initData contains no user; cannot identify the caller.');
  }

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

/**
 * Wrapped in `fastify-plugin` so the decorators are registered on the root
 * instance. Without this, Fastify's encapsulation would hide `requireViewer`
 * from sibling plugins such as the route files.
 */
const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('viewer', undefined);

  app.decorate('requireViewer', async (request: FastifyRequest) =>
    resolveViewer(request),
  );

  app.decorate('requireAdmin', async (request: FastifyRequest) => {
    const viewer = await resolveViewer(request);
    if (!viewer.isAdmin) {
      throw new AppError('FORBIDDEN', 'Admin rights are required.');
    }
    return viewer;
  });
};

export const authPlugin = fp(plugin, {
  name: 'shop-auth',
  fastify: '5.x',
});
