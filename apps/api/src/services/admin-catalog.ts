import {
  type Category,
  type CategoryInput,
  type CategoryUpdate,
  type Country,
  type CountryInput,
  type CountryUpdate,
  type Product,
  type ProductInput,
  type ProductUpdate,
  currencySchema,
  fulfillmentKindSchema,
  productSectionSchema,
} from '@shop/shared';
import { prisma } from '../db.js';
import { AppError, conflict, notFound, validationError } from '../errors.js';

/**
 * Catalog management (staff writes).
 *
 * The read side is `services/catalog.ts`; the rules it enforces still hold here
 * — money as integers, stock as LicenseKey rows, `staticPayload` never returned.
 * What is specific to writes: a duplicate slug must come back as CONFLICT
 * rather than leaking a Prisma error, and a partial update must touch only the
 * fields the caller actually sent.
 */

function toCategory(row: {
  id: string;
  slug: string;
  title: string;
  emoji: string | null;
  sortOrder: number;
}): Category {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    emoji: row.emoji,
    sortOrder: row.sortOrder,
  };
}

/**
 * P2002 is Prisma's unique-constraint violation. In this module the only unique
 * columns a caller can collide with are `slug` on Category and Product, so the
 * mapping to CONFLICT is unambiguous. Anything else propagates as an unexpected
 * error, which the server turns into INTERNAL_ERROR without leaking details.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Drops keys that were not sent, so an absent field means "leave as is".
 *
 * `undefined` is absence; `null` is an explicit "clear this column" and must be
 * preserved — that is how a subtitle is removed or a product is detached from
 * its category.
 */
function definedFields<T extends object>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

// ---- categories ------------------------------------------------------------

export async function createCategory(input: CategoryInput): Promise<Category> {
  try {
    const row = await prisma.category.create({
      data: {
        slug: input.slug,
        title: input.title,
        emoji: input.emoji ?? null,
        sortOrder: input.sortOrder,
      },
    });
    return toCategory(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(`Category slug "${input.slug}" is already in use.`);
    }
    throw error;
  }
}

export async function updateCategory(
  id: string,
  input: CategoryUpdate,
): Promise<Category> {
  const data = definedFields(input);
  try {
    const row = await prisma.category.update({ where: { id }, data });
    return toCategory(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(`Category slug "${input.slug}" is already in use.`);
    }
    // P2025: the row does not exist. Checking first would be a second query and
    // still racy, so the failure is translated instead.
    if (isMissingRecord(error)) {
      throw notFound(`Category ${id} was not found.`);
    }
    throw error;
  }
}

function isMissingRecord(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2025'
  );
}

/**
 * Products are not deleted with their category: `onDelete: SetNull` on the
 * relation detaches them, so the catalog keeps working and items simply lose
 * their grouping. Deleting the products instead would break existing orders,
 * which reference them with `onDelete: Restrict`.
 */
export async function deleteCategory(id: string): Promise<Category> {
  try {
    const row = await prisma.category.delete({ where: { id } });
    return toCategory(row);
  } catch (error) {
    if (isMissingRecord(error)) {
      throw notFound(`Category ${id} was not found.`);
    }
    throw error;
  }
}

// ---- products --------------------------------------------------------------

/**
 * Adds license keys to a product's stock.
 *
 * Duplicates are filtered out beforehand instead of relying on
 * `createMany({ skipDuplicates })`: that option is not supported by the SQLite
 * connector, and without the filter a single repeated key would fail the whole
 * batch on the `(productId, secret)` unique index. Re-uploading the same key
 * file therefore adds nothing rather than erroring, which is what someone
 * pasting a list twice expects.
 *
 * A concurrent upload of the same key can still lose the race and throw; that
 * is acceptable for a staff-only operation and preferable to inserting stock
 * twice.
 */
async function addLicenseKeys(
  productId: string,
  keys: readonly string[] | undefined,
): Promise<number> {
  if (!keys || keys.length === 0) return 0;
  const requested = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  if (requested.length === 0) return 0;

  const existing = await prisma.licenseKey.findMany({
    where: { productId, secret: { in: requested } },
    select: { secret: true },
  });
  const known = new Set(existing.map((row) => row.secret));
  const fresh = requested.filter((secret) => !known.has(secret));
  if (fresh.length === 0) return 0;

  const result = await prisma.licenseKey.createMany({
    data: fresh.map((secret) => ({ productId, secret })),
  });
  return result.count;
}

export interface ProductWriteResult {
  id: string;
  /** How many license keys were actually added, after de-duplication. */
  keysAdded: number;
}

export async function createProduct(
  input: ProductInput,
): Promise<ProductWriteResult> {
  const { licenseKeys, ...fields } = input;
  try {
    const row = await prisma.product.create({
      data: {
        slug: fields.slug,
        title: fields.title,
        subtitle: fields.subtitle ?? null,
        description: fields.description,
        imageUrl: fields.imageUrl ?? null,
        emoji: fields.emoji ?? null,
        amountMinor: fields.amountMinor,
        currency: fields.currency,
        compareAtMinor: fields.compareAtMinor ?? null,
        fulfillmentKind: fields.fulfillmentKind,
        staticPayload: fields.staticPayload ?? null,
        categoryId: fields.categoryId ?? null,
        section: fields.section,
        parentId: fields.parentId ?? null,
        countryId: fields.countryId ?? null,
        isActive: fields.isActive,
        sortOrder: fields.sortOrder,
      },
    });
    const keysAdded = await addLicenseKeys(row.id, licenseKeys);
    return { id: row.id, keysAdded };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The clash is often with a *hidden* product: "delete" deactivates rather
      // than removes, because an ordered product has to stay readable. Staff
      // recreating a product they just deleted would otherwise get a bare conflict
      // about a slug they cannot see anywhere in the catalogue.
      throw await slugConflict(input.slug);
    }
    // A categoryId pointing at nothing violates the foreign key.
    if (isForeignKeyViolation(error)) {
      throw notFound(`Category ${String(input.categoryId)} was not found.`);
    }
    throw error;
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2003'
  );
}

/**
 * Explains a slug clash, naming the deactivated product when that is the cause.
 *
 * Deletion here is deactivation — `OrderLine.product` is `onDelete: Restrict`, so a
 * product that has ever been ordered cannot be removed, and should not be. The slug
 * stays taken, which is invisible from the catalogue: staff who delete a product and
 * recreate it with the same slug hit a conflict about something they can no longer
 * see. This says which product holds it and what to do.
 */
async function slugConflict(slug: string | undefined): Promise<AppError> {
  if (!slug) return conflict('Product slug is already in use.');

  const existing = await prisma.product.findUnique({
    where: { slug },
    select: { title: true, isActive: true },
  });

  if (existing && !existing.isActive) {
    return conflict(
      `Slug "${slug}" belongs to the hidden product "${existing.title}". ` +
        'Deleting a product only hides it, so old orders stay readable, and the slug ' +
        'stays taken. Edit that product and re-enable it, or use a different slug.',
    );
  }

  return conflict(`Product slug "${slug}" is already in use.`);
}

export async function updateProduct(
  id: string,
  input: ProductUpdate,
): Promise<ProductWriteResult> {
  const { licenseKeys, ...fields } = input;
  const data = definedFields(fields);

  // Repricing a legacy Stars-priced product needs an explicit currency.
  //
  // The stored integer means different things per currency: on a RUB product it is
  // kopecks, on a legacy XTR one it is whole Stars. Staff typing "1290" into the
  // price field is thinking in roubles, but on an XTR row that becomes 1290 Stars —
  // roughly 1677 ₽, billed silently. The admin form does not send `currency` on
  // update, so nothing else would catch it.
  //
  // Refusing is the only safe answer: this cannot be guessed, and picking either
  // reading would misprice real money. Sending `currency` alongside the amount is
  // the deliberate conversion, and `migrate-product-currency` does it in bulk.
  if (data.amountMinor !== undefined && data.currency === undefined) {
    const existing = await prisma.product.findUnique({
      where: { id },
      select: { currency: true, title: true },
    });
    if (existing && existing.currency !== 'RUB') {
      throw validationError(
        `"${existing.title}" is still priced in ${existing.currency}, where the amount means whole Stars rather than kopecks. ` +
          'Send `currency` together with `amountMinor` to state which unit the new price is in.',
        { currency: `product is priced in ${existing.currency}` },
      );
    }
  }

  try {
    // An update with no fields is still valid: the caller may only be adding
    // keys. Prisma accepts an empty `data`, so this needs no special case.
    await prisma.product.update({ where: { id }, data });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw await slugConflict(input.slug);
    }
    if (isMissingRecord(error)) {
      throw notFound(`Product ${id} was not found.`);
    }
    if (isForeignKeyViolation(error)) {
      throw notFound(`Category ${String(input.categoryId)} was not found.`);
    }
    throw error;
  }

  const keysAdded = await addLicenseKeys(id, licenseKeys);
  return { id, keysAdded };
}

/**
 * Deactivation, not deletion.
 *
 * `OrderLine.product` uses `onDelete: Restrict`, so a product that has ever
 * been ordered cannot be removed at all — and should not be: orders must stay
 * readable. Setting `isActive = false` takes it out of the public catalog,
 * which is what "delete" means for a shop.
 */
export async function deactivateProduct(
  id: string,
): Promise<{ id: string; isActive: boolean }> {
  try {
    const row = await prisma.product.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, isActive: true },
    });
    return row;
  } catch (error) {
    if (isMissingRecord(error)) {
      throw notFound(`Product ${id} was not found.`);
    }
    throw error;
  }
}

const STAFF_PRODUCT_SELECT = {
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

/**
 * Every product, including hidden ones, for the staff catalog.
 *
 * Deliberately not a flag on `listProducts`: that function's `where: { isActive }`
 * is the reason a deactivated item disappears from the shop, and mixing "show
 * all" into it would put that invariant one argument away from being disabled.
 *
 * `staticPayload` is not selected. MANAGE_KEYS authorizes editing the product,
 * not reading every FILE/LINK secret in a list.
 */
export async function listAllProducts(): Promise<Product[]> {
  const rows = await prisma.product.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    select: {
      ...STAFF_PRODUCT_SELECT,
      // Staff see variations as rows of their own — unlike the storefront, where
      // a parent stands in for them — so the count is what marks a parent.
      _count: { select: { variations: true } },
      variations: {
        where: { isActive: true },
        select: { amountMinor: true },
      },
    },
    take: 500,
  });

  const keyed = rows.filter((r) => r.fulfillmentKind === 'LICENSE_KEY');
  const stock = await staffStockByProduct(keyed.map((r) => r.id));

  return rows.map((row) => ({
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
    stock:
      row.fulfillmentKind === 'LICENSE_KEY' ? (stock.get(row.id) ?? 0) : null,
    isActive: row.isActive,
    section: productSectionSchema.catch('SHOP').parse(row.section),
    parentId: row.parentId,
    countryId: row.countryId,
    variationCount: row._count.variations,
    minVariationAmountMinor:
      row.variations.length > 0
        ? Math.min(...row.variations.map((v) => v.amountMinor))
        : null,
  }));
}

// ---- countries -------------------------------------------------------------

const COUNTRY_SELECT = {
  id: true,
  slug: true,
  title: true,
  emoji: true,
  sortOrder: true,
  isActive: true,
} as const;

/** Every country, including hidden and empty ones — for staff. */
export async function listAllCountries(): Promise<Country[]> {
  return prisma.country.findMany({
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    select: COUNTRY_SELECT,
  });
}

export async function createCountry(input: CountryInput): Promise<Country> {
  try {
    return await prisma.country.create({
      data: {
        slug: input.slug,
        title: input.title,
        emoji: input.emoji ?? null,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      },
      select: COUNTRY_SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(`Country slug "${input.slug}" is already in use.`);
    }
    throw error;
  }
}

export async function updateCountry(
  id: string,
  input: CountryUpdate,
): Promise<Country> {
  try {
    return await prisma.country.update({
      where: { id },
      data: definedFields(input),
      select: COUNTRY_SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(`Country slug "${String(input.slug)}" is already in use.`);
    }
    if (isMissingRecord(error)) {
      throw notFound(`Country ${id} was not found.`);
    }
    throw error;
  }
}

/**
 * Deletes a country. Variations keep existing but lose their country label:
 * the relation is `SetNull`, so removing a country cannot destroy sellable
 * stock or make paid orders unreadable.
 */
export async function deleteCountry(id: string): Promise<Country> {
  try {
    return await prisma.country.delete({ where: { id }, select: COUNTRY_SELECT });
  } catch (error) {
    if (isMissingRecord(error)) {
      throw notFound(`Country ${id} was not found.`);
    }
    throw error;
  }
}

async function staffStockByProduct(
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
