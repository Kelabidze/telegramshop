import { useQuery } from '@tanstack/react-query';
import type { HomeSectionConfig } from '../components/home/types.ts';
import { api } from '../api/client.ts';
import { HomeSectionRenderer } from '../components/home/HomeSectionRenderer.tsx';
import { useScrollRestoration } from '../hooks/useScrollRestoration.ts';

/**
 * Home screen: storefront hub showing what's happening in OCHKISK ZONE.
 *
 * Not a second catalog — this is editorial and featured content. The catalog
 * remains the place to browse everything systematically.
 *
 * Composed of independent sections, each with its own data and UI. The order
 * and enabled state are configured here; when server-driven composition is
 * needed, this config becomes an API response.
 */
export function HomeScreen({
  isSubscribedChannel,
  onOpenProduct,
  onOpenCategory,
}: {
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
  onOpenCategory: (slug: string) => void;
}) {
  const bannersQuery = useQuery({
    queryKey: ['banners', 'SHOP'],
    queryFn: () => api.listBanners('SHOP'),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.listCategories(),
    staleTime: 5 * 60 * 1000,
  });

  const productsQuery = useQuery({
    queryKey: ['products'],
    queryFn: () => api.listProducts(),
    staleTime: 2 * 60 * 1000,
  });

  useScrollRestoration('home', productsQuery.data !== undefined);

  const sections: HomeSectionConfig[] = [
    { type: 'promo_banners', enabled: true, order: 0 },
    { type: 'category_picker', enabled: true, order: 1 },
    { type: 'zone_now', enabled: true, order: 2 },
    { type: 'best_price', enabled: true, order: 3 },
    { type: 'popular', enabled: true, order: 4 },
    { type: 'news', enabled: false, order: 5 },
  ];

  const enabledSections = sections
    .filter((s) => s.enabled)
    .sort((a, b) => a.order - b.order);

  return (
    <div className="page">
      {enabledSections.map((section) => (
        <HomeSectionRenderer
          key={section.type}
          config={section}
          banners={bannersQuery.data ?? []}
          categories={categoriesQuery.data ?? []}
          products={productsQuery.data ?? []}
          isSubscribedChannel={isSubscribedChannel}
          onOpenProduct={onOpenProduct}
          onOpenCategory={onOpenCategory}
        />
      ))}
    </div>
  );
}
