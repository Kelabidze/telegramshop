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
              style={{ margin: 0, color: 'var(--zone-error)' }}
            >
              Заказов со статусом FAILED: {failed}. Оплата прошла, товар не
              выдан — требуется ручной разбор.
            </p>
          ) : null}
        </div>
      )}

      <CryptoSection health={health} />

      <p className="hint" style={{ marginTop: 16 }}>
        Выручка считается по заказам в статусе PAID и не учитывает возвраты
        Telegram Stars.
      </p>
    </div>
  );
}

/**
 * On-chain payments: watcher state and the recent intents.
 *
 * Read-only by design. There is no button to mark a payment as received: that
 * would release goods without the chain agreeing, which is the one check this
 * subsystem exists to make. A stuck payment is diagnosed here and fixed by
 * understanding why, not by overriding it.
 */
function CryptoSection({
  health,
}: {
  health: { crypto?: { enabled: boolean; [key: string]: unknown } };
}) {
  const enabled = health.crypto?.enabled === true;

  const paymentsQuery = useQuery({
    queryKey: ['staff-crypto-payments'],
    queryFn: () => api.listCryptoPayments(),
    enabled,
    // Payments settle on their own; a stale list is misleading while watching one.
    refetchInterval: 15_000,
    retry: false,
  });

  if (!enabled) {
    return (
      <>
        <h2 className="section-title">Оплата USDT</h2>
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>
            Выключена. Включается на сервере: CRYPTO_PAYMENTS_ENABLED=true и
            watch-only ключ CRYPTO_DEPOSIT_XPUB. Приватный ключ и мнемоника в API
            не попадают — он не может подписывать транзакции.
          </p>
        </div>
      </>
    );
  }

  const crypto = health.crypto as {
    monitorRunning?: boolean;
    lastScannedBlock?: string | null;
    headBlock?: string | null;
    finalizedBlock?: string | null;
    openIntents?: number;
    rpcFailures?: number;
    degraded?: boolean;
  };
  const payments = paymentsQuery.data ?? [];

  return (
    <>
      <h2 className="section-title">Оплата USDT</h2>
      <div className="card stack">
        <div className="row">
          <span className="hint">Наблюдатель</span>
          <div className="spacer" />
          <strong style={crypto.degraded ? { color: 'var(--zone-error)' } : undefined}>
            {crypto.degraded ? 'сбои RPC' : 'работает'}
          </strong>
        </div>
        <div className="row">
          <span className="hint">Просканировано / голова</span>
          <div className="spacer" />
          <strong>
            {crypto.lastScannedBlock ?? '—'} / {crypto.headBlock ?? '—'}
          </strong>
        </div>
        <div className="row">
          <span className="hint">Финализированный блок</span>
          <div className="spacer" />
          <strong>{crypto.finalizedBlock ?? '—'}</strong>
        </div>
        <div className="row">
          <span className="hint">Открытых платежей</span>
          <div className="spacer" />
          <strong>{crypto.openIntents ?? 0}</strong>
        </div>
        {crypto.rpcFailures ? (
          <div className="row">
            <span className="hint">Ошибок RPC</span>
            <div className="spacer" />
            <strong>{crypto.rpcFailures}</strong>
          </div>
        ) : null}
      </div>

      {paymentsQuery.isError ? (
        <div className="card" style={{ marginTop: 10 }}>
          <p className="hint" style={{ margin: 0 }}>
            Список недоступен: нужно право «Все заказы» (VIEW_ORDERS).
          </p>
        </div>
      ) : payments.length === 0 ? (
        <div className="card" style={{ marginTop: 10 }}>
          <p className="hint" style={{ margin: 0 }}>
            Платежей USDT пока не было.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ marginTop: 10, gap: 8 }}>
          {payments.slice(0, 25).map((payment) => (
            <div key={payment.id} className="card">
              <div className="row">
                <strong>№{payment.orderReference}</strong>
                <div className="spacer" />
                <span className="hint">{payment.status}</span>
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <span className="hint">
                  {payment.receivedAmountDisplay} / {payment.expectedAmountDisplay} USDT
                </span>
                <div className="spacer" />
                <span className="hint">
                  {formatMoney(payment.baseRubMinor, 'RUB')} @{' '}
                  {formatMoney(payment.rateRubMinorPerUnit, 'RUB')}
                </span>
              </div>
              <div
                className="hint"
                style={{
                  marginTop: 6,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 11,
                  wordBreak: 'break-all',
                }}
              >
                {payment.depositAddress}
              </div>
              {payment.overpaidAmountWei ? (
                <p className="hint" style={{ margin: '6px 0 0', color: 'var(--zone-warning)' }}>
                  Переплата зафиксирована — нужен ручной разбор.
                </p>
              ) : null}
              {payment.transactions.map((tx) => (
                <div
                  key={`${tx.txHash}:${tx.logIndex}`}
                  className="hint"
                  style={{ marginTop: 4, fontSize: 11 }}
                >
                  {tx.amountDisplay} USDT · блок {tx.blockNumber} · {tx.status}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
