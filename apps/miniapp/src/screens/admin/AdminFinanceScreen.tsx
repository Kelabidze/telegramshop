import { useQuery } from '@tanstack/react-query';
import { formatMoney, type Currency } from '@shop/shared';
import { api } from '../../api/client.ts';
import { ErrorState, Spinner } from '../../components/ui.tsx';

/**
 * Finance overview.
 *
 * Honest stub: it reports what the server actually says about payments and sums
 * up the orders staff can already read. It does **not** pretend to manage
 * gateways — the payment method is `PAYMENT_PROVIDER` in the API environment,
 * and a switch here that silently did nothing would be worse than a label
 * explaining where the real setting lives.
 */
export function AdminFinanceScreen() {
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    retry: false,
  });

  const ordersQuery = useQuery({
    queryKey: ['staff-orders'],
    queryFn: () => api.listAllOrders(),
    retry: false,
  });

  if (healthQuery.isPending) return <Spinner label="Загружаем настройки…" />;
  if (healthQuery.isError) {
    return (
      <ErrorState
        message={(healthQuery.error as Error).message}
        onRetry={() => void healthQuery.refetch()}
      />
    );
  }

  const health = healthQuery.data;
  const orders = ordersQuery.data ?? [];
  const paid = orders.filter((order) => order.status === 'PAID');

  // Grouped by currency: summing XTR with RUB would produce a meaningless
  // number, and this shop can be configured for either.
  const totals = new Map<Currency, number>();
  for (const order of paid) {
    totals.set(
      order.currency,
      (totals.get(order.currency) ?? 0) + order.totalAmountMinor,
    );
  }

  const failed = orders.filter((order) => order.status === 'FAILED').length;

  const PROVIDER_LABEL: Record<string, string> = {
    stars: 'Telegram Stars (XTR)',
    provider: 'Платёжный провайдер',
    none: 'Отключены',
  };

  return (
    <div className="page">
      <h1 className="title">Финансы</h1>
      <p className="subtitle">Оплата и сводка по заказам</p>

      <h2 className="section-title">Способ оплаты</h2>
      <div className="card stack">
        <div className="row">
          <span className="hint">Провайдер</span>
          <div className="spacer" />
          <strong>{PROVIDER_LABEL[health.payments] ?? health.payments}</strong>
        </div>
        <div className="row">
          <span className="hint">Бот настроен</span>
          <div className="spacer" />
          <strong>{health.botConfigured ? 'да' : 'нет'}</strong>
        </div>
        <div className="row">
          <span className="hint">Клубный канал</span>
          <div className="spacer" />
          <strong>{health.clubChannelConfigured ? 'подключён' : 'не задан'}</strong>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Способ оплаты задаётся переменной PAYMENT_PROVIDER на сервере.
          Переключать его из приложения намеренно нельзя: смена шлюза требует
          токена провайдера и перезапуска сервиса.
        </p>
      </div>

      <h2 className="section-title">Оплаченные заказы</h2>
      {ordersQuery.isError ? (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>
            Сводка недоступна: нужно право «Все заказы» (VIEW_ORDERS).
          </p>
        </div>
      ) : (
        <div className="card stack">
          <div className="row">
            <span className="hint">Оплачено заказов</span>
            <div className="spacer" />
            <strong>{paid.length}</strong>
          </div>
          {[...totals.entries()].map(([currency, amountMinor]) => (
            <div key={currency} className="row">
              <span className="hint">Выручка, {currency}</span>
              <div className="spacer" />
              <strong>{formatMoney(amountMinor, currency)}</strong>
            </div>
          ))}
          {failed > 0 ? (
            <p
              className="hint"
              style={{ margin: 0, color: 'var(--tg-destructive-text-color)' }}
            >
              Заказов со статусом FAILED: {failed}. Оплата прошла, товар не
              выдан — требуется ручной разбор.
            </p>
          ) : null}
        </div>
      )}

      <p className="hint" style={{ marginTop: 16 }}>
        Выручка считается по заказам в статусе PAID и не учитывает возвраты
        Telegram Stars.
      </p>
    </div>
  );
}
