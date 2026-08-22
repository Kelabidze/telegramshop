import { useCallback, useEffect, useState } from 'react';
import { useCart, selectItemCount } from './store/cart.ts';
import { useBackButton } from './telegram/buttons.ts';
import { haptic, isTelegramEnvironment } from './telegram/webapp.ts';
import { CatalogScreen } from './screens/CatalogScreen.tsx';
import { ProductScreen } from './screens/ProductScreen.tsx';
import { CartScreen } from './screens/CartScreen.tsx';
import { OrdersScreen } from './screens/OrdersScreen.tsx';

/**
 * Navigation.
 *
 * A small explicit view stack instead of a router: a Mini App has few screens,
 * and this keeps Telegram's BackButton perfectly in sync with history, which is
 * fiddly to get right with the browser history API inside a WebView.
 */
type View =
  | { name: 'catalog' }
  | { name: 'product'; slug: string }
  | { name: 'cart' }
  | { name: 'orders' };

export function App() {
  const [stack, setStack] = useState<View[]>([{ name: 'catalog' }]);
  const current = stack[stack.length - 1] ?? { name: 'catalog' };
  const itemCount = useCart(selectItemCount);

  const push = useCallback((view: View) => {
    setStack((prev) => [...prev, view]);
  }, []);

  const pop = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const resetTo = useCallback((view: View) => {
    setStack([view]);
  }, []);

  // Telegram's back button mirrors the stack depth.
  useBackButton(stack.length > 1 ? () => { haptic('tap'); pop(); } : null);

  // Also handle the Android hardware back button / browser back.
  useEffect(() => {
    const onPopState = () => pop();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [pop]);

  return (
    <>
      {!isTelegramEnvironment() ? <DevBanner /> : null}

      {current.name === 'catalog' ? (
        <CatalogScreen
          onOpenProduct={(slug) => push({ name: 'product', slug })}
        />
      ) : null}

      {current.name === 'product' ? (
        <ProductScreen
          slug={current.slug}
          onGoToCart={() => push({ name: 'cart' })}
        />
      ) : null}

      {current.name === 'cart' ? (
        <CartScreen
          onContinueShopping={() => resetTo({ name: 'catalog' })}
          onOpenOrders={() => resetTo({ name: 'orders' })}
        />
      ) : null}

      {current.name === 'orders' ? (
        <OrdersScreen onContinueShopping={() => resetTo({ name: 'catalog' })} />
      ) : null}

      <TabBar
        current={current.name}
        itemCount={itemCount}
        onSelect={(name) => {
          haptic('selection');
          resetTo({ name } as View);
        }}
      />
    </>
  );
}

/** Visible only outside Telegram, to explain the limited functionality. */
function DevBanner() {
  return (
    <div
      style={{
        background: 'var(--tg-secondary-bg-color)',
        padding: '8px 16px',
        fontSize: 13,
        textAlign: 'center',
        color: 'var(--tg-hint-color)',
      }}
    >
      Открыто вне Telegram: оплата недоступна, вход — только в dev-режиме.
    </div>
  );
}

const TABS = [
  { name: 'catalog', label: 'Каталог', icon: '🛍' },
  { name: 'cart', label: 'Корзина', icon: '🛒' },
  { name: 'orders', label: 'Заказы', icon: '📦' },
] as const;

function TabBar({
  current,
  itemCount,
  onSelect,
}: {
  current: View['name'];
  itemCount: number;
  onSelect: (name: 'catalog' | 'cart' | 'orders') => void;
}) {
  return (
    <nav
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        background: 'var(--tg-bg-color)',
        borderTop: '1px solid var(--tg-secondary-bg-color)',
        // Respect the iOS home-indicator area.
        paddingBottom: 'env(safe-area-inset-bottom)',
        zIndex: 10,
      }}
    >
      {TABS.map((tab) => {
        const active =
          current === tab.name || (tab.name === 'catalog' && current === 'product');
        return (
          <button
            key={tab.name}
            type="button"
            onClick={() => onSelect(tab.name)}
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              padding: '10px 0',
              cursor: 'pointer',
              color: active ? 'var(--tg-link-color)' : 'var(--tg-hint-color)',
              fontSize: 11,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <span style={{ fontSize: 20, position: 'relative' }}>
              {tab.icon}
              {tab.name === 'cart' && itemCount > 0 ? (
                <span
                  style={{
                    position: 'absolute',
                    top: -4,
                    right: -10,
                    background: 'var(--tg-destructive-text-color)',
                    color: '#fff',
                    borderRadius: 999,
                    fontSize: 10,
                    minWidth: 16,
                    height: 16,
                    lineHeight: '16px',
                    padding: '0 4px',
                  }}
                >
                  {itemCount}
                </span>
              ) : null}
            </span>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
