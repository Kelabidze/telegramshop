import {
  CLUB_TIER_PERCENT,
  effectiveUnitMinor,
  formatMoney,
  type Currency,
} from '@shop/shared';
import { openChannel, showAlert, showConfirm } from '../telegram/webapp.ts';

/**
 * Club tier notices.
 *
 * Two states, one component: an invitation for a viewer who is not in the
 * channel, a confirmation for one who is. Both carry the ℹ️ affordance and
 * explain the offer in a popup rather than in a wall of small print.
 */
export function ClubTierNotice({
  isSubscribedChannel,
  variant,
  tierAdjustmentMinor,
  currency,
}: {
  isSubscribedChannel: boolean;
  /** `product` sits above the action button; `cart` above the total. */
  variant: 'product' | 'cart';
  /** What the club tier is worth on this cart. Omitted on a product page. */
  tierAdjustmentMinor?: number;
  currency?: Currency | null;
}) {
  // Naming the sum beats naming the rate, but only when there is a sum to name:
  // on a 1-star item the club tier rounds to nothing, and "сохранить 0 ⭐" is an
  // argument against subscribing.
  const savings =
    tierAdjustmentMinor && tierAdjustmentMinor > 0 && currency
      ? formatMoney(tierAdjustmentMinor, currency)
      : null;

  if (isSubscribedChannel) {
    return (
      <button
        type="button"
        className="club-notice club-notice--active"
        onClick={() =>
          showAlert(
            `Клубный тариф ${CLUB_TIER_PERCENT}% активирован: вы подписаны на канал, ` +
              'и цены в приложении уже учитывают скидку.',
          )
        }
      >
        <span className="club-notice__text">
          Клубный тариф {CLUB_TIER_PERCENT}% активирован
        </span>
        <span className="club-notice__icon" aria-hidden="true">
          ℹ️
        </span>
      </button>
    );
  }

  const text =
    variant === 'product'
      ? `Получите клубную выгоду ${CLUB_TIER_PERCENT}%`
      : savings
        ? `Вы можете сохранить ${savings}`
        : `Вы можете сохранить ${CLUB_TIER_PERCENT}%`;

  const offer =
    variant === 'product'
      ? `Подпишитесь на наш канал для скидки ${CLUB_TIER_PERCENT}% по клубному тарифу!`
      : 'Оформите подписку на канал, чтобы активировать клубный тариф ' +
        `и получить скидку ${CLUB_TIER_PERCENT}% на этот заказ.`;

  return (
    <button
      type="button"
      className="club-notice"
      onClick={() => {
        // The popup carries the channel link, and confirming opens it: showing
        // the offer without a way to accept it would make the ℹ️ a dead end.
        // Asked rather than opened straight away — leaving the app unannounced
        // mid-purchase is how a cart gets abandoned.
        const link = openChannel.url();
        if (!link) {
          showAlert(offer);
          return;
        }
        void showConfirm(`${offer}\n\n${link}\n\nОткрыть канал?`).then((ok) => {
          if (ok) openChannel.open();
        });
      }}
    >
      <span className="club-notice__text">{text}</span>
      <span className="club-notice__icon" aria-hidden="true">
        ℹ️
      </span>
    </button>
  );
}

/** Link out to the club channel. Rendered only when the link is configured. */
export function ClubChannelLink({ label }: { label?: string }) {
  const url = openChannel.url();
  if (!url) return null;
  return (
    <a
      className="club-link"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        // Inside Telegram `openTelegramLink` keeps the user in the app; the
        // plain href is the browser fallback and must not fire on top of it.
        event.preventDefault();
        openChannel.open();
      }}
    >
      {label ?? url}
    </a>
  );
}

/**
 * A price, as this viewer will be charged it.
 *
 * Takes the stored club tier amount and the viewer's membership, never a
 * pre-computed number: `isSubscribedChannel` is required, so a call site that
 * forgets about the club rate fails to compile instead of quietly showing a
 * figure the invoice will contradict. The conversion is the same shared
 * function the server runs at checkout.
 */
export function Price({
  clubTierMinor,
  currency,
  compareAtMinor,
  isSubscribedChannel,
}: {
  clubTierMinor: number;
  currency: Currency;
  compareAtMinor?: number | null;
  isSubscribedChannel: boolean;
}) {
  if (clubTierMinor === 0) {
    return <span className="price">Бесплатно</span>;
  }

  const amountMinor = effectiveUnitMinor(clubTierMinor, isSubscribedChannel);
  // The "was" price is scaled the same way. Left alone it could end up below the
  // current price for a non-member, turning a sale badge into a price increase.
  const compareAt =
    compareAtMinor == null
      ? null
      : effectiveUnitMinor(compareAtMinor, isSubscribedChannel);

  return (
    <span>
      <span className="price">{formatMoney(amountMinor, currency)}</span>
      {compareAt && compareAt > amountMinor ? (
        <span className="price--old">{formatMoney(compareAt, currency)}</span>
      ) : null}
    </span>
  );
}

export function Stepper({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number | null;
  onChange: (next: number) => void;
}) {
  const atMax = max !== null && value >= max;
  return (
    <div className="stepper">
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        aria-label="Уменьшить количество"
      >
        −
      </button>
      <span>{value}</span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={atMax}
        aria-label="Увеличить количество"
      >
        +
      </button>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center">
      <div className="stack" style={{ alignItems: 'center' }}>
        <div
          className="skeleton"
          style={{ width: 32, height: 32, borderRadius: '50%' }}
        />
        {label ? <p className="hint">{label}</p> : null}
      </div>
    </div>
  );
}

export function ProductSkeletonGrid() {
  return (
    <div className="product-grid">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="skeleton skeleton--card" />
      ))}
    </div>
  );
}

/** Placeholder tiles matching the category grid layout. */
export function CategorySkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="category-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton skeleton--category" />
      ))}
    </div>
  );
}

export function EmptyState({
  emoji,
  title,
  description,
  action,
}: {
  emoji: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="center">
      <div className="stack" style={{ alignItems: 'center', maxWidth: 320 }}>
        <div style={{ fontSize: 48 }}>{emoji}</div>
        <h2 className="title">{title}</h2>
        {description ? <p className="subtitle">{description}</p> : null}
        {action}
      </div>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      emoji="⚠️"
      title="Что-то пошло не так"
      description={message}
      action={
        onRetry ? (
          <button type="button" className="button" onClick={onRetry}>
            Повторить
          </button>
        ) : undefined
      }
    />
  );
}
