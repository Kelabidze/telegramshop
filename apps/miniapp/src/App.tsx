import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCart, selectItemCount } from './store/cart.ts';
import { useViewer } from './api/useViewer.ts';
import { useBackButton } from './telegram/buttons.ts';
import { haptic, isTelegramEnvironment } from './telegram/webapp.ts';
import { AppLayout, type TabName } from './components/AppLayout.tsx';
import { CatalogScreen } from './screens/CatalogScreen.tsx';
import { ProductScreen } from './screens/ProductScreen.tsx';
import { CartScreen } from './screens/CartScreen.tsx';
import { OrdersScreen } from './screens/OrdersScreen.tsx';
import { ProfileScreen } from './screens/ProfileScreen.tsx';

/**
 * Navigation.
 *
 * A small explicit view stack instead of a router: a Mini App has few screens,
 * and this keeps Telegram's BackButton perfectly in sync with history, which is
 * fiddly to get right with the browser history API inside a WebView.
 *
 * `product` and `profile` are pushed on top of a tab; the tabs themselves reset
 * the stack. That is what makes tapping any tab a valid way out of the profile
 * without a special case per screen.
 */
type View =
  | { name: 'catalog' }
  | { name: 'product'; slug: string }
  | { name: 'cart' }
  | { name: 'orders' }
  | { name: 'profile' };

/**
 * Which tab stays highlighted for a given screen.
 *
 * A pushed screen keeps its parent tab lit rather than clearing the selection:
 * an unlit tab bar reads as "you are nowhere". The profile is not a tab, so it
 * inherits the tab it was opened from — tracked separately, because the stack
 * is reset to a single entry when the profile is opened from a header tap.
 */
function tabForView(view: View, fallback: TabName): TabName {
  switch (view.name) {
    case 'catalog':
    case 'product':
      return 'catalog';
    case 'cart':
      return 'cart';
    case 'orders':
      return 'orders';
    case 'profile':
      return fallback;
  }
}

/** Screens that keep the profile header visible. */
const HEADER_VIEWS = new Set<View['name']>(['catalog', 'cart', 'orders']);

export function App() {
  const [stack, setStack] = useState<View[]>([{ name: 'catalog' }]);
  const current = stack[stack.length - 1] ?? { name: 'catalog' };
  const itemCount = useCart(selectItemCount);
  const { viewer, isPending, isSubscribedChannel } = useViewer();

  const push = useCallback((view: View) => {
    setStack((prev) => [...prev, view]);
  }, []);

  const pop = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const resetTo = useCallback((view: View) => {
    setStack([view]);
  }, []);

  const activeTab = useMemo(
    () =>
      tabForView(
        current,
        // The tab under the profile: the entry below it in the stack, or the
        // catalog when the profile is the only screen left.
        tabForView(stack[stack.length - 2] ?? { name: 'catalog' }, 'catalog'),
      ),
    [current, stack],
  );

  // Telegram's back button mirrors the stack depth.
  useBackButton(stack.length > 1 ? () => { haptic('tap'); pop(); } : null);

  // Also handle the Android hardware back button / browser back.
  useEffect(() => {
    const onPopState = () => pop();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [pop]);

  return (
    <AppLayout
      viewer={viewer}
      isViewerPending={isPending}
      showHeader={HEADER_VIEWS.has(current.name)}
      activeTab={activeTab}
      itemCount={itemCount}
      onOpenProfile={() => {
        haptic('tap');
        push({ name: 'profile' });
      }}
      onSelectTab={(tab) => {
        haptic('selection');
        // Selecting a tab always resets the stack, so it doubles as the exit
        // from the profile and from a product page.
        resetTo({ name: tab });
      }}
      banner={!isTelegramEnvironment() ? <DevBanner /> : null}
    >
      {current.name === 'catalog' ? (
        <CatalogScreen
          onOpenProduct={(slug) => push({ name: 'product', slug })}
        />
      ) : null}

      {current.name === 'product' ? (
        <ProductScreen
          slug={current.slug}
          isSubscribedChannel={isSubscribedChannel}
          onGoToCart={() => push({ name: 'cart' })}
        />
      ) : null}

      {current.name === 'cart' ? (
        <CartScreen
          isSubscribedChannel={isSubscribedChannel}
          onContinueShopping={() => resetTo({ name: 'catalog' })}
          onOpenOrders={() => resetTo({ name: 'orders' })}
        />
      ) : null}

      {current.name === 'orders' ? (
        <OrdersScreen onContinueShopping={() => resetTo({ name: 'catalog' })} />
      ) : null}

      {current.name === 'profile' ? (
        <ProfileScreen viewer={viewer} isPending={isPending} />
      ) : null}
    </AppLayout>
  );
}

/** Visible only outside Telegram, to explain the limited functionality. */
function DevBanner() {
  return (
    <div className="dev-banner">
      Открыто вне Telegram: оплата недоступна, вход — только в dev-режиме.
    </div>
  );
}
