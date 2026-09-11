import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCart, selectItemCount } from './store/cart.ts';
import { useStaffMode } from './store/staffMode.ts';
import { useViewer } from './api/useViewer.ts';
import { useBackButton } from './telegram/buttons.ts';
import { haptic, isTelegramEnvironment } from './telegram/webapp.ts';
import { AppLayout, type TabName } from './components/AppLayout.tsx';
import { HomeScreen } from './screens/HomeScreen.tsx';
import { CatalogScreen } from './screens/CatalogScreen.tsx';
import { AbuseScreen } from './screens/AbuseScreen.tsx';
import { ProductScreen } from './screens/ProductScreen.tsx';
import { CartScreen } from './screens/CartScreen.tsx';
import { CryptoPaymentScreen } from './screens/CryptoPaymentScreen.tsx';
import { OrdersScreen } from './screens/OrdersScreen.tsx';
import { ProfileScreen } from './screens/ProfileScreen.tsx';
import { AdminCatalogScreen } from './screens/admin/AdminCatalogScreen.tsx';
import { AdminAbuseScreen } from './screens/admin/AdminAbuseScreen.tsx';
import { AdminUsersScreen } from './screens/admin/AdminUsersScreen.tsx';
import { AdminFinanceScreen } from './screens/admin/AdminFinanceScreen.tsx';

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
  /**
   * The full listing. `category` is where Home's picker hands over its choice:
   * the tile promises a filtered catalog, and dropping the slug on the way there
   * would land the user on «Все товары» with nothing to explain why.
   */
  | { name: 'catalog'; category?: string | null }
  | { name: 'abuse' }
  | { name: 'product'; slug: string }
  | { name: 'cart' }
  | { name: 'orders' }
  | { name: 'profile' }
  | { name: 'home' }
  /** Waiting for an on-chain payment. Carries the order it settles. */
  | { name: 'crypto-payment'; orderId: string };

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
    case 'home':
      return 'catalog';
    case 'catalog':
      return 'catalog';
    case 'abuse':
      return 'abuse';
    // A product can be opened from either listing, so it keeps whichever tab was
    // lit rather than always claiming the catalog.
    case 'product':
      return fallback;
    case 'cart':
      return 'cart';
    case 'orders':
      return 'orders';
    // Reached from the cart, and the payment it is waiting for belongs to an
    // order — either tab is defensible, and Orders is where the buyer goes next.
    case 'crypto-payment':
      return 'orders';
    case 'profile':
      return fallback;
  }
}

/**
 * Resolves a view against the mode that is actually rendering it.
 *
 * Only `home` needs this. Every other entry in the stack means the same thing in
 * both modes, because the tab slots keep their identity across the staff remap —
 * `cart` is the slot, "Корзина" or "Люди" is only its label.
 *
 * `home` has no staff counterpart: staff mode turns the four slots into admin
 * screens and has no editorial hub. Mapping it onto the catalog slot is what
 * keeps a stack that says `home` renderable in staff mode.
 */
function resolveView(view: View, isStaffMode: boolean): View {
  return isStaffMode && view.name === 'home' ? { name: 'catalog' } : view;
}

/**
 * The screen a tab resets to.
 *
 * The catalog slot holds two screens in shopper mode: `home` is its root, and
 * the full listing is reached from inside it. So the slot's root is not the tab
 * name, and everything that compares "am I already on this tab?" has to ask this
 * function rather than the tab name — otherwise the listing reports itself as
 * the root and the tab stops being a way back out of it.
 */
function rootViewForTab(tab: TabName, isStaffMode: boolean): View {
  return tab === 'catalog' && !isStaffMode ? { name: 'home' } : { name: tab };
}

/** Screens that keep the profile header visible. */
const HEADER_VIEWS = new Set<View['name']>([
  'home',
  'catalog',
  'abuse',
  'cart',
  'orders',
]);

export function App() {
  const [stack, setStack] = useState<View[]>([{ name: 'home' }]);
  const current = stack[stack.length - 1] ?? { name: 'home' };
  const itemCount = useCart(selectItemCount);
  const { viewer, isPending, isSubscribedChannel } = useViewer();

  const staffModeEnabled = useStaffMode((s) => s.enabled);
  const toggleStaffMode = useStaffMode((s) => s.toggle);
  /**
   * Staff mode is the persisted flag AND the live role, never the flag alone.
   *
   * The flag survives in localStorage, but `/api/me` arrives later and can fail.
   * Trusting the flag on its own would paint the admin screens for a buyer (or
   * for a demoted admin) until the profile landed — the API would refuse every
   * call behind them, but showing them at all is wrong.
   */
  const canUseStaffMode = viewer?.role === 'ADMIN';
  const isStaffMode = canUseStaffMode && staffModeEnabled;

  /**
   * What staff mode actually renders.
   *
   * The stack can hold `home` while staff mode is on — `/api/me` decides the mode
   * and lands after the first render, so an admin returning with the persisted
   * flag starts on the shopper root and gets switched underneath it. Staff mode
   * has no `home` branch, so without this remap every one of its four `current
   * .name === …` checks missed and the content area rendered empty: a tab bar and
   * a mode switch over nothing, which is exactly what "admin is broken" looked
   * like. Same blank on the way back from the profile, whose stack entry below it
   * is `home`.
   */
  const view = resolveView(current, isStaffMode);

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
        // The tab under the profile: the entry below it in the stack, or home
        // when the profile is the only screen left.
        tabForView(stack[stack.length - 2] ?? { name: 'home' }, 'catalog'),
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
      isStaffMode={isStaffMode}
      canUseStaffMode={canUseStaffMode}
      onToggleStaffMode={() => {
        haptic('selection');
        toggleStaffMode();
        // Back to the first tab: staying on "Финансы" while switching to the
        // shopper view would land on Orders, which is a different screen than
        // the one that was on display.
        //
        // The root differs per mode, and the mode here is the one being switched
        // *to*: staff has no `home`, the shopper catalog tab starts on it.
        resetTo(rootViewForTab('catalog', !isStaffMode));
      }}
      onOpenProfile={() => {
        haptic('tap');
        push({ name: 'profile' });
      }}
      onSelectTab={(tab) => {
        haptic('selection');
        // Tapping the tab you are already on scrolls to the top, the way native
        // tab bars behave. Without it a restored offset would be a trap: there
        // would be no way back to the top but dragging.
        //
        // Compared against the slot's root rather than the tab name, because the
        // shopper catalog slot has two screens: on the full listing this is a tap
        // back to Home, not a scroll to the top of the page you are on.
        const root = rootViewForTab(tab, isStaffMode);
        if (view.name === root.name) {
          // The scroll listener in `useScrollRestoration` records 0 right after
          // this, so the screen also stops trying to restore the old offset.
          window.scrollTo(0, 0);
          return;
        }
        // Selecting a tab always resets the stack, so it doubles as the exit
        // from the profile and from a product page.
        resetTo(root);
      }}
      banner={!isTelegramEnvironment() ? <DevBanner /> : null}
    >
      {/*
        Staff mode reuses the three tab slots rather than adding new ones, so the
        stack, the scroll keys and the back button need no special cases.
      */}
      {isStaffMode ? (
        <>
          {view.name === 'catalog' ? <AdminCatalogScreen /> : null}
          {view.name === 'abuse' ? <AdminAbuseScreen /> : null}
          {view.name === 'cart' ? <AdminUsersScreen /> : null}
          {view.name === 'orders' ? <AdminFinanceScreen /> : null}
          {view.name === 'profile' ? (
            <ProfileScreen viewer={viewer} isPending={isPending} />
          ) : null}
        </>
      ) : (
        <>
          {view.name === 'home' ? (
            <HomeScreen
              isSubscribedChannel={isSubscribedChannel}
              onOpenProduct={(slug) => push({ name: 'product', slug })}
              onOpenCategory={(slug) => push({ name: 'catalog', category: slug })}
              onOpenCatalog={() => push({ name: 'catalog' })}
            />
          ) : null}

          {view.name === 'catalog' ? (
            <CatalogScreen
              initialCategory={view.category ?? null}
              isSubscribedChannel={isSubscribedChannel}
              onOpenProduct={(slug) => push({ name: 'product', slug })}
            />
          ) : null}

          {view.name === 'abuse' ? (
            <AbuseScreen
              isSubscribedChannel={isSubscribedChannel}
              onOpenProduct={(slug) => push({ name: 'product', slug })}
            />
          ) : null}

          {view.name === 'product' ? (
            <ProductScreen
              slug={view.slug}
              isSubscribedChannel={isSubscribedChannel}
              onGoToCart={() => push({ name: 'cart' })}
            />
          ) : null}

          {view.name === 'cart' ? (
            <CartScreen
              isSubscribedChannel={isSubscribedChannel}
              onContinueShopping={() => resetTo({ name: 'home' })}
              onOpenOrders={() => resetTo({ name: 'orders' })}
              // `resetTo`, not `push`: the cart has been cleared and the order
              // exists, so going "back" into the cart would show an empty screen
              // for a payment that is still waiting.
              onOpenCryptoPayment={(orderId) =>
                resetTo({ name: 'crypto-payment', orderId })
              }
            />
          ) : null}

          {view.name === 'crypto-payment' ? (
            <CryptoPaymentScreen
              orderId={view.orderId}
              onDone={() => resetTo({ name: 'orders' })}
              onBackToCatalog={() => resetTo({ name: 'home' })}
            />
          ) : null}

          {view.name === 'orders' ? (
            <OrdersScreen onContinueShopping={() => resetTo({ name: 'home' })} />
          ) : null}

          {view.name === 'profile' ? (
            <ProfileScreen viewer={viewer} isPending={isPending} />
          ) : null}
        </>
      )}
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
