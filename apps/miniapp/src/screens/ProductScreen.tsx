import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  hasVariations,
  isAwaitingVariations,
  isPurchasable,
  type ProductVariation,
} from '@shop/shared';
import { api } from '../api/client.ts';
import { useCart } from '../store/cart.ts';
import { useMainButton } from '../telegram/buttons.ts';
import { haptic } from '../telegram/webapp.ts';
import {
  ClubTierNotice,
  Price,
  Spinner,
  ErrorState,
} from '../components/ui.tsx';
import { IconMediaPlaceholder } from '../components/icons/index.tsx';

const FULFILLMENT_LABEL: Record<string, string> = {
  LICENSE_KEY: 'Ключ активации придёт в чат сразу после оплаты',
  FILE: 'Ссылка на скачивание придёт в чат сразу после оплаты',
  LINK: 'Доступ откроется сразу после оплаты',
};

export function ProductScreen({
  slug,
  isSubscribedChannel,
  onGoToCart,
}: {
  slug: string;
  isSubscribedChannel: boolean;
  onGoToCart: () => void;
}) {
  const query = useQuery({
    queryKey: ['product', slug],
    queryFn: () => api.getProduct(slug),
  });

  const addToCart = useCart((s) => s.add);
  const lines = useCart((s) => s.lines);

  const product = query.data;
  const variations = product?.variations ?? [];
  const variable = product ? hasVariations(product) : false;
  // An ABUSE root whose variations have not been added yet. Same predicate as
  // the grid, so the card and the page it opens cannot disagree.
  const awaiting = product ? isAwaitingVariations(product) : false;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = variations.find((v) => v.id === selectedId) ?? null;

  /**
   * What actually goes into the cart.
   *
   * A parent with variations has no stock of its own — its license keys live on
   * the children — so the cart line must be the chosen variation. The server
   * refuses a parent outright, which is what makes this safe rather than merely
   * tidy. An unfilled root is the same case with nothing to choose from, so it
   * offers nothing.
   */
  const buyable =
    variable || awaiting
      ? selected
        ? {
            id: selected.id,
            slug: selected.slug,
            title: `${product!.title} — ${selected.title}`,
            imageUrl: product!.imageUrl,
            amountMinor: selected.amountMinor,
            currency: selected.currency,
            compareAtMinor: selected.compareAtMinor,
            stock: selected.stock,
            isActive: selected.isActive,
          }
        : null
      : product
        ? {
            id: product.id,
            slug: product.slug,
            title: product.title,
            imageUrl: product.imageUrl,
            amountMinor: product.amountMinor,
            currency: product.currency,
            compareAtMinor: product.compareAtMinor,
            stock: product.stock,
            isActive: product.isActive,
          }
        : null;

  const inCart = buyable
    ? lines.find((l) => l.productId === buyable.id)
    : undefined;
  const available = buyable ? isPurchasable(buyable) : false;

  // The native MainButton is the primary action on this screen.
  useMainButton(
    product
      ? {
          // With variations the button first has to ask for a choice: adding
          // "something" from a product that has five different prices is not a
          // decision the app can make for the buyer. An unfilled root has no
          // choice to offer, so the button states the wait instead.
          text: awaiting
            ? 'Ожидается поступление'
            : variable && !selected
              ? 'Выберите вариант'
              : !available
                ? 'Нет в наличии'
                : inCart
                  ? 'Перейти в корзину'
                  : 'Добавить в корзину',
          enabled: !awaiting && (!variable || selected !== null) && available,
          onClick: () => {
            if (!buyable || !available) return;
            if (inCart) {
              onGoToCart();
              return;
            }
            addToCart({
              ...buyable,
              // The cart only stores what it displays; the server re-reads
              // everything that decides the price.
              subtitle: null,
              emoji: product.emoji,
              fulfillmentKind: product.fulfillmentKind,
              categoryId: product.categoryId,
              section: product.section,
              parentId: product.parentId,
              countryId: product.countryId,
              variationCount: 0,
              minVariationAmountMinor: null,
            });
            haptic('success');
            onGoToCart();
          },
        }
      : null,
  );

  if (query.isPending) return <Spinner label="Загружаем товар…" />;
  if (query.isError) {
    return (
      <ErrorState
        message={(query.error as Error).message}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!product) return null;

  return (
    <div className="page">
      {product.imageUrl ? (
        <img
          src={product.imageUrl}
          alt={product.title}
          style={{
            width: '100%',
            aspectRatio: '1 / 1',
            objectFit: 'cover',
            borderRadius: 'var(--radius)',
            marginBottom: 16,
          }}
        />
      ) : (
        <div
          className={`card${product.emoji ? '' : ' product-media-fallback'}`}
          style={{
            display: 'grid',
            placeItems: 'center',
            fontSize: 64,
            aspectRatio: '16 / 9',
            marginBottom: 16,
          }}
        >
          {/* Same three-step priority as the grid, so the card and the page it
              opens never disagree about what a product looks like. */}
          {product.emoji || <IconMediaPlaceholder width={72} height={72} />}
        </div>
      )}

      <h1 className="title">{product.title}</h1>
      {product.subtitle ? (
        <p className="subtitle">{product.subtitle}</p>
      ) : null}

      <div className="row" style={{ margin: '16px 0' }}>
        <span style={{ fontSize: 22 }}>
          {/*
            The selected variation's price, or the cheapest one as "от X" before
            anything is chosen. Showing the parent's own `amountMinor` would be a
            number nobody is ever charged — and on an unfilled root it is 0,
            which reads as a giveaway, so that case shows no price at all.
          */}
          {awaiting ? null : variable && !selected ? (
            <>
              <span className="hint" style={{ fontSize: 15 }}>
                от{' '}
              </span>
              <Price
                clubTierMinor={product.minVariationAmountMinor ?? product.amountMinor}
                currency={product.currency}
                isSubscribedChannel={isSubscribedChannel}
              />
            </>
          ) : (
            <Price
              clubTierMinor={buyable?.amountMinor ?? product.amountMinor}
              currency={buyable?.currency ?? product.currency}
              compareAtMinor={buyable?.compareAtMinor ?? null}
              isSubscribedChannel={isSubscribedChannel}
            />
          )}
        </span>
        <div className="spacer" />
        {awaiting ? (
          <span className="badge badge--soon">Ожидается поступление</span>
        ) : variable && !selected ? null : !available ? (
          <span className="badge badge--danger">Нет в наличии</span>
        ) : buyable?.stock !== null && buyable?.stock !== undefined ? (
          <span className="badge">Осталось {buyable.stock}</span>
        ) : null}
      </div>

      {/*
        Nothing to pick and nothing to buy — say so where the selector would be,
        rather than leaving an empty gap under the title.
      */}
      {awaiting ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="hint" style={{ margin: 0 }}>
            Варианты для этого товара ещё не добавлены. Мы пополняем раздел —
            заглядывайте позже.
          </p>
        </div>
      ) : null}

      {variable ? (
        <VariationPicker
          variations={variations}
          selectedId={selectedId}
          currency={product.currency}
          isSubscribedChannel={isSubscribedChannel}
          onSelect={(id) => {
            haptic('selection');
            setSelectedId(id);
          }}
        />
      ) : null}

      <div className="card stack">
        <p style={{ margin: 0, whiteSpace: 'pre-line' }}>
          {product.description}
        </p>
      </div>

      <p className="hint" style={{ marginTop: 16 }}>
        ⚡️ {FULFILLMENT_LABEL[product.fulfillmentKind] ?? ''}
      </p>

      {/*
        Sits directly above the native MainButton, which is the action on this
        screen — the offer is only useful next to the decision it affects.
        Members see nothing: they already have the rate, and a banner
        congratulating them on every product page is noise.
      */}
      {!isSubscribedChannel ? (
        <ClubTierNotice isSubscribedChannel={false} variant="product" />
      ) : null}
    </div>
  );
}

/**
 * Variation selector.
 *
 * A list of explicit options rather than a `<select>`: each one carries a price
 * and a stock state, and a native dropdown can show neither. Sold-out options
 * stay visible but disabled — hiding them makes the list change length as stock
 * moves, which reads as items disappearing at random.
 */
function VariationPicker({
  variations,
  selectedId,
  currency,
  isSubscribedChannel,
  onSelect,
}: {
  variations: ProductVariation[];
  selectedId: string | null;
  currency: ProductVariation['currency'];
  isSubscribedChannel: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="stack" style={{ marginBottom: 16 }}>
      <span className="hint">Выберите вариант</span>
      <div className="variation-list">
        {variations.map((variation) => {
          const soldOut = !isPurchasable(variation);
          return (
            <button
              key={variation.id}
              type="button"
              className="variation-option"
              aria-pressed={selectedId === variation.id}
              disabled={soldOut}
              onClick={() => onSelect(variation.id)}
            >
              {variation.country ? (
                <span className="country-chip__flag" aria-hidden="true">
                  {variation.country.emoji || '🌍'}
                </span>
              ) : null}
              <span className="variation-option__title">
                {variation.country?.title ?? variation.title}
              </span>
              <span>
                <Price
                  clubTierMinor={variation.amountMinor}
                  currency={currency}
                  isSubscribedChannel={isSubscribedChannel}
                />
              </span>
              {soldOut ? (
                <span className="badge badge--danger">Нет</span>
              ) : variation.stock !== null && variation.stock <= 5 ? (
                <span className="badge">{variation.stock}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
