import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { productSectionSchema } from '@shop/shared';
import {
  getProductBySlug,
  listCategories,
  listCountries,
  listProducts,
} from '../services/catalog.js';
import { listActiveBanners } from '../services/banners.js';
import { validationError } from '../errors.js';

const listQuerySchema = z.object({
  category: z.string().min(1).max(64).optional(),
  q: z.string().min(1).max(100).optional(),
  section: productSectionSchema.optional(),
  country: z.string().min(1).max(64).optional(),
});

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  // Catalog is public: browsing does not require a verified viewer.
  app.get('/categories', async () => ({ categories: await listCategories() }));

  // Public too, and for the same reason: the home screen renders the promo strip
  // before it knows who is looking.
  app.get('/banners', async () => ({ banners: await listActiveBanners() }));

  app.get('/products', async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw validationError('Invalid query parameters.', parsed.error.issues);
    }
    const products = await listProducts({
      categorySlug: parsed.data.category,
      search: parsed.data.q,
      section: parsed.data.section,
      countrySlug: parsed.data.country,
    });
    return { products };
  });

  // Public, like categories: the «Всё для Абуза» carousel renders before the
  // viewer is known.
  app.get('/countries', async () => ({ countries: await listCountries() }));

  app.get('/products/:slug', async (request) => {
    const params = z
      .object({ slug: z.string().min(1).max(64) })
      .safeParse(request.params);
    if (!params.success) {
      throw validationError('Invalid product slug.', params.error.issues);
    }
    return { product: await getProductBySlug(params.data.slug) };
  });
};
