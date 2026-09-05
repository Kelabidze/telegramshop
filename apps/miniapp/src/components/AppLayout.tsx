import type { ReactNode } from 'react';
import type { Viewer } from '@shop/shared';
import { CLUB_TIER_PERCENT, viewerDisplayName } from '@shop/shared';

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

export type TabName = 'catalog' | 'cart' | 'orders';

/**
 * The three tabs keep their identity in both modes; only their label, icon and
 * content change. Reusing the slots rather than adding staff-only tabs keeps the
 * navigation stack, the scroll keys and the back button logic untouched.
 */
const SHOPPER_TABS: ReadonlyArray<{ name: TabName; label: string; icon: string }> = [
  { name: 'catalog', label: 'Каталог', icon: '🛍' },
  { name: 'cart', label: 'Корзина', icon: '🛒' },
  { name: 'orders', label: 'Заказы', icon: '📦' },
];

const STAFF_TABS: ReadonlyArray<{ name: TabName; label: string; icon: string }> = [
  { name: 'catalog', label: 'Каталог', icon: '🗂' },
  { name: 'cart', label: 'Люди', icon: '👥' },
  { name: 'orders', label: 'Финансы', icon: '💰' },
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
          <span className="staff-switch__icon" aria-hidden="true">
            {isStaffMode ? '🛠' : '🛍'}
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
  tabs: ReadonlyArray<{ name: TabName; label: string; icon: string }>;
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
            {tab.icon}
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
