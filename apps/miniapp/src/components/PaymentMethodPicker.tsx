import type { PaymentCurrency } from '@shop/shared';
import { formatMoney } from '@shop/shared';
import { haptic } from '../telegram/webapp.ts';

/**
 * How to pay: Stars or USDT.
 *
 * Both amounts are shown at once rather than after a choice. The two rails price
 * the same product from one RUB base, and a buyer deciding between them wants to
 * compare, not to pick blind and then discover the number.
 */
export function PaymentMethodPicker({
  value,
  starsMinor,
  usdtMinor,
  usdtAvailable,
  onChange,
}: {
  value: PaymentCurrency;
  starsMinor: number;
  usdtMinor: number;
  /** False when the server has on-chain payments switched off. */
  usdtAvailable: boolean;
  onChange: (next: PaymentCurrency) => void;
}) {
  return (
    <div className="pay-methods">
      <PaymentMethodOption
        selected={value === 'XTR'}
        title="Telegram Stars"
        amount={formatMoney(starsMinor, 'XTR')}
        caption="Оплата внутри Telegram"
        onSelect={() => onChange('XTR')}
      />
      <PaymentMethodOption
        selected={value === 'USDT'}
        title="USDT"
        amount={formatMoney(usdtMinor, 'USDT')}
        caption={
          usdtAvailable
            ? 'BEP20 · BNB Smart Chain'
            : 'Временно недоступно'
        }
        disabled={!usdtAvailable}
        onSelect={() => onChange('USDT')}
      />
    </div>
  );
}

function PaymentMethodOption({
  selected,
  title,
  amount,
  caption,
  disabled = false,
  onSelect,
}: {
  selected: boolean;
  title: string;
  amount: string;
  caption: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="pay-method"
      // `aria-pressed` rather than a role hack: this is a toggle, and screen
      // readers announce the selected state without extra markup.
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => {
        haptic('selection');
        onSelect();
      }}
    >
      <span className="pay-method__head">
        <span className="pay-method__title">{title}</span>
        <span className="pay-method__amount">{amount}</span>
      </span>
      <span className="pay-method__caption">{caption}</span>
    </button>
  );
}
