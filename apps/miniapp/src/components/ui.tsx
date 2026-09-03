import { CLUB_TIER_PERCENT, formatMoney, type Currency } from '@shop/shared';
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
}: {
  isSubscribedChannel: boolean;
  /** `product` sits above the action button; `cart` above the total. */
  variant: 'product' | 'cart';
}) {
  if (isSubscribedChannel) {
    return (
      <button
        type="button"
        className="club-notice club-notice--active"
        onClick={() =>
          showAlert(
            `Клубный тариф ${CLUB_TIER_PERCENT}% активирован: вы подписаны на канал, ` +
              'и цены в приложении уже учитывают клубную выгоду.',
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
      : `Вы можете сохранить ${CLUB_TIER_PERCENT}%`;

  const offer =
    variant === 'product'
      ? `Подпишитесь на наш канал — и клубный тариф ${CLUB_TIER_PERCENT}% ` +
        'будет применяться ко всем товарам автоматически.'
      : 'Оформите подписку на канал, чтобы активировать клубный тариф ' +
        `${CLUB_TIER_PERCENT}% и сохранить эту сумму на заказе.`;

  return (
    <button
      type="button"
      className="club-notice"
      onClick={() => {
        // Ask before leaving: opening the channel without warning drops the
        // user out of the app mid-purchase. When no channel link is
        // configured the popup is informational only, so the tap still
        // explains the offer instead of doing nothing.
        if (!openChannel.isAvailable()) {
          showAlert(offer);
          return;
        }
        void showConfirm(`${offer}\n\nОткрыть канал?`).then((ok) => {
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
export function ClubChannelButton({ label }: { label: string }) {
  if (!openChannel.isAvailable()) return null;
  return (
    <button
      type="button"
      className="button"
      onClick={() => openChannel.open()}
    >
      {label}
    </button>
  );
}

export function Price({
  amountMinor,
  currency,
  compareAtMinor,
}: {
  amountMinor: number;
  currency: Currency;
  compareAtMinor?: number | null;
}) {
  if (amountMinor === 0) {
    return <span className="price">Бесплатно</span>;
  }
  return (
    <span>
      <span className="price">{formatMoney(amountMinor, currency)}</span>
      {compareAtMinor && compareAtMinor > amountMinor ? (
        <span className="price--old">
          {formatMoney(compareAtMinor, currency)}
        </span>
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
