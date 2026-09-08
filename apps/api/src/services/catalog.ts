import {
  type Category,
  type Country,
  type Product,
  type ProductDetail,
  type ProductListItem,
  type ProductSection,
  type ProductVariation,
  currencySchema,
  fulfillmentKindSchema,
  productSectionSchema,
} from '@shop/shared';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';

/**
 * Catalog reads.
 *
 * `stock` is exposed as the count of unclaimed license keys so the UI can show
 * "N left" and disable sold-out items. `staticPayload` is never exposed: it is
 * the product the buyer pays for.
 *
 * Variations are child products (`parentId`). Listings therefore return **parents
 * only** — otherwise one product with ten country options would fill the grid
 * with ten near-identical cards, which is the whole thing variations exist to
 * avoid. A parent carries the aggregate of its children: total stock and the
 * cheapest price.
 */

type ProductRow = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string;
  imageUrl: string | null;
  emoji: string | null;
  amountMinor: number;
  currency: string;
  compareAtMinor: number | null;
  fulfillmentKind: string;
  categoryId: string | null;
  isActive: boolean;
  section: string;
  parentId: string | null;
  countryId: string | null;
};

interface Aggregates {
  /** Sum of the children's stock, or the product's own when it has none. */
  stock: number | null;
  variationCount: number;
  minVariationAmountMinor: number | null;
}

function toProduct(row: ProductRow, aggregates: Aggregates): Product {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    imageUrl: row.imageUrl,
    emoji: row.emoji,
    amountMinor: row.amountMinor,
    currency: currencySchema.catch('XTR').parse(row.currency),
    compareAtMinor: row.compareAtMinor,
    fulfillmentKind: fulfillmentKindSchema
      .catch('LICENSE_KEY')
      .parse(row.fulfillmentKind),
    categoryId: row.categoryId,
    stock: aggregates.stock,
    isActive: row.isActive,
    section: productSectionSchema.catch('SHOP').parse(row.section),
    parentId: row.parentId,
    countryId: row.countryId,
    variationCount: aggregates.variationCount,
    minVariationAmountMinor: aggregates.minVariationAmountMinor,
  };
}

const PRODUCT_SELECT = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  description: true,
  imageUrl: true,
  emoji: true,
  amountMinor: true,
  currency: true,
  compareAtMinor: true,
  fulfillmentKind: true,
  categoryId: true,
  isActive: true,
  section: true,
  parentId: true,
  countryId: true,
} as const;

/** Unclaimed key counts for LICENSE_KEY products, in one grouped query. */
async function stockByProduct(
  productIds: string[],
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const grouped = await prisma.licenseKey.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds }, claimedAt: null },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.productId, g._count._all]));
}

export async function listCategories(): Promise<Category[]> {
  const rows = await prisma.category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    emoji: row.emoji,
    sortOrder: row.sortOrder,
  }));
}

/**
 * Countries for the «Всё для Абуза» carousel.
 *
 * Only active ones, and only those that actually have something to sell: an
 * empty country in the carousel is a filter that returns nothing, which reads as
 * a broken screen rather than as an honest "no stock".
 */
export async function listCountries(): Promise<Country[]> {
  const rows = await prisma.country.findMany({
    where: {
      isActive: true,
      products: { some: { isActive: true } },
    },
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    emoji: row.emoji,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }));
}

export interface ListProductsOptions {
  categorySlug?: string;
  search?: string;
  section?: ProductSection;
  /** Filters parents down to those having a variation in this country. */
  countrySlug?: string;
}

/**
 * Aggregates for a page of parent products, in two grouped queries.
 *
 * Per-product queries would be N+1 across a grid; these are two regardless of
 * how many products are on screen.
 */
async function aggregateVariations(
  parentIds: string[],
): Promise<Map<string, Aggregates>> {
  const result = new Map<string, Aggregates>();
  if (parentIds.length === 0) return result;

  const children = await prisma.product.findMany({
    where: { parentId: { in: parentIds }, isActive: true },
    select: {
      id: true,
      parentId: true,
      amountMinor: true,
      fulfillmentKind: true,
    },
  });
  if (children.length === 0) return result;

  const keyedChildIds = children
    .filter((child) => child.fulfillmentKind === 'LICENSE_KEY')
    .map((child) => child.id);
  const childStock = await stockByProduct(keyedChildIds);

  for (const child of children) {
    const parentId = child.parentId!;
    const current = result.get(parentId) ?? {
      stock: 0,
      variationCount: 0,
      minVariationAmountMinor: null,
    };

    current.variationCount += 1;
    current.minVariationAmountMinor =
      current.minVariationAmountMinor === null
        ? child.amountMinor
        : Math.min(current.minVariationAmountMinor, child.amountMinor);

    // A single unlimited variation makes the parent unlimited: the card must not
    // claim a finite number when one of the options never runs out.
    if (current.stock !== null) {
      if (child.fulfillmentKind === 'LICENSE_KEY') {
        current.stock += childStock.get(child.id) ?? 0;
      } else {
        current.stock = null;
      }
    }

    result.set(parentId, current);
  }

  return result;
}

export async function listProducts(
  options: ListProductsOptions = {},
): Promise<ProductListItem[]> {
  const rows = await prisma.product.findMany({
    where: {
      isActive: true,
      // Parents and standalone products only. Without this a product with ten
      // country options would occupy ten cells of the grid.
      parentId: null,
      section: options.section ?? 'SHOP',
      ...(options.categorySlug
        ? { category: { slug: options.categorySlug } }
        : {}),
      ...(options.search ? { title: { contains: options.search } } : {}),
      // Country lives on the variations, so the parent is matched through them.
      ...(options.countrySlug
        ? {
            variations: {
              some: { isActive: true, country: { slug: options.countrySlug } },
            },
          }
        : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    select: PRODUCT_SELECT,
    take: 200,
  });

  const ownStock = await stockByProduct(
    rows.filter((r) => r.fulfillmentKind === 'LICENSE_KEY').map((r) => r.id),
  );
  const variationAggregates = await aggregateVariations(rows.map((r) => r.id));

  return rows.map((row) => {
    const aggregate = variationAggregates.get(row.id);
    const aggregates: Aggregates = aggregate ?? {
      // No variations: the product's own stock is what matters.
      stock:
        row.fulfillmentKind === 'LICENSE_KEY' ? (ownStock.get(row.id) ?? 0) : null,
      variationCount: 0,
      minVariationAmountMinor: null,
    };

    const { description: _description, ...rest } = toProduct(row, aggregates);
    return rest;
  });
}

export async function getProductBySlug(slug: string): Promise<ProductDetail> {
  const row = await prisma.product.findUnique({
    where: { slug },
    select: PRODUCT_SELECT,
  });
  if (!row || !row.isActive) {
    throw notFound(`Product "${slug}" was not found.`);
  }

  const children = await prisma.product.findMany({
    where: { parentId: row.id, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    select: {
      id: true,
      slug: true,
      title: true,
      amountMinor: true,
      currency: true,
      compareAtMinor: true,
      fulfillmentKind: true,
      isActive: true,
      country: true,
    },
  });

  const keyedIds = [
    ...(row.fulfillmentKind === 'LICENSE_KEY' ? [row.id] : []),
    ...children.filter((c) => c.fulfillmentKind === 'LICENSE_KEY').map((c) => c.id),
  ];
  const stock = await stockByProduct(keyedIds);

  const variations: ProductVariation[] = children.map((child) => ({
    id: child.id,
    slug: child.slug,
    title: child.title,
    amountMinor: child.amountMinor,
    currency: currencySchema.catch('XTR').parse(child.currency),
    compareAtMinor: child.compareAtMinor,
    fulfillmentKind: fulfillmentKindSchema
      .catch('LICENSE_KEY')
      .parse(child.fulfillmentKind),
    stock:
      child.fulfillmentKind === 'LICENSE_KEY' ? (stock.get(child.id) ?? 0) : null,
    isActive: child.isActive,
    country: child.country
      ? {
          id: child.country.id,
          slug: child.country.slug,
          title: child.country.title,
          emoji: child.country.emoji,
          sortOrder: child.country.sortOrder,
          isActive: child.country.isActive,
        }
      : null,
  }));

  const aggregates: Aggregates =
    variations.length > 0
      ? {
          stock: variations.some((v) => v.stock === null)
            ? null
            : variations.reduce((sum, v) => sum + (v.stock ?? 0), 0),
          variationCount: variations.length,
          minVariationAmountMinor: Math.min(
            ...variations.map((v) => v.amountMinor),
          ),
        }
      : {
          stock:
            row.fulfillmentKind === 'LICENSE_KEY'
              ? (stock.get(row.id) ?? 0)
              : null,
          variationCount: 0,
          minVariationAmountMinor: null,
        };

  return { ...toProduct(row, aggregates), variations };
}
