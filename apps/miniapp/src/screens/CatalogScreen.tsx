import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Category, ProductListItem, Viewer } from '@shop/shared';
import { isPurchasable } from '@shop/shared';
import { api } from '../api/client.ts';
import {
  CategorySkeletonGrid,
  EmptyState,
  ErrorState,
  GreetingSkeleton,
  Price,
  ProductSkeletonGrid,
} from '../components/ui.tsx';
import { haptic } from '../telegram/webapp.ts';

/**
 * Home screen: greeting, category grid, product grid.
 *
 * The viewer and the categories are fetched in parallel through `useQueries`.
 * Chaining them would make the page as slow as the sum of both requests, and
 * neither depends on the other: the greeting needs the profile, the grid needs
 * the categories. Products are a separate query because they re-run whenever
 * the selected category changes, while the first two are fetched once.
 */
export function CatalogScreen({
  onOpenProduct,
}: {
  onOpenProduct: (slug: string) => void;
}) {
  const [category, setCategory] = useState<string | null>(null);

  const [viewerQuery, categoriesQuery] = useQueries({
    queries: [
      {
        queryKey: ['me'],
        queryFn: () => api.getViewer(),
        // The profile changes far less often than stock does.
        staleTime: 5 * 60 * 1000,
        // Outside Telegram (and without dev auth) this is a guaranteed 401.
        // Retrying would only delay the fallback greeting.
        retry: false,
      },
      {
        queryKey: ['categories'],
        queryFn: () => api.listCategories(),
        staleTime: 5 * 60 * 1000,
      },
    ],
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
      {viewerQuery.isPending ? (
        <GreetingSkeleton />
      ) : (
        <Greeting viewer={viewerQuery.data ?? null} />
      )}

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

/**
 * Greeting line.
 *
 * `viewer` is null when the profile request failed — outside Telegram, or with
 * an expired signature. That is not an error worth showing: the catalog is
 * public and browsing must keep working, so the name simply falls back to a
 * neutral greeting.
 */
function Greeting({ viewer }: { viewer: Viewer | null }) {
  const name = viewer?.firstName?.trim();
  const initial = name ? [...name][0] : '👋';

  return (
    <header className="greeting">
      <div className="greeting__avatar" aria-hidden="true">
        {initial}
      </div>
      <div className="greeting__text">
        <p className="greeting__hello">
          {name ? `Привет, ${name}` : 'Привет'}
        </p>
        <p className="greeting__caption">Цифровые товары с моментальной выдачей</p>
      </div>
    </header>
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
  onClick,
}: {
  product: ProductListItem;
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
          amountMinor={product.amountMinor}
          currency={product.currency}
          compareAtMinor={product.compareAtMinor}
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
