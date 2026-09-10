import {
  BANNER_MAX_VISIBLE,
  productSectionSchema,
  type Banner,
  type BannerInput,
  type BannerUpdate,
  type ProductSection,
} from '@shop/shared';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';

/**
 * Promo banners.
 *
 * Read side is public and unauthenticated, like the catalog: a storefront screen
 * shows its banners before anything is known about the viewer.
 *
 * A banner belongs to a section, and the read is always per section. There is no
 * "all active banners" query on purpose: a screen that pulled the whole table
 * and filtered client-side would show the catalog's promos above «Всё для
 * абуза» for as long as it took the filter to be written.
 */

const BANNER_SELECT = {
  id: true,
  title: true,
  subtitle: true,
  imageUrl: true,
  linkUrl: true,
  isActive: true,
  sortOrder: true,
  section: true,
} as const;

type BannerRow = {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  linkUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  section: string;
};

/**
 * `section` is a plain string in the database, so an unknown value has to resolve
 * to something. It falls back to `SHOP` rather than throwing: a banner is
 * decoration, and a bad row must not take the storefront down with it.
 */
function toBanner(row: BannerRow): Banner {
  return {
    ...row,
    section: productSectionSchema.catch('SHOP').parse(row.section),
  };
}

/** Active banners of one section, in display order, for the storefront. */
export async function listActiveBanners(
  section: ProductSection,
): Promise<Banner[]> {
  const rows = await prisma.banner.findMany({
    where: { isActive: true, section },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    take: BANNER_MAX_VISIBLE[section],
    select: BANNER_SELECT,
  });
  return rows.map(toBanner);
}

/** Every banner of every section, including hidden ones — for staff. */
export async function listAllBanners(): Promise<Banner[]> {
  const rows = await prisma.banner.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    select: BANNER_SELECT,
  });
  return rows.map(toBanner);
}

export async function createBanner(input: BannerInput): Promise<Banner> {
  const row = await prisma.banner.create({
    data: {
      title: input.title,
      subtitle: input.subtitle ?? null,
      imageUrl: input.imageUrl ?? null,
      linkUrl: input.linkUrl ?? null,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
      section: input.section,
    },
    select: BANNER_SELECT,
  });
  return toBanner(row);
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

  const row = await prisma.banner.update({
    where: { id },
    data: {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle ?? null }),
      ...(input.imageUrl === undefined ? {} : { imageUrl: input.imageUrl ?? null }),
      ...(input.linkUrl === undefined ? {} : { linkUrl: input.linkUrl ?? null }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      ...(input.section === undefined ? {} : { section: input.section }),
    },
    select: BANNER_SELECT,
  });
  return toBanner(row);
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
  const row = await prisma.banner.findUnique({
    where: { id },
    select: BANNER_SELECT,
  });
  if (!row) throw notFound(`Banner ${id} was not found.`);
  return toBanner(row);
}
