import { formatMoney, type Currency } from '@shop/shared';

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

/**
 * Placeholder for the greeting line.
 *
 * Sized to the text it replaces so the header does not jump when the name
 * arrives — layout shift right under the user's thumb is what makes a Mini App
 * feel like a web page rather than a native screen.
 */
export function GreetingSkeleton() {
  return (
    <div className="greeting" aria-hidden="true">
      <div className="skeleton greeting__avatar-skeleton" />
      <div className="stack" style={{ gap: 6, flex: 1 }}>
        <div className="skeleton skeleton--text" style={{ width: '55%' }} />
        <div className="skeleton skeleton--text skeleton--text-sm" style={{ width: '35%' }} />
      </div>
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
