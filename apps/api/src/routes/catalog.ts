import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { type PaymentOptions, productSectionSchema } from '@shop/shared';
import { config } from '../config.js';
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

/**
 * Which section's banners to serve. Defaults to the main catalog so a client
 * that predates sections keeps getting exactly what it used to.
 */
const bannerQuerySchema = z.object({
  section: productSectionSchema.default('SHOP'),
});

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  // Catalog is public: browsing does not require a verified viewer.
  app.get('/categories', async () => ({ categories: await listCategories() }));

  /**
   * Rates for previewing prices, and whether USDT is on offer.
   *
   * Public, like the catalog: it exposes nothing a price tag does not already.
   * Exists so the client has one source for these numbers instead of a copy that
   * drifts — the server still recomputes every amount at checkout, so a stale
   * client cannot produce a wrong charge, only a confusing screen.
   */
  app.get('/payment-options', async () => {
    /**
     * The live USDT rate, when one can be had.
     *
     * Best effort: this endpoint also drives the cart preview for roubles and
     * Stars, and neither depends on an exchange being reachable. A failure here
     * degrades the USDT preview rather than the whole storefront — and USDT
     * checkout refuses separately, so nothing is quoted from a rate that was not
     * actually obtained.
     */
    let usdtRate: PaymentOptions['usdtRate'] = null;
    let usdtRubMinorPerUnit = config.rates.usdtRubMinorPerUnit;

    if (config.rapira.enabled) {
      try {
        const { getUsdtRubRate } = await import('../payments/rapira-rates.js');
        const quote = await getUsdtRubRate();
        usdtRubMinorPerUnit = quote.rateRubMinorPerUnit;
        usdtRate = {
          source: quote.source,
          side: quote.side,
          display: (quote.rateRubMinorPerUnit / 100).toFixed(2),
        };
      } catch {
        // Leave `usdtRate` null: the client shows no rate and no USDT amount
        // rather than one derived from a stale fallback.
        usdtRate = null;
      }
    } else {
      usdtRate = {
        source: 'CONFIG',
        side: null,
        display: (usdtRubMinorPerUnit / 100).toFixed(2),
      };
    }

    const options: PaymentOptions = {
      rates: { ...config.rates, usdtRubMinorPerUnit },
      // A rail with no usable rate cannot quote a price, so it is not offered.
      usdtAvailable: config.crypto.enabled && usdtRate !== null,
      cardAvailable: config.cashera.enabled,
      usdtRate,
    };
    return options;
  });

  // Public too, and for the same reason: a storefront screen renders its promo
  // banners before it knows who is looking.
  app.get('/banners', async (request) => {
    const parsed = bannerQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw validationError('Invalid query parameters.', parsed.error.issues);
    }
    return { banners: await listActiveBanners(parsed.data.section) };
  });

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
