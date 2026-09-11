import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaymentCurrency, PaymentRates } from '@shop/shared';
import {
  formatMoney,
  effectiveUnitMinor,
  starsForRubMinor,
  usdtMinorForRubMinor,
} from '@shop/shared';
import { ApiError, api } from '../api/client.ts';
import { PaymentMethodPicker } from '../components/PaymentMethodPicker.tsx';

/**
 * Rates for the PREVIEW only.
 *
 * The server owns the real rates and recomputes every amount from the database at
 * checkout, so these never decide what anyone is charged — they exist so the
 * method picker can show two comparable figures before an order exists. Kept in
 * step with the API defaults; a drift shows up as a preview that differs from the
 * total on the payment screen, not as a wrong charge.
 */
const PREVIEW_RATES: PaymentRates = {
  usdtRubMinorPerUnit: 8_600,
  starRubMinorPerUnit: 130,
};
import {
  cartTotalsFor,
  selectCurrency,
  selectItemCount,
  useCart,
} from '../store/cart.ts';
import { useMainButton } from '../telegram/buttons.ts';
import { haptic, openInvoice, showAlert } from '../telegram/webapp.ts';
import { EmptyState, ClubTierNotice, Price, Stepper } from '../components/ui.tsx';

/**
 * Cart and chkout.
 *
 * chkout sequence:
 *   POST /api/orders -> invoice link -> WebApp.openInvoice -> status callback
 *
 * The cart is cleared only on a confirmed `paid` status. Goods themselves are
 * delivered by the bot from the verified `successful_payment` webhook, so a
 * client that closes early still receives the purchase.
 */
export function CartScreen({
  isSubscribedChannel,
  onContinueShopping,
  onOpenOrders,
  onOpenCryptoPayment,
}: {
  isSubscribedChannel: boolean;
  onContinueShopping: () => void;
  onOpenOrders: () => void;
  /** Opens the waiting screen for an on-chain payment. */
  onOpenCryptoPayment: (orderId: string) => void;
}) {
  const lines = useCart((s) => s.lines);
  const setQuantity = useCart((s) => s.setQuantity);
  const remove = useCart((s) => s.remove);
  const clear = useCart((s) => s.clear);

  const itemCount = useCart(selectItemCount);
  const currency = useCart(selectCurrency);
  // Derived from `lines`, which is already subscribed above. Deriving it inside
  // a Zustand selector returns a new object each call and loops forever.
  const totals = cartTotalsFor(lines, isSubscribedChannel);

  const [isSubmitting, setSubmitting] = useState(false);
  const [payWith, setPayWith] = useState<PaymentCurrency>('XTR');
  const queryClient = useQueryClient();

  /**
   * Whether on-chain payment is offered at all.
   *
   * Read from `/health` rather than assumed: the server can have crypto switched
   * off, and offering a method that then fails at checkout is worse than not
   * offering it. Cheap, cached, and never blocks the cart — a failed probe simply
   * means Stars only.
   */
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const usdtAvailable = healthQuery.data?.crypto?.enabled === true;

  /**
   * Prices in both rails, from the same RUB base the server will use.
   *
   * The cart's stored amounts are base-currency kopecks, so these are display
   * figures only — the server recomputes everything from the database at
   * checkout. Shown here so the choice is informed rather than blind.
   */
  const starsMinor = starsForRubMinor(totals.payableMinor, PREVIEW_RATES);
  const usdtMinor = usdtMinorForRubMinor(totals.payableMinor, PREVIEW_RATES);
  const isRubPriced = currency === 'RUB';
  const effectivePayWith: PaymentCurrency =
    isRubPriced && usdtAvailable ? payWith : 'XTR';

  async function checkout() {
    if (lines.length === 0 || isSubmitting) return;
    setSubmitting(true);

    try {
      const session = await api.createOrder({
        items: lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
        })),
        paymentCurrency: effectivePayWith,
      });

      // On-chain: there is no invoice to open, only an address to pay. The cart
      // is cleared because the order now exists and owns the amount.
      if (session.cryptoPayment) {
        clear();
        haptic('success');
        await queryClient.invalidateQueries({ queryKey: ['orders'] });
        onOpenCryptoPayment(session.order.id);
        return;
      }

      // Free orders are already paid and delivered by the server.
      if (!session.invoiceUrl) {
        clear();
        haptic('success');
        await queryClient.invalidateQueries({ queryKey: ['orders'] });
        onOpenOrders();
        return;
      }

      const status = await openInvoice(session.invoiceUrl);

      if (status === 'paid') {
        clear();
        haptic('success');
        // The bot delivers the goods; refresh so the order screen shows them.
        await queryClient.invalidateQueries({ queryKey: ['orders'] });
        await queryClient.invalidateQueries({ queryKey: ['products'] });
        onOpenOrders();
        return;
      }

      if (status === 'failed') {
        haptic('error');
        showAlert('Оплата не прошла. Попробуйте ещё раз.');
        return;
      }

      if (status === 'pending') {
        // Telegram is still confirming; the order screen will update itself.
        onOpenOrders();
        return;
      }

      // 'cancelled': keep the cart intact so the user can retry.
      haptic('warning');
    } catch (error) {
      haptic('error');
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Не удалось оформить заказ.';
      showAlert(message);

      // Stock or availability changed: refresh the catalog view.
      if (
        error instanceof ApiError &&
        (error.code === 'OUT_OF_STOCK' || error.code === 'PRODUCT_UNAVAILABLE')
      ) {
        await queryClient.invalidateQueries({ queryKey: ['products'] });
      }
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * The button names the amount in the currency that will actually be charged,
   * not the base one. A button reading «Оплатить 1 579 ₽» that then asks for
   * 18.37 USDT is the kind of surprise that stops a checkout.
   */
  const buttonAmount = isRubPriced
    ? effectivePayWith === 'USDT'
      ? formatMoney(usdtMinor, 'USDT')
      : formatMoney(starsMinor, 'XTR')
    : currency
      ? formatMoney(totals.payableMinor, currency)
      : null;

  useMainButton(
    lines.length > 0
      ? {
          text:
            totals.payableMinor === 0
              ? 'Получить бесплатно'
              : buttonAmount
                ? `Оплатить ${buttonAmount}`
                : 'Оплатить',
          loading: isSubmitting,
          onClick: () => void checkout(),
        }
      : null,
  );

  if (lines.length === 0) {
    return (
      <EmptyState
        emoji="🛒"
        title="Корзина пуста"
        description="Добавьте товар из каталога, чтобы оформить заказ."
        action={
          <button type="button" className="button" onClick={onContinueShopping}>
            В каталог
          </button>
        }
      />
    );
  }

  return (
    <div className="page">
      <h1 className="title">Корзина</h1>
      <p className="subtitle">
        {itemCount} {pluralItems(itemCount)}
      </p>

      <div className="stack" style={{ marginTop: 16 }}>
        {lines.map((line) => (
          <div key={line.productId} className="card">
            <div className="row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{line.title}</div>
                <Price
                  clubTierMinor={line.unitAmountMinor}
                  currency={line.currency}
                  isSubscribedChannel={isSubscribedChannel}
                />
              </div>
              <Stepper
                value={line.quantity}
                max={line.stock}
                onChange={(next) => {
                  haptic('selection');
                  setQuantity(line.productId, next);
                }}
              />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="hint">
                Итого:{' '}
                {formatMoney(
                  effectiveUnitMinor(line.unitAmountMinor, isSubscribedChannel) *
                    line.quantity,
                  line.currency,
                )}
              </span>
              <div className="spacer" />
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  haptic('tap');
                  remove(line.productId);
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="card row" style={{ marginTop: 16 }}>
        <strong>К оплате</strong>
        <div className="spacer" />
        <strong style={{ fontSize: 18 }}>
          {currency ? formatMoney(totals.payableMinor, currency) : '—'}
        </strong>
      </div>

      {/*
        Only for RUB-priced carts and only when the total is payable: a legacy
        XTR-priced product has no base to convert from, and a free order has
        nothing to choose between.
      */}
      {isRubPriced && totals.payableMinor > 0 ? (
        <div style={{ marginTop: 16 }}>
          <h2 className="section-title">Способ оплаты</h2>
          <PaymentMethodPicker
            value={effectivePayWith}
            starsMinor={starsMinor}
            usdtMinor={usdtMinor}
            usdtAvailable={usdtAvailable}
            onChange={setPayWith}
          />
        </div>
      ) : null}

      {/*
        Both states are shown here, unlike on the product page: the cart is the
        last screen before payment, so a member should see the rate is already
        working, and everyone else what it would be worth. The amount is passed
        in so the copy can name a sum instead of a percentage — "сохранить 120 ⭐"
        is a decision, "сохранить 5%" is arithmetic homework.
      */}
      <ClubTierNotice
        isSubscribedChannel={isSubscribedChannel}
        variant="cart"
        tierAdjustmentMinor={totals.tierAdjustmentMinor}
        currency={currency}
      />

      <p className="hint" style={{ marginTop: 12 }}>
        Товары придут в этот чат сразу после оплаты.
      </p>
    </div>
  );
}

/** Russian plural for "товар". */
function pluralItems(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'товар';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'товара';
  return 'товаров';
}
