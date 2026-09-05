import type { Banner, BannerInput, BannerUpdate } from '@shop/shared';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';

/**
 * Promo banners.
 *
 * Read side is public and unauthenticated, like the catalog: the home screen
 * shows banners before anything is known about the viewer.
 */

const BANNER_SELECT = {
  id: true,
  title: true,
  subtitle: true,
  imageUrl: true,
  linkUrl: true,
  isActive: true,
  sortOrder: true,
} as const;

/**
 * How many banners the home screen may show.
 *
 * Capped in the read, not only in the UI: the strip is above the catalog, and a
 * careless tenth banner would push the products off the first screen entirely.
 */
const MAX_VISIBLE = 2;

/** Active banners in display order, for the home screen. */
export async function listActiveBanners(): Promise<Banner[]> {
  return prisma.banner.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    take: MAX_VISIBLE,
    select: BANNER_SELECT,
  });
}

/** Every banner, including hidden ones — for staff. */
export async function listAllBanners(): Promise<Banner[]> {
  return prisma.banner.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    select: BANNER_SELECT,
  });
}

export async function createBanner(input: BannerInput): Promise<Banner> {
  return prisma.banner.create({
    data: {
      title: input.title,
      subtitle: input.subtitle ?? null,
      imageUrl: input.imageUrl ?? null,
      linkUrl: input.linkUrl ?? null,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    },
    select: BANNER_SELECT,
  });
}

/**
 * Partial update: only the fields present in `input` are written.
 *
 * `undefined` means "not sent"; `null` is an explicit clear, which is how a
 * subtitle or a link gets removed. Collapsing the two would make it impossible
 * to turn a linked banner back into a decorative one.
 */
export async function updateBanner(
  id: string,
  input: BannerUpdate,
): Promise<Banner> {
  await requireBanner(id);

  return prisma.banner.update({
    where: { id },
    data: {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle ?? null }),
      ...(input.imageUrl === undefined ? {} : { imageUrl: input.imageUrl ?? null }),
      ...(input.linkUrl === undefined ? {} : { linkUrl: input.linkUrl ?? null }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    },
    select: BANNER_SELECT,
  });
}

/**
 * Deleted outright, unlike a product.
 *
 * Nothing references a banner — no orders, no keys, no audit trail — so there is
 * no reason to keep a hidden row around. Hiding is available through
 * `isActive: false` for whoever wants it back later.
 */
export async function deleteBanner(id: string): Promise<Banner> {
  const banner = await requireBanner(id);
  await prisma.banner.delete({ where: { id } });
  return banner;
}

async function requireBanner(id: string): Promise<Banner> {
  const banner = await prisma.banner.findUnique({
    where: { id },
    select: BANNER_SELECT,
  });
  if (!banner) throw notFound(`Banner ${id} was not found.`);
  return banner;
}
