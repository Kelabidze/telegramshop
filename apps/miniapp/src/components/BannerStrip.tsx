import type { Banner } from '@shop/shared';
import { bannerCategorySlug } from '@shop/shared';
import { haptic, openExternal } from '../telegram/webapp.ts';

/**
 * Promo banners above a storefront section.
 *
 * Renders nothing at all when there are no banners — not a placeholder, not an
 * empty box. A reserved gap on the first screen would cost the products the
 * space the banners were supposed to earn.
 *
 * The server already caps the list per section, so this component does not have
 * to decide what to drop.
 */
export function BannerStrip({
  banners,
  shape = 'strip',
  onOpenCategory,
}: {
  banners: Banner[];
  /**
   * `strip` is the 16:9 poster above the catalog; `square` is the full-width 1:1
   * frame «Всё для абуза» leads with. A prop rather than a second component:
   * only the frame differs, and the tap behaviour must not.
   */
  shape?: 'strip' | 'square';
  onOpenCategory: (slug: string) => void;
}) {
  if (banners.length === 0) return null;

  return (
    <div
      className={`banner-strip${shape === 'square' ? ' banner-strip--square' : ''}`}
    >
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

  // Without artwork the framed box would be mostly empty space.
  const shape = banner.imageUrl ? 'banner-card' : 'banner-card banner-card--plain';

  // A decorative banner is a plain div: rendering it as a button would promise a
  // tap that does nothing, and screen readers would announce a dead control.
  if (!isInteractive) {
    return <div className={shape}>{content}</div>;
  }

  return (
    <button
      type="button"
      className={`${shape} banner-card--tappable`}
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
