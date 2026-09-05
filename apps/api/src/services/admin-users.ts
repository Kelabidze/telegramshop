import {
  type ShopUser,
  type ShopUserListQuery,
  permissionSchema,
  type Permission,
  type UserRole,
  userRoleSchema,
} from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';

/**
 * Shop-wide user list for staff holding MANAGE_MANAGERS.
 *
 * Broader than `listManagers`: appointing someone starts with finding them, and
 * they are usually a buyer, not already staff. Kept as its own function rather
 * than a flag on `listManagers`, because that one is "who has access" and this
 * one is "who exists" — mixing them would leak the buyer list to anyone who
 * only meant to see the staff roster.
 */

interface UserRow {
  id: string;
  telegramId: string;
  firstName: string;
  lastName: string | null;
  displayName: string | null;
  username: string | null;
  role: string;
  createdAt: Date;
  managerPermissions: Array<{ permission: string }>;
  _count: { orders: number };
}

function toShopUser(row: UserRow): ShopUser {
  const isConfigAdmin = config.adminTelegramIds.has(row.telegramId);
  const role: UserRole = isConfigAdmin
    ? 'ADMIN'
    : userRoleSchema.catch('USER').parse(row.role);

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
    lastName: row.lastName,
    displayName: row.displayName,
    username: row.username,
    role,
    // ADMIN's permissions are implicit; surfacing leftover rows would imply
    // they can be revoked one by one, which they cannot.
    permissions: role === 'MANAGER' ? permissions : [],
    createdAt: row.createdAt.toISOString(),
    orderCount: row._count.orders,
  };
}

export async function listShopUsers(
  query: ShopUserListQuery,
): Promise<ShopUser[]> {
  const rows = await prisma.user.findMany({
    where: {
      ...(query.role ? { role: query.role } : {}),
      ...(query.q
        ? {
            OR: [
              { telegramId: { contains: query.q } },
              { username: { contains: query.q } },
              { firstName: { contains: query.q } },
              { displayName: { contains: query.q } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      telegramId: true,
      firstName: true,
      lastName: true,
      displayName: true,
      username: true,
      role: true,
      createdAt: true,
      managerPermissions: {
        select: { permission: true },
        orderBy: { permission: 'asc' as const },
      },
      _count: { select: { orders: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
  });

  return rows.map(toShopUser);
}
