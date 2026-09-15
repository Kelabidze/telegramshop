import { useQuery } from '@tanstack/react-query';
import { bannerCategorySlug } from '@shop/shared';
import { api } from '../../api/client.ts';
import { haptic, openExternal } from '../../telegram/webapp.ts';

/**
 * Zone Now section: "Сейчас в ZONE"
 *
 * Editorial card showing what's currently happening: new products, updates,
 * temporary promotions, or other short messages from the shop.
 *
 * One horizontal card, not a banner and not a carousel. The content is
 * server-driven and editable through the admin panel.
 */
export function ZoneNowSection({
  onOpenCategory,
}: {
  /** In-app target for a `category:slug` action, same contract as a banner tap. */
  onOpenCategory: (slug: string) => void;
}) {
  const { data: content } = useQuery({
    queryKey: ['zone-now'],
    queryFn: () => api.getZoneNowCard(),
    staleTime: 5 * 60 * 1000,
    // Editorial copy is never worth an error screen: the products below it are
    // the point of the page.
    retry: false,
  });

  if (!content) return null;

  const { actionLabel, actionUrl } = content;
  const categorySlug = actionUrl ? bannerCategorySlug(actionUrl) : null;

  return (
    <section className="home-section">
      <h2 className="section-title">Сейчас в ZONE</h2>
      <div className="zone-now-card">
        {content.imageUrl ? (
          <div className="zone-now-card__media">
            <img
              src={content.imageUrl}
              alt=""
              className="zone-now-card__image"
              loading="lazy"
            />
          </div>
        ) : null}
        <div className="zone-now-card__body">
          <h3 className="zone-now-card__title">{content.title}</h3>
          <p className="zone-now-card__text">{content.text}</p>
          {actionLabel && actionUrl ? (
            <button
              type="button"
              className="button button--ghost button--compact"
              onClick={() => {
                haptic('tap');
                /*
                 * An in-app target filters the catalog instead of leaving the Mini
                 * App — the same rule `BannerStrip` follows. Sending someone out of
                 * the shop to see more of the shop is a loss, and `openExternal`
                 * cannot resolve a relative path anyway: it would simply do nothing.
                 */
                if (categorySlug) {
                  onOpenCategory(categorySlug);
                  return;
                }
                openExternal(actionUrl);
              }}
            >
              {actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
