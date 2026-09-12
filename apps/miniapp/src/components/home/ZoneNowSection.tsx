import type { ZoneNowContent } from './types.ts';
import { haptic, openExternal } from '../../telegram/webapp.ts';

/**
 * Zone Now section: "Сейчас в ZONE"
 *
 * Editorial card showing what's currently happening: new products, updates,
 * temporary promotions, or other short messages from the shop.
 *
 * One horizontal card, not a banner and not a carousel. The content lives in
 * the frontend for now — when server-driven editorial is needed, this becomes
 * an API call.
 */
export function ZoneNowSection() {
  const content = getZoneNowContent();

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

/**
 * Zone Now content configuration.
 *
 * Lives in the frontend for now — a single featured message per deploy. When
 * server-driven editorial is needed, this becomes an API response and the
 * section component gets `content` as a prop instead of calling this function.
 */
function getZoneNowContent(): ZoneNowContent | null {
  return {
    title: 'Три способа оплаты',
    // No claim about fees: Telegram takes a cut of every Stars purchase, so
    // "без комиссий" was simply false. What is worth saying is that the price is
    // the same on every rail — the buyer picks by convenience, not by cost.
    text: 'Telegram Stars, карта или USDT — цена одна, выбирайте что удобнее.',
  };
}
