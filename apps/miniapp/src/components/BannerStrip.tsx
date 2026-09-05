import type { Banner } from '@shop/shared';
import { bannerCategorySlug } from '@shop/shared';
import { haptic, openExternal } from '../telegram/webapp.ts';

/**
 * Promo strip above the catalog.
 *
 * Renders nothing at all when there are no banners — not a placeholder, not an
 * empty box. A reserved gap on the first screen would cost the products the
 * space the banners were supposed to earn.
 *
 * Two banners side by side, because that is what fits above the fold next to a
 * slimmer category row. The server already caps the list at two, so this
 * component does not have to decide what to drop.
 */
export function BannerStrip({
  banners,
  onOpenCategory,
}: {
  banners: Banner[];
  onOpenCategory: (slug: string) => void;
}) {
  if (banners.length === 0) return null;

  return (
    <div className="banner-strip">
      {banners.map((banner) => (
        <BannerCard
          key={banner.id}
          banner={banner}
          onOpenCategory={onOpenCategory}
        />
      ))}
    </div>
  );
}

function BannerCard({
  banner,
  onOpenCategory,
}: {
  banner: Banner;
  onOpenCategory: (slug: string) => void;
}) {
  const categorySlug = bannerCategorySlug(banner.linkUrl);
  const isInteractive = banner.linkUrl !== null;

  const content = (
    <>
      {banner.imageUrl ? (
        <img
          className="banner-card__media"
          src={banner.imageUrl}
          alt=""
          loading="lazy"
        />
      ) : null}
      <span className="banner-card__body">
        <span className="banner-card__title">{banner.title}</span>
        {banner.subtitle ? (
          <span className="banner-card__subtitle">{banner.subtitle}</span>
        ) : null}
      </span>
    </>
  );

  // A decorative banner is a plain div: rendering it as a button would promise a
  // tap that does nothing, and screen readers would announce a dead control.
  if (!isInteractive) {
    return <div className="banner-card">{content}</div>;
  }

  return (
    <button
      type="button"
      className="banner-card banner-card--tappable"
      onClick={() => {
        haptic('tap');
        // An in-app target filters the catalog instead of leaving the Mini App:
        // sending someone out of the shop to see more of the shop is a loss.
        if (categorySlug) {
          onOpenCategory(categorySlug);
          return;
        }
        if (banner.linkUrl) openExternal(banner.linkUrl);
      }}
    >
      {content}
    </button>
  );
}
