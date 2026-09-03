import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Category, ProductListItem } from '@shop/shared';
import { isPurchasable } from '@shop/shared';
import { api } from '../api/client.ts';
import {
  CategorySkeletonGrid,
  EmptyState,
  ErrorState,
  Price,
  ProductSkeletonGrid,
} from '../components/ui.tsx';
import { haptic } from '../telegram/webapp.ts';

/**
 * Home screen: category grid and product grid.
 *
 * The greeting lives in `AppLayout` now, so this screen no longer loads the
 * viewer: one `['me']` query for the whole app means the header and the club
 * notices can never disagree about who is looking.
 *
 * Prices are shown plainly — a single figure, no strike-throughs — but it is
 * the figure *this* viewer will be charged: the club tier for a member, the
 * standard price otherwise. Same conversion the server runs at checkout, so the
 * grid, the cart and the invoice always agree. A grid of struck-through numbers
 * would read as a sale, and the club tier is a standing rate, not a promotion.
 */
export function CatalogScreen({
  isSubscribedChannel,
  onOpenProduct,
}: {
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
}) {
  const [category, setCategory] = useState<string | null>(null);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.listCategories(),
    staleTime: 5 * 60 * 1000,
  });

  const productsQuery = useQuery({
    queryKey: ['products', category],
    queryFn: () => api.listProducts(category ? { category } : {}),
  });

  const selectedTitle = useMemo(
    () =>
      categoriesQuery.data?.find((c) => c.slug === category)?.title ?? null,
    [categoriesQuery.data, category],
  );

  return (
    <div className="page">
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
          onSelect={(slug) => {
            haptic('selection');
            // Tapping the active tile clears the filter: without this the only
            // way back to "everything" would be the All tile, which is easy to
            // miss once the grid scrolls.
            setCategory((prev) => (prev === slug ? null : slug));
          }}
        />
      ) : null}

      <h2 className="section-title">{selectedTitle ?? 'Все товары'}</h2>

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
        <div className="product-grid">
          {productsQuery.data.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              isSubscribedChannel={isSubscribedChannel}
              onClick={() => {
                haptic('tap');
                onOpenProduct(product.slug);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
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

function ProductCard({
  product,
  isSubscribedChannel,
  onClick,
}: {
  product: ProductListItem;
  isSubscribedChannel: boolean;
  onClick: () => void;
}) {
  const available = isPurchasable(product);

  return (
    <button type="button" className="product-card" onClick={onClick}>
      {product.imageUrl ? (
        <img
          className="product-card__media"
          src={product.imageUrl}
          alt={product.title}
          loading="lazy"
        />
      ) : (
        <div className="product-card__media">🎁</div>
      )}
      <div className="product-card__body">
        <div className="product-card__title">{product.title}</div>
        <div className="spacer" />
        <Price
          clubTierMinor={product.amountMinor}
          currency={product.currency}
          compareAtMinor={product.compareAtMinor}
          isSubscribedChannel={isSubscribedChannel}
        />
        {!available ? (
          <span className="badge badge--danger">Нет в наличии</span>
        ) : product.stock !== null && product.stock <= 5 ? (
          <span className="badge">Осталось {product.stock}</span>
        ) : null}
      </div>
    </button>
  );
}
