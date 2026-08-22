import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProductListItem } from '@shop/shared';
import { isPurchasable } from '@shop/shared';
import { api } from '../api/client.ts';
import { Price, ProductSkeletonGrid, EmptyState, ErrorState } from '../components/ui.tsx';
import { haptic } from '../telegram/webapp.ts';

/** Catalog: category filter + product grid. */
export function CatalogScreen({
  onOpenProduct,
}: {
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

  const chips = useMemo(
    () => [
      { slug: null as string | null, title: 'Все', emoji: null },
      ...(categoriesQuery.data ?? []).map((c) => ({
        slug: c.slug,
        title: c.title,
        emoji: c.emoji,
      })),
    ],
    [categoriesQuery.data],
  );

  return (
    <div className="page">
      <header style={{ marginBottom: 16 }}>
        <h1 className="title">Магазин</h1>
        <p className="subtitle">Цифровые товары с моментальной выдачей</p>
      </header>

      {chips.length > 1 ? (
        <div className="chips" style={{ marginBottom: 16 }}>
          {chips.map((chip) => (
            <button
              key={chip.slug ?? 'all'}
              type="button"
              className="chip"
              aria-pressed={category === chip.slug}
              onClick={() => {
                haptic('selection');
                setCategory(chip.slug);
              }}
            >
              {chip.emoji ? `${chip.emoji} ` : ''}
              {chip.title}
            </button>
          ))}
        </div>
      ) : null}

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
