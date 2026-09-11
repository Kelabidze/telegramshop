import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Category, ProductSection } from '@shop/shared';
import { api } from '../api/client.ts';
import {
  CategorySkeletonGrid,
  EmptyState,
  ErrorState,
  ProductSkeletonGrid,
} from './ui.tsx';
import { ProductGrid } from './ProductGrid.tsx';
import { BannerStrip } from './BannerStrip.tsx';
import {
  forgetScrollPosition,
  useScrollRestoration,
} from '../hooks/useScrollRestoration.ts';
import { haptic } from '../telegram/webapp.ts';

/**
 * The catalog browser: promo banners, the category filter and the product grid.
 *
 * Extracted from `CatalogScreen` when «Всё для абуза» switched from its own
 * country-filtered listing to the same catalog. Both screens now mount this, so
 * they cannot drift: a filter that clears on the second tap in one tab and not
 * in the other, or a card that prices a variation differently, is exactly the
 * class of bug a second copy would produce.
 *
 * The banners are fetched here rather than passed in, because a banner tap
 * filters the catalog — the handler needs the category state that lives in this
 * component. Passing them down would mean lifting that state into both screens.
 */
export function CatalogBrowser({
  bannerSection,
  bannerShape,
  initialCategory = null,
  scrollNamespace,
  isSubscribedChannel,
  onOpenProduct,
}: {
  /** Whose banners to show above the catalog. */
  bannerSection: ProductSection;
  /** Frame for those banners; defaults to the 16:9 strip. */
  bannerShape?: 'strip' | 'square';
  /**
   * Filter to open with, for callers that already know what the user picked.
   *
   * Only the initial value: the filter stays local state afterwards, so tapping
   * the active tile still clears it. Lifting it to the caller would mean routing
   * every in-screen filter change back through the navigation stack, and each of
   * those would become a back-button step.
   */
  initialCategory?: string | null;
  /**
   * Prefix for the saved scroll offset, one per screen.
   *
   * Two tabs showing the same products still deserve their own offsets: coming
   * back to one of them at the other's position reads as a random jump.
   */
  scrollNamespace: string;
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
}) {
  const [category, setCategory] = useState<string | null>(initialCategory);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.listCategories(),
    staleTime: 5 * 60 * 1000,
  });

  const bannersQuery = useQuery({
    queryKey: ['banners', bannerSection],
    queryFn: () => api.listBanners(bannerSection),
    staleTime: 5 * 60 * 1000,
    // Promo content is never worth an error screen: the catalog below it is the
    // point of the page.
    retry: false,
  });

  const productsQuery = useQuery({
    queryKey: ['products', category],
    queryFn: () => api.listProducts(category ? { category } : {}),
  });

  // Per filter, not per screen: each category is a different list, and restoring
  // one list's offset onto another lands somewhere arbitrary. Waits for the
  // products so the document is tall enough to scroll when the offset is applied.
  useScrollRestoration(
    `${scrollNamespace}:${category ?? 'all'}`,
    productsQuery.data !== undefined,
  );

  /** Switching a filter starts a new list, so its offset must not be inherited. */
  const selectCategory = (next: string | null) => {
    haptic('selection');
    forgetScrollPosition(`${scrollNamespace}:${next ?? 'all'}`);
    setCategory(next);
    // Two-argument form: older Telegram WebViews drop an options object whose
    // `behavior` they do not recognise, and then do not scroll at all.
    window.scrollTo(0, 0);
  };

  const selectedTitle = useMemo(
    () =>
      categoriesQuery.data?.find((c) => c.slug === category)?.title ?? null,
    [categoriesQuery.data, category],
  );

  return (
    <>
      {/*
        Above the catalog, below the profile header. No skeleton while it loads:
        banners are promotional, and a shimmering placeholder for content that
        may not exist would push the catalog down for nothing.
      */}
      <BannerStrip
        banners={bannersQuery.data ?? []}
        shape={bannerShape}
        onOpenCategory={selectCategory}
      />

      <h2 className="section-title" style={{ marginTop: 0 }}>
        Каталог
      </h2>

      {categoriesQuery.isPending ? <CategorySkeletonGrid /> : null}

      {categoriesQuery.isError ? (
        <ErrorState
          message={(categoriesQuery.error as Error).message}
          onRetry={() => void categoriesQuery.refetch()}
        />
      ) : null}

      {categoriesQuery.data && categoriesQuery.data.length > 0 ? (
        <CategoryGrid
          categories={categoriesQuery.data}
          selected={category}
          onSelect={(slug) =>
            // Tapping the active tile clears the filter too, so the grid itself
            // is a way back to "everything" without hunting for the All tile.
            selectCategory(category === slug ? null : slug)
          }
        />
      ) : null}

      <div className="row" style={{ marginTop: 20 }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          {selectedTitle ?? 'Все товары'}
        </h2>
        <div className="spacer" />
        {/*
          Explicit reset, shown only while a filter is on: an always-visible
          "Все товары" next to an unfiltered list is a button that does nothing.
        */}
        {category ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => selectCategory(null)}
          >
            Все товары ✕
          </button>
        ) : null}
      </div>

      {productsQuery.isPending ? <ProductSkeletonGrid /> : null}

      {productsQuery.isError ? (
        <ErrorState
          message={(productsQuery.error as Error).message}
          onRetry={() => void productsQuery.refetch()}
        />
      ) : null}

      {productsQuery.data?.length === 0 ? (
        <EmptyState
          emoji="🔍"
          title="Товаров нет"
          description="В этой категории пока пусто. Загляните позже."
        />
      ) : null}

      {productsQuery.data && productsQuery.data.length > 0 ? (
        <ProductGrid
          products={productsQuery.data}
          isSubscribedChannel={isSubscribedChannel}
          onOpenProduct={onOpenProduct}
        />
      ) : null}
    </>
  );
}

function CategoryGrid({
  categories,
  selected,
  onSelect,
}: {
  categories: Category[];
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  return (
    <div className="category-grid">
      {categories.map((category) => (
        <button
          key={category.id}
          type="button"
          className="category-card"
          aria-pressed={selected === category.slug}
          onClick={() => onSelect(category.slug)}
        >
          {/* Emoji is optional in the schema, so every tile needs a fallback. */}
          <span className="category-card__icon" aria-hidden="true">
            {category.emoji || '🗂'}
          </span>
          <span className="category-card__title">{category.title}</span>
        </button>
      ))}
    </div>
  );
}
