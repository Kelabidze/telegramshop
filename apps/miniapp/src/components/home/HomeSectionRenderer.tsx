import type { Banner, Category, ProductListItem } from '@shop/shared';
import type { HomeSectionConfig } from './types.ts';
import { PromoBannersSection } from './PromoBannersSection.tsx';
import { CategoryPickerSection } from './CategoryPickerSection.tsx';
import { ZoneNowSection } from './ZoneNowSection.tsx';
import { BestPriceSection } from './BestPriceSection.tsx';
import { PopularSection } from './PopularSection.tsx';

/**
 * Renders a single Home section based on its configuration.
 *
 * Keeps the section implementations independent: adding a new section is one
 * case here and one new component, not scattered edits across a monolithic Home.
 */
export function HomeSectionRenderer({
  config,
  banners,
  categories,
  products,
  isSubscribedChannel,
  onOpenProduct,
  onOpenCategory,
}: {
  config: HomeSectionConfig;
  banners: Banner[];
  categories: Category[];
  products: ProductListItem[];
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
  onOpenCategory: (slug: string) => void;
}) {
  switch (config.type) {
    case 'promo_banners':
      return (
        <PromoBannersSection
          banners={banners}
          onOpenCategory={onOpenCategory}
        />
      );

    case 'category_picker':
      return (
        <CategoryPickerSection
          categories={categories}
          onOpenCategory={onOpenCategory}
        />
      );

    case 'zone_now':
      return <ZoneNowSection />;

    case 'best_price':
      return (
        <BestPriceSection
          products={products}
          isSubscribedChannel={isSubscribedChannel}
          onOpenProduct={onOpenProduct}
        />
      );

    case 'popular':
      return (
        <PopularSection
          products={products}
          isSubscribedChannel={isSubscribedChannel}
          onOpenProduct={onOpenProduct}
          onOpenCatalog={() => {
            // Open catalog without filter
            onOpenCategory('');
          }}
        />
      );

    case 'news':
      // Architecturally ready, disabled by default.
      return null;

    default:
      // Exhaustiveness check: TypeScript will complain if a new section type is
      // added to the union but not handled here.
      const _exhaustive: never = config.type;
      return _exhaustive;
  }
}
