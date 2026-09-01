import {
  type Manager,
  type ManagerInput,
  type Permission,
  permissionSchema,
} from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { conflict } from '../errors.js';

/**
 * Staff management.
 *
 * The hard rule this module must not break: **ADMIN cannot be granted here.**
 * `plugins/auth.ts` derives that role from `ADMIN_TELEGRAM_IDS` on every login
 * and resets anything else, so writing `role: 'ADMIN'` from an endpoint would
 * either be undone on the next request or, worse, create the illusion of a
 * second way to hand out full access. Administrators are appointed by editing
 * the environment and restarting the service — see `docs/ARCHITECTURE.md`.
 *
 * What this module does grant is MANAGER plus an explicit permission list.
 */

const STAFF_SELECT = {
  id: true,
  telegramId: true,
  firstName: true,
  username: true,
  role: true,
  createdAt: true,
  managerPermissions: {
    select: { permission: true },
    orderBy: { permission: 'asc' },
  },
} as const;

type StaffRow = {
  id: string;
  telegramId: string;
  firstName: string;
  username: string | null;
  role: string;
  createdAt: Date;
  managerPermissions: Array<{ permission: string }>;
};

/**
 * Unknown permission strings are dropped rather than surfaced, the same way
 * `plugins/auth.ts` treats them: a permission deleted from the code must stop
 * existing everywhere, not linger in an admin UI as an unrecognised row.
 */
function toManager(row: StaffRow): Manager {
  const permissions: Permission[] = row.managerPermissions.flatMap(
    ({ permission }) => {
      const parsed = permissionSchema.safeParse(permission);
      return parsed.success ? [parsed.data] : [];
    },
  );

  return {
    id: row.id,
    telegramId: row.telegramId,
    firstName: row.firstName,
    username: row.username,
    // Only ADMIN and MANAGER rows are listed, so the cast is exhaustive.
    role: row.role === 'ADMIN' ? 'ADMIN' : 'MANAGER',
    permissions,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Everyone with elevated access: managers from the database plus the
 * administrators named in the environment.
 *
 * Config admins are merged in explicitly because an id listed in
 * `ADMIN_TELEGRAM_IDS` may have no row yet — nobody appears in the User table
 * until their first login, and staff need to see the full picture regardless.
 */
export async function listManagers(): Promise<Manager[]> {
  const rows = await prisma.user.findMany({
    where: {
      OR: [
        { role: { in: ['ADMIN', 'MANAGER'] } },
        { telegramId: { in: [...config.adminTelegramIds] } },
      ],
    },
    select: STAFF_SELECT,
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    take: 200,
  });

  const known = new Set(rows.map((row) => row.telegramId));
  const listed: Manager[] = rows.map((row) => {
    // The config wins over the stored role, exactly as auth does it, so the
    // list never shows a stale MANAGER for someone who is actually an admin.
    const isConfigAdmin = config.adminTelegramIds.has(row.telegramId);
    return toManager(isConfigAdmin ? { ...row, role: 'ADMIN' } : row);
  });

  // Admins who have never opened the app: shown as placeholders so they can be
  // recognised, not silently missing.
  for (const telegramId of config.adminTelegramIds) {
    if (known.has(telegramId)) continue;
    listed.push({
      id: `pending:${telegramId}`,
      telegramId,
      firstName: 'Администратор (не заходил)',
      username: null,
      role: 'ADMIN',
      permissions: [],
      createdAt: new Date(0).toISOString(),
    });
  }

  return listed;
}

/**
 * Appoints a manager and replaces their permission set.
 *
 * Idempotent by design: calling it twice with the same input leaves the same
 * state, so an admin UI can simply submit the whole checkbox list every time
 * instead of computing a diff.
 */
export async function upsertManager(input: ManagerInput): Promise<Manager> {
  // Refuse rather than silently ignore: an admin's permissions are implicit,
  // and pretending to change them would be misleading. Demoting an admin means
  // editing ADMIN_TELEGRAM_IDS, which this endpoint cannot do.
  if (config.adminTelegramIds.has(input.telegramId)) {
    throw conflict(
      `${input.telegramId} is an administrator via ADMIN_TELEGRAM_IDS; ` +
        'their access is managed through the environment, not this endpoint.',
    );
  }

  const permissions = [...new Set(input.permissions)];

  // One transaction: a half-applied permission change would leave a manager
  // with rights the caller thought they had revoked.
  const row = await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { telegramId: input.telegramId },
      update: { role: 'MANAGER' },
      // No row yet: the person has not opened the app. The placeholder name is
      // overwritten with the real one from Telegram on their first login.
      create: {
        telegramId: input.telegramId,
        firstName: 'Менеджер',
        role: 'MANAGER',
      },
      select: { id: true },
    });

    // Replace, not merge: the input is the complete intended set.
    await tx.managerPermission.deleteMany({ where: { userId: user.id } });
    if (permissions.length > 0) {
      await tx.managerPermission.createMany({
        data: permissions.map((permission) => ({
          userId: user.id,
          permission,
        })),
      });
    }

    return tx.user.findUniqueOrThrow({
      where: { id: user.id },
      select: STAFF_SELECT,
    });
  });

  return toManager(row);
}

/**
 * Revokes manager rights: back to USER, permissions removed.
 *
 * Kept as a separate operation from `upsertManager` with an empty list. Both
 * end up harmless, but "no permissions" and "not staff" are different states,
 * and only the latter takes the row out of `listManagers`.
 */
export async function revokeManager(
  telegramId: string,
): Promise<{ telegramId: string; role: 'USER' }> {
  if (config.adminTelegramIds.has(telegramId)) {
    throw conflict(
      `${telegramId} is an administrator via ADMIN_TELEGRAM_IDS; ` +
        'remove the id from the environment instead.',
    );
  }

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { telegramId },
      select: { id: true },
    });
    // Nothing to do if they were never staff; revoking is idempotent.
    if (!user) return;
    await tx.managerPermission.deleteMany({ where: { userId: user.id } });
    await tx.user.update({
      where: { id: user.id },
      data: { role: 'USER' },
    });
  });

  return { telegramId, role: 'USER' };
}
