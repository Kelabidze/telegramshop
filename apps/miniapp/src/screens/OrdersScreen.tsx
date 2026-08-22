import { useQuery } from '@tanstack/react-query';
import { formatMoney, type Order } from '@shop/shared';
import { api } from '../api/client.ts';
import { EmptyState, ErrorState, Spinner } from '../components/ui.tsx';

const STATUS_LABEL: Record<Order['status'], string> = {
  PENDING: 'Ожидает оплаты',
  PAID: 'Оплачен',
  CANCELLED: 'Отменён',
  REFUNDED: 'Возврат',
  FAILED: 'Требует внимания',
};

export function OrdersScreen({
  onContinueShopping,
}: {
  onContinueShopping: () => void;
}) {
  const query = useQuery({
    queryKey: ['orders'],
    queryFn: () => api.listOrders(),
    // A payment may still be settling when this screen opens.
    refetchInterval: (q) =>
      q.state.data?.some((o) => o.status === 'PENDING') ? 3000 : false,
  });

  if (query.isPending) return <Spinner label="Загружаем заказы…" />;
  if (query.isError) {
    return (
      <ErrorState
        message={(query.error as Error).message}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const orders = query.data ?? [];

  if (orders.length === 0) {
    return (
      <EmptyState
        emoji="📦"
        title="Заказов пока нет"
        description="Здесь появятся ваши покупки и ключи доступа."
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
      <h1 className="title">Мои заказы</h1>

      <div className="stack" style={{ marginTop: 16 }}>
        {orders.map((order) => (
          <article key={order.id} className="card stack">
            <div className="row">
              <strong>№{order.reference}</strong>
              <div className="spacer" />
              <span className={`order-status order-status--${order.status}`}>
                {STATUS_LABEL[order.status]}
              </span>
            </div>

            <div className="stack" style={{ gap: 8 }}>
              {order.lines.map((line) => (
                <div key={line.id}>
                  <div className="row">
                    <span style={{ flex: 1 }}>
                      {line.titleSnapshot}
                      {line.quantity > 1 ? ` × ${line.quantity}` : ''}
                    </span>
                    <span>
                      {formatMoney(line.totalAmountMinor, order.currency)}
                    </span>
                  </div>

                  {line.deliveredPayload ? (
                    <DeliveredPayload
                      kind={line.fulfillmentKind}
                      payload={line.deliveredPayload}
                    />
                  ) : null}
                </div>
              ))}
            </div>

            <div className="row">
              <span className="hint">
                {new Date(order.createdAt).toLocaleString('ru-RU')}
              </span>
              <div className="spacer" />
              <strong>
                {formatMoney(order.totalAmountMinor, order.currency)}
              </strong>
            </div>

            {order.status === 'FAILED' ? (
              <p className="hint" style={{ color: 'var(--tg-destructive-text-color)' }}>
                Оплата прошла, но выдать товар автоматически не удалось.
                Мы уже разбираемся.
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

/** Renders a delivered secret: a copyable key, or a link to open. */
function DeliveredPayload({
  kind,
  payload,
}: {
  kind: string;
  payload: string;
}) {
  const isUrl = /^https?:\/\//i.test(payload);

  if (isUrl && kind !== 'LICENSE_KEY') {
    return (
      <a
        href={payload}
        target="_blank"
        rel="noreferrer noopener"
        className="button"
        style={{
          display: 'inline-block',
          marginTop: 8,
          textDecoration: 'none',
        }}
      >
        {kind === 'FILE' ? 'Скачать' : 'Открыть доступ'}
      </a>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div className="hint" style={{ marginBottom: 4 }}>
        Ваш ключ (нажмите, чтобы выделить):
      </div>
      <div className="secret">{payload}</div>
    </div>
  );
}
