/**
 * Tab bar and mode-switch icons.
 *
 * Hand-written components rather than imported `.svg` files, for one reason:
 * `currentColor`. The tab bar expresses active/inactive by colour, so a single
 * set of paths inherits `--zone-magenta` or `--zone-text-muted` from CSS. Two
 * exported files per state would need two assets per icon and would drift apart
 * the first time one of them was edited.
 *
 * Drawing rules, so the set stays coherent as it grows:
 *   - 24-unit viewBox, rendered at 20px, which is the size that has to read
 *   - stroke only, 1.75 units, round caps and joins
 *   - no fills, no gradients, no detail that disappears below 20px
 *   - geometry on the same grid: 3-unit margins, shapes centred
 *
 * The single `Glyph` wrapper is what enforces those numbers. Individual icons
 * contribute paths and nothing else.
 */
import type { ReactNode, SVGProps } from 'react';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox'>;

/**
 * Shared frame. `aria-hidden` by default because every icon in this app sits
 * beside its own text label — announcing it again is noise for a screen reader.
 */
function Glyph({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Shopper: catalogue. A shop tote — the storefront, not a generic grid. */
export function IconCatalog(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 8h16l-1.2 11.2a1.6 1.6 0 0 1-1.6 1.4H6.8a1.6 1.6 0 0 1-1.6-1.4Z" />
      <path d="M9 8V6.2a3 3 0 0 1 6 0V8" />
    </Glyph>
  );
}

/**
 * Shopper and staff: «Всё для абуза». Concentric rings around a centre point.
 *
 * Replaces 🎯 and keeps the same reading. A crosshair was the alternative and
 * was rejected: it turns the tab into weapon iconography, which is exactly the
 * generic-gaming register the brand is avoiding.
 */
export function IconTarget(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="3.6" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Shopper: cart. Carries the item-count badge, so the basket stays open. */
export function IconCart(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.4 4.4h1.9a1 1 0 0 1 1 .8L8.6 15a1.6 1.6 0 0 0 1.6 1.3h7.2a1.6 1.6 0 0 0 1.55-1.2l1.35-5.3H6.6" />
      <circle cx="10.4" cy="19.6" r="1.3" />
      <circle cx="17.6" cy="19.6" r="1.3" />
    </Glyph>
  );
}

/** Shopper: orders. A sealed parcel — delivered goods, not a folder. */
export function IconOrders(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20.4 8.2v7.6a1.6 1.6 0 0 1-.83 1.4l-6.8 3.6a1.6 1.6 0 0 1-1.54 0l-6.8-3.6a1.6 1.6 0 0 1-.83-1.4V8.2" />
      <path d="M3.6 8.2 11.23 4.2a1.6 1.6 0 0 1 1.54 0L20.4 8.2 12.77 12.2a1.6 1.6 0 0 1-1.54 0Z" />
      <path d="M12 12.4v8.2" />
    </Glyph>
  );
}

/**
 * Staff: catalogue management. Stacked layers rather than the shopper tote —
 * the same tab slot, but editing records instead of browsing a shop.
 */
export function IconLayers(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.4 3.6 7.6 12 11.8l8.4-4.2Z" />
      <path d="M3.6 12.2 12 16.4l8.4-4.2" />
      <path d="M3.6 16.6 12 20.8l8.4-4.2" />
    </Glyph>
  );
}

/** Staff: people. Two figures, the second reduced so it survives 20px. */
export function IconUsers(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="9.6" cy="8.4" r="3.4" />
      <path d="M3.6 20.2a6 6 0 0 1 12 0" />
      <path d="M16.4 5.4a3.4 3.4 0 0 1 0 6" />
      <path d="M17.6 14.8a6 6 0 0 1 2.8 5.4" />
    </Glyph>
  );
}

/**
 * Staff: finance. A card with its magnetic stripe.
 *
 * Not a coin stack and not a currency sign: the shop is priced in Telegram Stars
 * as well as fiat, so a ₽ or $ glyph would state something false.
 */
export function IconFinance(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2.4" />
      <path d="M2.8 10.2h18.4" />
      <path d="M6.6 14.6h3.6" />
    </Glyph>
  );
}

/** Mode switch, shopper side. Matches the catalogue tab on purpose. */
export function IconModeShop(props: IconProps) {
  return <IconCatalog {...props} />;
}

/** Mode switch, staff side. Sliders: settings, not a literal wrench. */
export function IconModeStaff(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 6.6h14" />
      <path d="M5 12h14" />
      <path d="M5 17.4h14" />
      <circle cx="9.2" cy="6.6" r="1.8" />
      <circle cx="15.4" cy="12" r="1.8" />
      <circle cx="8" cy="17.4" r="1.8" />
    </Glyph>
  );
}

/**
 * Product artwork of last resort: no uploaded image, no emoji on the record.
 *
 * A quiet picture frame, not brand graphics. Invented decoration in place of
 * missing artwork is what makes a catalogue look like an unfinished template,
 * and the OCHKISK mark that will eventually live here does not exist yet. Larger
 * than the tab icons and thinner-stroked, because it is rendered at 40-64px.
 */
export function IconMediaPlaceholder(props: IconProps) {
  return (
    <svg
      width={44}
      height={44}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.4" />
      <circle cx="9" cy="10.2" r="1.6" />
      <path d="M4.4 17.2l4.3-4.1a1.6 1.6 0 0 1 2.2 0l3 2.9" />
      <path d="M14.2 14.4l1.6-1.5a1.6 1.6 0 0 1 2.2 0l2.4 2.3" />
    </svg>
  );
}
