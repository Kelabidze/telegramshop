import type { ComponentType, ReactNode } from 'react';
import type { Viewer } from '@shop/shared';
import { CLUB_TIER_PERCENT, viewerDisplayName } from '@shop/shared';
import {
  IconCart,
  IconCatalog,
  IconFinance,
  IconLayers,
  IconModeShop,
  IconModeStaff,
  IconOrders,
  IconTarget,
  IconUsers,
  type IconProps,
} from './icons/index.tsx';

/**
 * Root frame: a persistent profile header on top, the tab bar at the bottom,
 * the current screen in between.
 *
 * Both bars live here rather than inside each screen so they are rendered once
 * and never remount on navigation — a remounting header flickers and, in the
 * case of the tab bar, drops the tap that caused the navigation.
 *
 * The header is hidden on secondary screens (product, profile): those are
 * pushed on top of a tab and get Telegram's BackButton instead, and showing a
 * "tap me to open the profile" strip while already in the profile would be a
 * dead control.
 */

export type TabName = 'catalog' | 'abuse' | 'cart' | 'orders';

/**
 * The tab slots keep their identity in both modes; only label, icon and content
 * change. Reusing the slots rather than adding staff-only tabs keeps the
 * navigation stack, the scroll keys and the back button logic untouched.
 *
 * The `abuse` slot exists in both modes because the section is edited along its
 * own axis — roots, their countries, and the country list — which does not fit
 * beside the category-shaped catalog screen.
 *
 * Its label is the full «Всё для абуза», not the shorthand it used to be: the
 * bar wraps a long label onto a second line rather than clipping it, and a tab
 * whose name matches the heading of the screen it opens needs no decoding. The
 * staff bar keeps a short label — its three neighbours are one word each, and
 * only one of the four sprouting a second line looks like a rendering fault.
 */
/**
 * Icons are components, not emoji.
 *
 * Emoji are rendered by the platform, so the same tab bar looked different on
 * iOS, Android and desktop, none of them matched the brand, and the active tab
 * could only be marked by colouring the text underneath. A stroked glyph
 * inherits `currentColor`, so active/inactive is one CSS rule and one asset.
 */
interface TabDefinition {
  name: TabName;
  label: string;
  Icon: ComponentType<IconProps>;
}

const SHOPPER_TABS: ReadonlyArray<TabDefinition> = [
  { name: 'catalog', label: 'Каталог', Icon: IconCatalog },
  { name: 'abuse', label: 'Всё для абуза', Icon: IconTarget },
  { name: 'cart', label: 'Корзина', Icon: IconCart },
  { name: 'orders', label: 'Заказы', Icon: IconOrders },
];

const STAFF_TABS: ReadonlyArray<TabDefinition> = [
  { name: 'catalog', label: 'Каталог', Icon: IconLayers },
  { name: 'abuse', label: 'Абуз', Icon: IconTarget },
  { name: 'cart', label: 'Люди', Icon: IconUsers },
  { name: 'orders', label: 'Финансы', Icon: IconFinance },
];

export function AppLayout({
  viewer,
  isViewerPending,
  showHeader,
  activeTab,
  itemCount,
  isStaffMode,
  canUseStaffMode,
  onToggleStaffMode,
  onOpenProfile,
  onSelectTab,
  banner,
  children,
}: {
  viewer: Viewer | null;
  isViewerPending: boolean;
  showHeader: boolean;
  activeTab: TabName;
  itemCount: number;
  isStaffMode: boolean;
  canUseStaffMode: boolean;
  onToggleStaffMode: () => void;
  onOpenProfile: () => void;
  onSelectTab: (tab: TabName) => void;
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`app-shell${isStaffMode ? ' app-shell--staff' : ''}`}>
      {banner}

      {/*
        The switch lives in the header strip, above the content: it changes what
        every tab means, so it cannot sit inside one of them.
      */}
      {canUseStaffMode ? (
        <button
          type="button"
          className="staff-switch"
          onClick={onToggleStaffMode}
          aria-pressed={isStaffMode}
        >
          <span className="staff-switch__icon">
            {isStaffMode ? <IconModeStaff /> : <IconModeShop />}
          </span>
          <span className="staff-switch__text">
            {isStaffMode ? 'Режим управления' : 'Режим покупателя'}
          </span>
          <span className="staff-switch__action">
            {isStaffMode ? 'В магазин' : 'В управление'}
          </span>
        </button>
      ) : null}

      {showHeader && !isStaffMode ? (
        <ProfileHeader
          viewer={viewer}
          isPending={isViewerPending}
          onClick={onOpenProfile}
        />
      ) : null}

      <main className="app-shell__content">{children}</main>

      <TabBar
        tabs={isStaffMode ? STAFF_TABS : SHOPPER_TABS}
        active={activeTab}
        // The cart badge is meaningless over a staff screen called "Люди".
        itemCount={isStaffMode ? 0 : itemCount}
        onSelect={onSelectTab}
      />
    </div>
  );
}

/**
 * Top strip: avatar and name, tappable to open the profile.
 *
 * `viewer` is null when `/api/me` failed — outside Telegram, or with an expired
 * signature. That is not worth an error state: the catalog is public and must
 * keep working, so the name falls back to a neutral greeting.
 */
function ProfileHeader({
  viewer,
  isPending,
  onClick,
}: {
  viewer: Viewer | null;
  isPending: boolean;
  onClick: () => void;
}) {
  if (isPending) {
    return (
      <div className="app-header" aria-hidden="true">
        <div className="skeleton app-header__avatar-skeleton" />
        <div className="stack" style={{ gap: 6, flex: 1 }}>
          <div className="skeleton skeleton--text" style={{ width: '55%' }} />
          <div
            className="skeleton skeleton--text skeleton--text-sm"
            style={{ width: '35%' }}
          />
        </div>
      </div>
    );
  }

  // The shop-local name wins over the Telegram one: a user who renamed
  // themselves must not keep seeing the old name in the header.
  const name = viewer ? viewerDisplayName(viewer) : '';
  // An initial instead of a photo: `photo_url` is absent on several clients and
  // platforms, and a broken image looks worse than a letter.
  const initial = name ? [...name][0] : '👋';

  return (
    <button type="button" className="app-header" onClick={onClick}>
      <span className="app-header__avatar" aria-hidden="true">
        {initial}
      </span>
      <span className="app-header__text">
        <span className="app-header__name">
          {name ? `Привет, ${name}` : 'Привет'}
        </span>
        <span className="app-header__caption">
          {viewer?.isSubscribedChannel
            ? `Клубный тариф ${CLUB_TIER_PERCENT}% активирован`
            : 'Профиль и настройки'}
        </span>
      </span>
      <span className="app-header__chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

function TabBar({
  tabs,
  active,
  itemCount,
  onSelect,
}: {
  tabs: ReadonlyArray<TabDefinition>;
  active: TabName;
  itemCount: number;
  onSelect: (tab: TabName) => void;
}) {
  return (
    <nav className="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.name}
          type="button"
          className="tab-bar__item"
          aria-current={active === tab.name ? 'page' : undefined}
          onClick={() => onSelect(tab.name)}
        >
          <span className="tab-bar__icon">
            <tab.Icon />
            {tab.name === 'cart' && itemCount > 0 ? (
              <span className="tab-bar__badge">{itemCount}</span>
            ) : null}
          </span>
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
