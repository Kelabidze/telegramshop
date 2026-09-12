import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CasheraPayment, CasheraStatus } from '@shop/shared';
import { CASHERA_STATUS_LABEL, formatMoney } from '@shop/shared';
import { api } from '../api/client.ts';
import { ErrorState, Spinner } from '../components/ui.tsx';
import { haptic, openExternal, showAlert } from '../telegram/webapp.ts';

/**
 * Cashera payment, via its hosted page — card or cryptocurrency, whichever rail the
 * order opened on.
 *
 * The buyer leaves the Mini App to pay and comes back, so this screen has to work
 * without knowing whether they actually paid. It never infers success from the
 * return itself — it asks the server, and the server only believes a verified
 * webhook or its own lookup against the gateway. "The browser came back from the
 * payment page" and "the money arrived" are different facts.
 */

const HINT: Record<CasheraStatus, string> = {
  pending: 'Откройте страницу оплаты и завершите платёж. Статус обновится автоматически.',
  paid: 'Заказ оплачен, товар отправлен в чат.',
  failed: 'Платёж не прошёл. Можно оформить заказ заново.',
  expired: 'Время на оплату истекло. Оформите заказ заново.',
  refunded: 'По этому платежу выполнен возврат.',
  chargeback: 'Платёж оспорен. Мы уже разбираемся.',
};

const TONE: Record<CasheraStatus, 'wait' | 'good' | 'warn' | 'bad'> = {
  pending: 'wait',
  paid: 'good',
  failed: 'bad',
  expired: 'bad',
  refunded: 'warn',
  chargeback: 'bad',
};

export function CasheraPaymentScreen({
  orderId,
  onDone,
  onBackToCatalog,
}: {
  orderId: string;
  onDone: () => void;
  onBackToCatalog: () => void;
}) {
  const queryClient = useQueryClient();
  const [isChecking, setChecking] = useState(false);

  const paymentQuery = useQuery({
    queryKey: ['cashera-payment', orderId],
    queryFn: () => api.getCasheraPayment(orderId),
    // Only while the outcome is still open. Polling a settled payment is load with
    // no answer to give.
    refetchInterval: (query) =>
      query.state.data?.status === 'pending' ? 4_000 : false,
    retry: false,
  });

  const payment = paymentQuery.data;

  useEffect(() => {
    if (payment?.status === 'paid') {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    }
  }, [payment?.status, queryClient]);

  /**
   * Asks the server to re-read the gateway.
   *
   * Offered explicitly because a webhook can be late or lost, and the buyer is the
   * one who knows they just paid. Costs an upstream call, so it is a button rather
   * than part of the poll.
   */
  async function recheck() {
    if (isChecking) return;
    setChecking(true);
    try {
      const fresh = await api.refreshCasheraPayment(orderId);
      queryClient.setQueryData(['cashera-payment', orderId], fresh);
      if (fresh.status !== 'paid') haptic('warning');
    } catch (error) {
      showAlert(
        error instanceof Error ? error.message : 'Не удалось проверить оплату.',
      );
    } finally {
      setChecking(false);
    }
  }

  if (paymentQuery.isPending) {
    return (
      <div className="page">
        <Spinner label="Загружаем платёж…" />
      </div>
    );
  }

  if (paymentQuery.isError || !payment) {
    return (
      <div className="page">
        <ErrorState
          message={
            paymentQuery.error instanceof Error
              ? paymentQuery.error.message
              : 'Не удалось загрузить платёж.'
          }
          onRetry={() => void paymentQuery.refetch()}
        />
      </div>
    );
  }

  const isOpen = payment.status === 'pending';
  const isPaid = payment.status === 'paid';

  return (
    <div className="page">
      <h1 className="title">
        {payment.rail === 'crypto' ? 'Оплата криптовалютой' : 'Оплата картой'}
      </h1>

      <div className={`pay-status pay-status--${TONE[payment.status]}`}>
        <div className="pay-status__label">
          {CASHERA_STATUS_LABEL[payment.status]}
        </div>
        <div className="pay-status__hint">{HINT[payment.status]}</div>
      </div>

      <div className="card stack" style={{ marginTop: 16, gap: 12 }}>
        <div className="pay-row">
          <span className="pay-row__title">Сумма</span>
          <span className="pay-row__value">
            {formatMoney(payment.amountMinor, 'RUB')}
          </span>
        </div>
        <div className="pay-row">
          <span className="pay-row__title">Способ</span>
          <span className="pay-row__value">{methodLabel(payment)}</span>
        </div>
      </div>

      <div className="stack" style={{ marginTop: 24, gap: 10 }}>
        {isOpen && payment.paymentUrl ? (
          <button
            type="button"
            className="button"
            onClick={() => {
              haptic('tap');
              // Out to the hosted page. `openExternal` uses Telegram's own opener
              // where available, which keeps the Mini App alive underneath.
              openExternal(payment.paymentUrl!);
            }}
          >
            Перейти к оплате
          </button>
        ) : null}

        {isOpen ? (
          <button
            type="button"
            className="button button--secondary"
            disabled={isChecking}
            onClick={() => void recheck()}
          >
            {isChecking ? 'Проверяем оплату…' : 'Я оплатил — проверить'}
          </button>
        ) : null}

        {isPaid ? (
          <button type="button" className="button" onClick={onDone}>
            К заказам
          </button>
        ) : null}

        <button
          type="button"
          className="button button--ghost"
          onClick={isOpen || isPaid ? onDone : onBackToCatalog}
        >
          {isOpen ? 'К заказам' : isPaid ? 'В каталог' : 'В каталог'}
        </button>
      </div>

      {isOpen ? (
        <p className="hint" style={{ marginTop: 16 }}>
          Оплата подтверждается на стороне платёжного сервиса. Возврат на эту
          страницу сам по себе не означает, что платёж прошёл.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A buyer-facing name for the settled method.
 *
 * Null means a common payment form where Cashera has not had a method chosen yet,
 * so the rail name is the honest label — not a guess about a method the buyer has
 * not picked. `crypto` covers any cryptocurrency Cashera presents; this code never
 * names a specific coin.
 */
function methodLabel(payment: CasheraPayment): string {
  if (!payment.paymentMethod) {
    return payment.rail === 'crypto' ? 'Криптовалюта' : 'Карта · СБП';
  }
  const known: Record<string, string> = {
    sbp: 'СБП',
    card: 'Банковская карта',
    mastercard: 'Банковская карта',
    crypto: 'Криптовалюта',
    cryptobot: 'CryptoBot',
  };
  return known[payment.paymentMethod.toLowerCase()] ?? payment.paymentMethod;
}
