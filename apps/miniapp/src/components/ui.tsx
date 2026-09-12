import {
  CLUB_TIER_PERCENT,
  effectiveUnitMinor,
  formatMoney,
  type Currency,
} from '@shop/shared';
import { emptyArt } from '../assets/index.ts';
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
    <div className="product-grid" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => (
        /*
          Built from the same parts as a real card — 1:1 media plus a body — rather
          than one box at a guessed ratio. The single `3 / 4` block it replaced was
          about 25px shorter than the card at phone widths, so the grid jumped as
          soon as products arrived. Mirroring the structure keeps them the same
          height at any width, with no number to keep in sync.
        */
        <div key={i} className="product-card product-card--skeleton">
          <div className="skeleton skeleton--card-media" />
          <div className="product-card__body">
            <div className="skeleton skeleton--text" />
            <div className="skeleton skeleton--text skeleton--text-short" />
          </div>
        </div>
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

/**
 * Empty and error states.
 *
 * Takes either an `emoji` or an `art` node, and renders whichever is given
 * inside the same framed tile (`.empty-art`) — a graphite square with a hairline
 * and a breath of violet, which is what makes a bare glyph look deliberate
 * against a near-black page instead of abandoned.
 *
 * `emoji` remains for states the brand has not drawn an illustration for — the three
 * admin screens — while `art` carries the real artwork everywhere a buyer can reach.
 * Keeping both avoids inventing placeholder graphics for staff-only screens.
 */
export function EmptyState({
  emoji,
  art,
  title,
  description,
  action,
}: {
  /** Glyph fallback, used while the brand illustration for this state is absent. */
  emoji?: string;
  /** Brand illustration. Wins over `emoji` when both are somehow provided. */
  art?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="center">
      <div className="stack" style={{ alignItems: 'center', maxWidth: 320 }}>
        <div className="empty-art" aria-hidden="true">
          {art ?? emoji}
        </div>
        <h2 className="title">{title}</h2>
        {description ? <p className="subtitle">{description}</p> : null}
        {action}
      </div>
    </div>
  );
}

/**
 * Brand illustration for an empty state.
 *
 * `alt=""` and the `aria-hidden` frame around it are deliberate: the heading and
 * description already say what the state is, so announcing the picture too would just
 * repeat it to a screen reader.
 */
export function EmptyArt({ src }: { src: string }) {
  return <img className="empty-art__image" src={src} alt="" />;
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
      art={<EmptyArt src={emptyArt.error} />}
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
