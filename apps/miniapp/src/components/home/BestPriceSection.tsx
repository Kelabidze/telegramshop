import type { ProductListItem } from '@shop/shared';
import { ProductGrid } from '../ProductGrid.tsx';

/**
 * Best Price section: "Лучшая цена"
 *
 * Products with good value — discounts, promotional pricing, or items with
 * competitive prices. Not labelled "Скидки" because this can include products
 * with strong base pricing, not just formal discounts.
 *
 * Uses existing ProductGrid. Gracefully hides when no suitable products exist.
 */
export function BestPriceSection({
  products,
  isSubscribedChannel,
  onOpenProduct,
}: {
  products: ProductListItem[];
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
}) {
  // Show products with compareAt pricing (formal discounts) or low-priced items.
  // For now, just show products with compareAt — a clear signal of promotional
  // pricing. More sophisticated logic (price bands, margins) can be added when
  // the backend supports explicit "featured deal" flags.
  const bestPriceProducts = products
    .filter((p) => p.compareAtMinor !== null && p.isActive)
    .slice(0, 4);

  if (bestPriceProducts.length === 0) return null;

  return (
    <section className="home-section">
      <h2 className="section-title">Лучшая цена</h2>
      <ProductGrid
        products={bestPriceProducts}
        isSubscribedChannel={isSubscribedChannel}
        onOpenProduct={onOpenProduct}
      />
    </section>
  );
}
