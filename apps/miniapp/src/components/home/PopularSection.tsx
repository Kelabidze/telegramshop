import type { ProductListItem } from '@shop/shared';
import { ProductGrid } from '../ProductGrid.tsx';
import { haptic } from '../../telegram/webapp.ts';

/**
 * Popular section: "Популярно сейчас"
 *
 * A few quick popular products to help users start browsing. Not a full
 * catalog — just 4-6 items to get started, with a link to the full catalog.
 *
 * Uses existing ProductGrid. Shows the first N active products for now — when
 * the backend tracks popularity metrics, this can filter by view count or
 * purchase frequency.
 */
export function PopularSection({
  products,
  isSubscribedChannel,
  onOpenProduct,
  onOpenCatalog,
}: {
  products: ProductListItem[];
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
  onOpenCatalog: () => void;
}) {
  // Show first few active products. When backend supports popularity tracking,
  // this becomes a sorted query.
  const popularProducts = products.filter((p) => p.isActive).slice(0, 6);

  if (popularProducts.length === 0) return null;

  return (
    <section className="home-section">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          Популярно сейчас
        </h2>
        <div className="spacer" />
        {products.length > popularProducts.length ? (
          <button
            type="button"
            className="button button--ghost button--compact"
            onClick={() => {
              haptic('tap');
              onOpenCatalog();
            }}
          >
            Смотреть всё
          </button>
        ) : null}
      </div>
      <ProductGrid
        products={popularProducts}
        isSubscribedChannel={isSubscribedChannel}
        onOpenProduct={onOpenProduct}
      />
    </section>
  );
}
