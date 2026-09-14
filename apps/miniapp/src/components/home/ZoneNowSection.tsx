import { useQuery } from '@tanstack/react-query';
import type { ZoneNowCard } from '@shop/shared';
import { api } from '../../api/client.ts';
import { haptic, openExternal } from '../../telegram/webapp.ts';

/**
 * Zone Now section: "Сейчас в ZONE"
 *
 * Editorial card showing what's currently happening: new products, updates,
 * temporary promotions, or other short messages from the shop.
 *
 * One horizontal card, not a banner and not a carousel. The content is now
 * server-driven and editable through the admin panel.
 */
export function ZoneNowSection() {
  const { data: content } = useQuery({
    queryKey: ['zone-now'],
    queryFn: () => api.getZoneNowCard(),
    staleTime: 5 * 60 * 1000,
  });

  if (!content) return null;

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
          {content.actionLabel && content.actionUrl ? (
            <button
              type="button"
              className="button button--ghost button--compact"
              onClick={() => {
                haptic('tap');
                if (content.actionUrl) openExternal(content.actionUrl);
              }}
            >
              {content.actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
