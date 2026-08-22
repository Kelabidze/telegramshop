import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  getProductBySlug,
  listCategories,
  listProducts,
} from '../services/catalog.js';
import { validationError } from '../errors.js';

const listQuerySchema = z.object({
  category: z.string().min(1).max(64).optional(),
  q: z.string().min(1).max(100).optional(),
});

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  // Catalog is public: browsing does not require a verified viewer.
  app.get('/categories', async () => ({ categories: await listCategories() }));

  app.get('/products', async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw validationError('Invalid query parameters.', parsed.error.issues);
    }
    const products = await listProducts({
      categorySlug: parsed.data.category,
      search: parsed.data.q,
    });
    return { products };
  });

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
