import { useQuery } from '@tanstack/react-query';
import { isPurchasable } from '@shop/shared';
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
  const inCart = product
    ? lines.find((l) => l.productId === product.id)
    : undefined;
  const available = product ? isPurchasable(product) : false;

  // The native MainButton is the primary action on this screen.
  useMainButton(
    product
      ? {
          text: !available
            ? 'Нет в наличии'
            : inCart
              ? 'Перейти в корзину'
              : 'Добавить в корзину',
          enabled: available,
          onClick: () => {
            if (!available) return;
            if (inCart) {
              onGoToCart();
              return;
            }
            addToCart(product);
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
          className="card"
          style={{
            display: 'grid',
            placeItems: 'center',
            fontSize: 64,
            aspectRatio: '16 / 9',
            marginBottom: 16,
          }}
        >
          🎁
        </div>
      )}

      <h1 className="title">{product.title}</h1>
      {product.subtitle ? (
        <p className="subtitle">{product.subtitle}</p>
      ) : null}

      <div className="row" style={{ margin: '16px 0' }}>
        <span style={{ fontSize: 22 }}>
          <Price
            clubTierMinor={product.amountMinor}
            currency={product.currency}
            compareAtMinor={product.compareAtMinor}
            isSubscribedChannel={isSubscribedChannel}
          />
        </span>
        <div className="spacer" />
        {!available ? (
          <span className="badge badge--danger">Нет в наличии</span>
        ) : product.stock !== null ? (
          <span className="badge">Осталось {product.stock}</span>
        ) : null}
      </div>

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
