import {
  hasVariations,
  isAwaitingVariations,
  isPurchasable,
  type ProductListItem,
} from '@shop/shared';
import { Price } from './ui.tsx';
import { haptic } from '../telegram/webapp.ts';

/**
 * The product grid, shared by the catalog and «Всё для Абуза».
 *
 * Extracted so the two screens cannot drift: a card that renders a variation
 * price correctly in one tab and not the other is exactly the bug this avoids.
 */
export function ProductGrid({
  products,
  isSubscribedChannel,
  onOpenProduct,
}: {
  products: ProductListItem[];
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
}) {
  return (
    <div className="product-grid">
      {products.map((product) => (
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
  const variable = hasVariations(product);
  // A section root with no country variations yet: no price of its own to show
  // and nothing to be out of stock of.
  const awaiting = isAwaitingVariations(product);

  return (
    <button type="button" className="product-card" onClick={onClick}>
      {/*
        Image wins over emoji when both are set, and the emoji covers the case
        where nobody uploaded artwork. `🎁` remains the last resort so a card is
        never a blank square.
      */}
      {product.imageUrl ? (
        <img
          className="product-card__media"
          src={product.imageUrl}
          alt={product.title}
          loading="lazy"
        />
      ) : (
        <div className="product-card__media">{product.emoji || '🎁'}</div>
      )}
      <div className="product-card__body">
        <div className="product-card__title">{product.title}</div>
        <div className="spacer" />

        {/*
          A parent's own `amountMinor` is not what anyone pays — the variations
          carry the real prices — so the card shows the cheapest one as "от X".
          Printing the parent's price would understate or overstate every option.

          An unfilled root shows no price at all: its stored 0 is a placeholder,
          not an offer, and «Бесплатно» is the one reading that would cost money
          to correct.
        */}
        {awaiting ? null : variable &&
          product.minVariationAmountMinor !== null ? (
          <span className="hint">
            от{' '}
            <Price
              clubTierMinor={product.minVariationAmountMinor}
              currency={product.currency}
              isSubscribedChannel={isSubscribedChannel}
            />
          </span>
        ) : (
          <Price
            clubTierMinor={product.amountMinor}
            currency={product.currency}
            compareAtMinor={product.compareAtMinor}
            isSubscribedChannel={isSubscribedChannel}
          />
        )}

        {awaiting ? (
          <span className="badge badge--soon">Ожидается поступление</span>
        ) : !available ? (
          <span className="badge badge--danger">Нет в наличии</span>
        ) : variable ? (
          <span className="badge">{variationLabel(product.variationCount)}</span>
        ) : product.stock !== null && product.stock <= 5 ? (
          <span className="badge">Осталось {product.stock}</span>
        ) : null}
      </div>
    </button>
  );
}

/** Russian plural for «вариант». */
function variationLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} вариант`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} варианта`;
  }
  return `${count} вариантов`;
}


