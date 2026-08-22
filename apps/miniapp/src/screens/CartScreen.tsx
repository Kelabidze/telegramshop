import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatMoney } from '@shop/shared';
import { ApiError, api } from '../api/client.ts';
import {
  selectCurrency,
  selectItemCount,
  selectTotalMinor,
  useCart,
} from '../store/cart.ts';
import { useMainButton } from '../telegram/buttons.ts';
import { haptic, openInvoice, showAlert } from '../telegram/webapp.ts';
import { EmptyState, Price, Stepper } from '../components/ui.tsx';

/**
 * Cart and checkout.
 *
 * Checkout sequence:
 *   POST /api/orders -> invoice link -> WebApp.openInvoice -> status callback
 *
 * The cart is cleared only on a confirmed `paid` status. Goods themselves are
 * delivered by the bot from the verified `successful_payment` webhook, so a
 * client that closes early still receives the purchase.
 */
export function CartScreen({
  onContinueShopping,
  onOpenOrders,
}: {
  onContinueShopping: () => void;
  onOpenOrders: () => void;
}) {
  const lines = useCart((s) => s.lines);
  const setQuantity = useCart((s) => s.setQuantity);
  const remove = useCart((s) => s.remove);
  const clear = useCart((s) => s.clear);

  const itemCount = useCart(selectItemCount);
  const totalMinor = useCart(selectTotalMinor);
  const currency = useCart(selectCurrency);

  const [isSubmitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();

  async function checkout() {
    if (lines.length === 0 || isSubmitting) return;
    setSubmitting(true);

    try {
      const session = await api.createOrder({
        items: lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
        })),
      });

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

  useMainButton(
    lines.length > 0
      ? {
          text:
            totalMinor === 0
              ? 'Получить бесплатно'
              : currency
                ? `Оплатить ${formatMoney(totalMinor, currency)}`
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
                  amountMinor={line.unitAmountMinor}
                  currency={line.currency}
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
                  line.unitAmountMinor * line.quantity,
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
          {currency ? formatMoney(totalMinor, currency) : '—'}
        </strong>
      </div>

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
