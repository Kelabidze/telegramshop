/**
 * Every brand asset, in one place.
 *
 * Imported rather than referenced by string path so Vite fingerprints each file and
 * a rename becomes a build error instead of a silent 404 in production. The one
 * exception is the favicon, which lives in `public/` because `index.html` needs a
 * fixed URL before any JavaScript runs.
 *
 * Only assets the app actually renders belong here. Banner artwork is uploaded
 * through Admin/Media and lives in the database, so the hero images that ship with
 * the asset pack are deliberately absent: hard-coding them would bypass the media
 * pipeline and put two 750 KB PNGs into the bundle for artwork that staff are meant
 * to be able to change.
 */

import emptyCart from './illustrations/empty-cart.svg';
import emptyOrders from './illustrations/empty-orders.svg';
import emptySearch from './illustrations/empty-search.svg';
import errorArt from './illustrations/error.svg';
import lockedArt from './illustrations/locked.svg';

import mark from './logo/mark.svg';

import tentacleArc from './decorations/tentacle-arc.svg';

import iconAccess from './icons/access.svg';
import iconApp from './icons/app.svg';
import iconCrypto from './icons/crypto.svg';
import iconGames from './icons/games.svg';
import iconGift from './icons/gift.svg';
import iconOther from './icons/other.svg';
import iconSoftware from './icons/software.svg';
import iconWeb from './icons/web.svg';

/** Illustrations for the empty and error states. */
export const emptyArt = {
  cart: emptyCart,
  orders: emptyOrders,
  search: emptySearch,
  error: errorArt,
  locked: lockedArt,
} as const;

/**
 * The mark. Also the favicon, copied to `public/favicon.svg` because `index.html`
 * needs it at a fixed URL before any JavaScript runs.
 *
 * `logo/wordmark.svg` from the pack is deliberately not here: it sets its letters
 * with `<text font-family="Arial Black">`, and an SVG loaded through `<img>` is an
 * isolated document that cannot see the app's fonts — with Arial Black absent on
 * both Android and iOS, the name would render in whatever each platform substitutes.
 * The wordmark is CSS type instead (`.brand-signature__wordmark`).
 */
export const brand = { mark } as const;

/**
 * Decoration used as a CSS background: the brand's signature flourish, mounted in
 * exactly two places — behind the profile hero and inside Home's «Сейчас в ZONE» card,
 * both clipped by their container and under 0.2 opacity.
 *
 * Only the tentacle arc is kept. The pack's `grid`, `noise`, `glow` and `suction-row`
 * are texture, and this interface is already dark surfaces with hairline borders — a
 * noise layer over every screen is decoration for its own sake, and it costs a repaint
 * on scroll. `glow` in particular is a radial magenta gradient, which is a thing CSS
 * already does natively in the three places that need it, without an HTTP request.
 */
export const decor = { tentacleArc } as const;

/**
 * Category icons, keyed by the slug they illustrate. Read through `categoryIcon()`,
 * never directly — the exported function is what supplies the fallbacks.
 *
 * Explicit matches only. Covers the seeded catalogue, the live one, and the slugs the
 * pack was drawn for — three sets, because all three exist and a key that matches none
 * of them is a tile that falls back for no reason.
 */
const CATEGORY_ICON_BY_SLUG: Record<string, string> = {
  // Live catalogue. Absent before, which is why none of these tiles used an icon.
  giftcards: iconGift,
  aibuy: iconWeb,
  cards: iconOther,
  // Seeded catalogue (apps/api/src/cli/seed.ts).
  'appstore-cards': iconApp,
  'digital-cards': iconGift,
  ai: iconWeb,
  tools: iconSoftware,
  templates: iconOther,
  courses: iconAccess,
  // Slugs the pack names directly.
  'gift-codes': iconGift,
  games: iconGames,
  'app-store': iconApp,
  crypto: iconCrypto,
  software: iconSoftware,
  access: iconAccess,
  web: iconWeb,
  other: iconOther,
};

/**
 * Keyword net behind the slug map, matched against slug and title.
 *
 * Categories are staff-editable rows, so an exact map is guaranteed to go stale: the
 * live catalogue already used three slugs that no key named, and every tile silently
 * fell through to a platform emoji — the eight approved icons shipped in the bundle
 * and rendered nowhere.
 *
 * **Order is the rule, not a detail.** The first match wins, so anything whose name
 * contains a narrower word has to come first: «Подарочные карты» contains «карт», and
 * the slug `giftcards` contains `cards`, so gift is tested before cards or the pack's
 * gift icon would never appear on the one category it was drawn for.
 */
const CATEGORY_ICON_BY_KEYWORD: ReadonlyArray<readonly [readonly string[], string]> = [
  [['gift', 'подарок', 'подарочн', 'сертификат'], iconGift],
  [['appstore', 'app-store', 'itunes', 'google play', 'play market'], iconApp],
  [['game', 'игр', 'steam', 'xbox', 'playstation'], iconGames],
  [['crypto', 'крипт', 'usdt', 'bitcoin', 'кошел'], iconCrypto],
  [['нейросет', 'chatgpt', 'gpt', 'онлайн', 'сервис', 'web', 'сайт'], iconWeb],
  [['software', 'soft', 'софт', 'программ', 'подписк', 'инструмент'], iconSoftware],
  [['access', 'доступ', 'аккаунт', 'account', 'курс', 'course'], iconAccess],
  [['card', 'карт'], iconOther],
];

/**
 * The icon for a category.
 *
 * Never null. The last resort is the pack's own `other.svg`, not the emoji staff
 * chose, because the picker is read as a set: one colour emoji among line glyphs is
 * the tile that looks broken, and «прочее» is exactly what that file was drawn for.
 * The emoji stays the source of truth for the category in the admin panel — it is
 * just not what the storefront paints.
 */
export function categoryIcon(category: {
  slug: string;
  title: string;
}): string {
  const exact = CATEGORY_ICON_BY_SLUG[category.slug.toLowerCase()];
  if (exact) return exact;

  const haystack = `${category.slug} ${category.title}`.toLowerCase();
  for (const [keywords, icon] of CATEGORY_ICON_BY_KEYWORD) {
    if (keywords.some((word) => haystack.includes(word))) return icon;
  }
  return iconOther;
}
