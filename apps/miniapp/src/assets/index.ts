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
 * Decoration used as a CSS background, mounted behind the profile hero at 10%
 * opacity as the brand's one signature flourish.
 *
 * Only the tentacle arc is kept. The pack's `grid`, `noise`, `glow` and
 * `suction-row` are texture, and this interface is already dark surfaces with
 * hairline borders — a noise layer over every screen is decoration for its own sake,
 * and it costs a repaint on scroll.
 */
export const decor = { tentacleArc } as const;

/**
 * Category icons, keyed by the slug they illustrate.
 *
 * Slugs come from the database, so this map is a lookup with a fallback rather than a
 * required mapping: staff can add a category at any time and it must still render.
 * Keys cover both the seeded slugs and the ones the asset pack was drawn for.
 */
export const categoryIcons: Record<string, string> = {
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
