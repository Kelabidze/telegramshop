import {
  type Category,
  type Product,
  type ProductListItem,
  currencySchema,
  fulfillmentKindSchema,
} from '@shop/shared';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';

/**
 * Catalog reads.
 *
 * `stock` is exposed as the count of unclaimed license keys so the UI can show
 * "N left" and disable sold-out items. `staticPayload` is never exposed: it is
 * the product the buyer pays for.
 */

type ProductRow = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string;
  imageUrl: string | null;
  amountMinor: number;
  currency: string;
  compareAtMinor: number | null;
  fulfillmentKind: string;
  categoryId: string | null;
  isActive: boolean;
};

function toProduct(row: ProductRow, stock: number | null): Product {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    imageUrl: row.imageUrl,
    amountMinor: row.amountMinor,
    currency: currencySchema.catch('XTR').parse(row.currency),
    compareAtMinor: row.compareAtMinor,
    fulfillmentKind: fulfillmentKindSchema
      .catch('LICENSE_KEY')
      .parse(row.fulfillmentKind),
    categoryId: row.categoryId,
    stock,
    isActive: row.isActive,
  };
}

const PRODUCT_SELECT = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  description: true,
  imageUrl: true,
  amountMinor: true,
  currency: true,
  compareAtMinor: true,
  fulfillmentKind: true,
  categoryId: true,
  isActive: true,
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

export interface ListProductsOptions {
  categorySlug?: string;
  search?: string;
}

export async function listProducts(
  options: ListProductsOptions = {},
): Promise<ProductListItem[]> {
  const rows = await prisma.product.findMany({
    where: {
      isActive: true,
      ...(options.categorySlug
        ? { category: { slug: options.categorySlug } }
        : {}),
      ...(options.search
        ? { title: { contains: options.search } }
        : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    select: PRODUCT_SELECT,
    take: 200,
  });

  const keyed = rows.filter((r) => r.fulfillmentKind === 'LICENSE_KEY');
  const stock = await stockByProduct(keyed.map((r) => r.id));

  return rows.map((row) => {
    const { description: _description, ...rest } = toProduct(
      row,
      row.fulfillmentKind === 'LICENSE_KEY' ? (stock.get(row.id) ?? 0) : null,
    );
    return rest;
  });
}

export async function getProductBySlug(slug: string): Promise<Product> {
  const row = await prisma.product.findUnique({
    where: { slug },
    select: PRODUCT_SELECT,
  });
  if (!row || !row.isActive) {
    throw notFound(`Product "${slug}" was not found.`);
  }
  const stock =
    row.fulfillmentKind === 'LICENSE_KEY'
      ? await prisma.licenseKey.count({
          where: { productId: row.id, claimedAt: null },
        })
      : null;
  return toProduct(row, stock);
}
