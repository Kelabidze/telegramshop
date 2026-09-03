import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Permission, UserRole, Viewer } from '@shop/shared';
import { permissionSchema } from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, unauthorized } from '../errors.js';
import { InitDataError, verifyInitData } from '../telegram/init-data.js';

/**
 * Authentication and authorization for Mini App requests.
 *
 * The client sends the raw `initData` string in the `Authorization` header:
 *   Authorization: tma <initData>
 *
 * The server verifies the HMAC signature with the bot token. This is the only
 * trusted source of the caller's identity: the client can never assert its own
 * user id, otherwise anyone could order as someone else.
 *
 * Authorization then reads `role` and `permissions` from the database, both
 * loaded by the same query that refreshes the user record.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set only after `requireViewer`/`requireRole`/`requirePermission` succeeded. */
    viewer?: Viewer;
  }
  interface FastifyInstance {
    /** Rejects the request unless a valid Telegram viewer is present. */
    requireViewer: (request: FastifyRequest) => Promise<Viewer>;
    /** Rejects unless the viewer is an admin. Alias of `requireRole('ADMIN')`. */
    requireAdmin: (request: FastifyRequest) => Promise<Viewer>;
    /** Builds a pre-handler that rejects unless the viewer holds one of `roles`. */
    requireRole: (
      ...roles: UserRole[]
    ) => (request: FastifyRequest) => Promise<Viewer>;
    /** Builds a pre-handler that rejects unless the viewer holds `permission`. */
    requirePermission: (
      permission: Permission,
    ) => (request: FastifyRequest) => Promise<Viewer>;
  }
}

const AUTH_SCHEME = /^tma\s+(.+)$/i;

/**
 * Loaded alongside every user lookup: authorization must never run against a
 * stale permission list, so there is no caching layer here on purpose.
 */
const VIEWER_INCLUDE = {
  managerPermissions: {
    select: { permission: true },
    orderBy: { permission: 'asc' },
  },
} as const;

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
function devViewer(
  request: FastifyRequest,
): { telegramId: string; firstName: string } | null {
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

/** Shape returned by every user query in this module. */
interface UserRow {
  id: string;
  telegramId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  role: string;
  isAdmin: boolean;
  managerPermissions: Array<{ permission: string }>;
}

/**
 * Resolves the role that must be stored for this caller.
 *
 * ADMIN comes from ADMIN_TELEGRAM_IDS and from nowhere else, in both
 * directions: an id in the list is promoted, an id no longer in it is demoted.
 * Without the demotion half, removing someone from the config would leave a
 * persisted ADMIN row behind and the only way to revoke access would be editing
 * the database by hand — exactly the failure mode the config-driven design
 * exists to prevent.
 *
 * MANAGER is assigned in the database and left alone here; its powers come from
 * ManagerPermission rows, not from the config.
 */
function resolveRole(storedRole: string, isConfigAdmin: boolean): UserRole {
  if (isConfigAdmin) return 'ADMIN';
  return storedRole === 'MANAGER' ? 'MANAGER' : 'USER';
}

/** Creates or refreshes the local user record for a verified Telegram user. */
async function upsertUser(input: UpsertInput): Promise<Viewer> {
  const isConfigAdmin = config.adminTelegramIds.has(input.telegramId);
  const data = {
    firstName: input.firstName,
    lastName: input.lastName ?? null,
    username: input.username ?? null,
    languageCode: input.languageCode ?? null,
    isPremium: input.isPremium ?? false,
  };

  // The admin flag and role are both derived from config on every login, so
  // access is granted and revoked without touching the database. `role` is
  // written unconditionally rather than in a follow-up UPDATE: a second query
  // would double the cost of every admin request for no benefit.
  const user = await prisma.user.upsert({
    where: { telegramId: input.telegramId },
    update: { ...data, isAdmin: isConfigAdmin },
    create: { telegramId: input.telegramId, ...data, isAdmin: isConfigAdmin },
    include: VIEWER_INCLUDE,
  });

  const role = resolveRole(user.role, isConfigAdmin);
  if (user.role === role) return toViewer(user, role);

  // Persist the corrected role so anything reading the table directly (Studio,
  // reports, a future admin UI) sees the same truth the API enforces.
  const corrected = await prisma.user.update({
    where: { id: user.id },
    data: { role },
    include: VIEWER_INCLUDE,
  });
  return toViewer(corrected, role);
}

function toViewer(user: UserRow, role: UserRole): Viewer {
  return {
    id: user.id,
    telegramId: user.telegramId,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    languageCode: user.languageCode,
    role,
    // Rows are validated, not trusted: a permission removed from the code must
    // stop granting access even while its row still exists in the database.
    permissions: user.managerPermissions.flatMap(({ permission }) => {
      const parsed = permissionSchema.safeParse(permission);
      return parsed.success ? [parsed.data] : [];
    }),
    // Channel membership is not verified yet: the getChatMember check lands in
    // the next step. Reported as `false` from the server rather than assumed on
    // the client, so the flag has exactly one source and enabling the real
    // check changes how the value is computed, not where it comes from.
    isSubscribedChannel: false,
    isAdmin: role === 'ADMIN',
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

  app.decorate(
    'requireRole',
    (...roles: UserRole[]) =>
      async (request: FastifyRequest) => {
        const viewer = await resolveViewer(request);
        if (!roles.includes(viewer.role)) {
          throw new AppError('FORBIDDEN', 'Insufficient role.');
        }
        return viewer;
      },
  );

  app.decorate('requireAdmin', app.requireRole('ADMIN'));

  app.decorate('requirePermission', (permission: Permission) => {
    // Validated at registration, not per request: an unknown permission would
    // otherwise fail closed at runtime and be indistinguishable from a genuine
    // 403. Throwing here means the server refuses to start instead.
    const parsed = permissionSchema.safeParse(permission);
    if (!parsed.success) {
      throw new Error(
        `Unknown permission "${String(permission)}" in requirePermission(). ` +
          'Add it to permissionSchema in packages/shared/src/telegram.ts first.',
      );
    }
    const required = parsed.data;

    return async (request: FastifyRequest) => {
      const viewer = await resolveViewer(request);
      // ADMIN bypasses the check: otherwise every new permission would have to
      // be granted to administrators by hand, and adding one would break them.
      if (viewer.role === 'ADMIN') return viewer;
      // The role is checked too, not just the permission rows: demoting a
      // manager to USER must revoke access even if their ManagerPermission rows
      // were left behind.
      if (viewer.role !== 'MANAGER' || !viewer.permissions.includes(required)) {
        throw new AppError('FORBIDDEN', 'Required permission is missing.');
      }
      return viewer;
    };
  });
};

export const authPlugin = fp(plugin, {
  name: 'shop-auth',
  fastify: '5.x',
});
