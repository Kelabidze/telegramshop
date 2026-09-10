import type { Banner } from '@shop/shared';
import { BannerStrip } from '../BannerStrip.tsx';

/**
 * Promo banners section.
 *
 * Two promotional cards at the top of Home. Uses the existing BannerStrip
 * component and banner system — no new backend needed.
 *
 * Gracefully degrades when fewer than two banners are available: shows what
 * exists, never leaves empty slots.
 */
export function PromoBannersSection({
  banners,
  onOpenCategory,
}: {
  banners: Banner[];
  onOpenCategory: (slug: string) => void;
}) {
  // BannerStrip already renders nothing when the list is empty, so the section
  // disappears cleanly when there are no banners.
  return (
    <BannerStrip
      banners={banners.slice(0, 2)}
      shape="strip"
      onOpenCategory={onOpenCategory}
    />
  );
}
