import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CryptoPayment, CryptoPaymentStatus } from '@shop/shared';
import { api } from '../api/client.ts';
import { ErrorState, Spinner } from '../components/ui.tsx';
import { haptic, showAlert, showConfirm } from '../telegram/webapp.ts';

/**
 * Waiting for an on-chain payment.
 *
 * Polls the server, which reconciles on read — so the moment the watcher confirms
 * a transfer, the next poll shows it rather than waiting out another cycle.
 *
 * The buyer has to copy an address and an exact amount into a wallet, so both are
 * presented as copyable, unambiguous text. The amount is the server's own
 * `expectedAmountDisplay`, never a number formatted here: two places formatting
 * the same amount is how a screen ends up disagreeing with what the chain is
 * asked for.
 */

const STATUS_COPY: Record<
  CryptoPaymentStatus,
  { label: string; hint: string; tone: 'wait' | 'progress' | 'good' | 'warn' | 'bad' }
> = {
  AWAITING: {
    label: 'Ожидаем перевод',
    hint: 'Отправьте точную сумму на адрес ниже. Сеть — BEP20 (BNB Smart Chain).',
    tone: 'wait',
  },
  CONFIRMING: {
    label: 'Перевод найден',
    hint: 'Ждём подтверждения сети. Это занимает меньше минуты.',
    tone: 'progress',
  },
  CONFIRMED: {
    label: 'Оплата подтверждена',
    hint: 'Заказ оплачен, товар отправлен в чат.',
    tone: 'good',
  },
  OVERPAID: {
    label: 'Оплачено с избытком',
    hint: 'Заказ оплачен. По переплате свяжитесь с поддержкой — она зафиксирована.',
    tone: 'good',
  },
  UNDERPAID: {
    label: 'Пришло меньше суммы',
    hint: 'Доплатите разницу на тот же адрес — платёж завершится автоматически.',
    tone: 'warn',
  },
  EXPIRED: {
    label: 'Время истекло',
    hint: 'Оформите заказ заново. Если перевод всё же ушёл — напишите в поддержку, он не потерян.',
    tone: 'bad',
  },
  CANCELLED: {
    label: 'Платёж отменён',
    hint: 'Вы отменили оплату этого заказа.',
    tone: 'bad',
  },
  FAILED: {
    label: 'Требует внимания',
    hint: 'Оплата получена, но выдать товар автоматически не удалось. Мы уже разбираемся.',
    tone: 'bad',
  },
};

/** Statuses where money can still arrive, so polling is worth continuing. */
const LIVE_STATUSES: CryptoPaymentStatus[] = [
  'AWAITING',
  'CONFIRMING',
  'UNDERPAID',
];

export function CryptoPaymentScreen({
  orderId,
  onDone,
  onBackToCatalog,
}: {
  orderId: string;
  onDone: () => void;
  onBackToCatalog: () => void;
}) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState<'address' | 'amount' | null>(null);

  const paymentQuery = useQuery({
    queryKey: ['crypto-payment', orderId],
    queryFn: () => api.getCryptoPayment(orderId),
    // Every 5 seconds while money can still arrive, then stop. Polling a settled
        // payment forever is load with no answer to give.
    refetchInterval: (query) =>
      query.state.data && LIVE_STATUSES.includes(query.state.data.status)
        ? 5_000
        : false,
    retry: false,
  });

  const payment = paymentQuery.data;

  // Once it settles, the order and the catalog are both stale.
  useEffect(() => {
    if (!payment) return;
    if (payment.status === 'CONFIRMED' || payment.status === 'OVERPAID') {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    }
  }, [payment?.status, payment, queryClient]);

  if (paymentQuery.isPending) {
    return (
      <div className="page">
        <Spinner />
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

  const copy = STATUS_COPY[payment.status];
  const isLive = LIVE_STATUSES.includes(payment.status);
  const isSettled = payment.status === 'CONFIRMED' || payment.status === 'OVERPAID';

  async function copyValue(kind: 'address' | 'amount', value: string) {
    haptic('tap');
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      // Reset so the confirmation does not linger as a permanent label.
      setTimeout(() => setCopied(null), 2_000);
    } catch {
      // Clipboard access is refused in some WebViews. Showing the value is the
      // fallback that always works.
      showAlert(value);
    }
  }

  return (
    <div className="page">
      <h1 className="title">Оплата USDT</h1>

      <div className={`pay-status pay-status--${copy.tone}`}>
        <div className="pay-status__label">{copy.label}</div>
        <div className="pay-status__hint">{copy.hint}</div>
      </div>

      {isLive ? (
        <>
          <div className="card stack" style={{ marginTop: 16, gap: 14 }}>
            <CopyRow
              title="Сумма"
              value={payment.expectedAmountDisplay}
              suffix="USDT"
              copied={copied === 'amount'}
              onCopy={() => void copyValue('amount', payment.expectedAmountDisplay)}
            />
            <CopyRow
              title="Адрес"
              value={payment.depositAddress}
              mono
              copied={copied === 'address'}
              onCopy={() => void copyValue('address', payment.depositAddress)}
            />
            <div className="pay-row">
              <span className="pay-row__title">Сеть</span>
              <span className="pay-row__value">BNB Smart Chain (BEP20)</span>
            </div>
          </div>

          {/*
            The two mistakes that lose money on this screen: the wrong network,
            and a rounded amount. Both are stated plainly rather than buried.
          */}
          <ul className="pay-warnings">
            <li>Только сеть BEP20 (BNB Smart Chain). Перевод в другой сети не дойдёт.</li>
            <li>Отправляйте точную сумму — иначе платёж придётся дополнять вручную.</li>
            <li>Действует до {formatDeadline(payment.expiresAt)}.</li>
          </ul>
        </>
      ) : null}

      {payment.status === 'UNDERPAID' ? (
        <div className="card stack" style={{ marginTop: 16, gap: 8 }}>
          <div className="pay-row">
            <span className="pay-row__title">Уже получено</span>
            <span className="pay-row__value">
              {formatCents(payment.receivedAmountMinor)} USDT
            </span>
          </div>
          <div className="pay-row">
            <span className="pay-row__title">Осталось</span>
            <span className="pay-row__value">
              {formatCents(
                Math.max(
                  0,
                  payment.expectedAmountMinor - payment.receivedAmountMinor,
                ),
              )}{' '}
              USDT
            </span>
          </div>
        </div>
      ) : null}

      {payment.transactions.length > 0 ? (
        <div className="stack" style={{ marginTop: 20, gap: 8 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            Переводы
          </h2>
          {payment.transactions.map((tx) => (
            <div key={`${tx.txHash}:${tx.logIndex}`} className="card">
              <div className="pay-row">
                <span className="pay-row__value">{formatCents(tx.amountMinor)} USDT</span>
                <div className="spacer" />
                <span className="hint">{TX_STATUS_LABEL[tx.status]}</span>
              </div>
              <div className="pay-tx__hash">{shortHash(tx.txHash)}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="stack" style={{ marginTop: 24, gap: 10 }}>
        {isSettled ? (
          <button type="button" className="button" onClick={onDone}>
            К заказам
          </button>
        ) : null}

        {isLive ? (
          <>
            <button type="button" className="button button--secondary" onClick={onDone}>
              Я оплатил — к заказам
            </button>
            {payment.status === 'AWAITING' ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  void (async () => {
                    if (!(await showConfirm('Отменить оплату этого заказа?'))) return;
                    try {
                      await api.cancelCryptoPayment(orderId);
                      haptic('warning');
                      await paymentQuery.refetch();
                    } catch (error) {
                      showAlert(
                        error instanceof Error
                          ? error.message
                          : 'Не удалось отменить платёж.',
                      );
                    }
                  })();
                }}
              >
                Отменить платёж
              </button>
            ) : null}
          </>
        ) : null}

        {!isLive && !isSettled ? (
          <button type="button" className="button" onClick={onBackToCatalog}>
            В каталог
          </button>
        ) : null}
      </div>
    </div>
  );
}

const TX_STATUS_LABEL: Record<string, string> = {
  SEEN: 'Ждём подтверждения',
  CONFIRMED: 'Подтверждён',
  ORPHANED: 'Отменён сетью',
};

function CopyRow({
  title,
  value,
  suffix,
  mono = false,
  copied,
  onCopy,
}: {
  title: string;
  value: string;
  suffix?: string;
  mono?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="pay-copy">
      <span className="pay-copy__title">{title}</span>
      <button
        type="button"
        className={`pay-copy__value${mono ? ' pay-copy__value--mono' : ''}`}
        onClick={onCopy}
      >
        <span className="pay-copy__text">
          {value}
          {suffix ? ` ${suffix}` : ''}
        </span>
        <span className="pay-copy__action">{copied ? 'Скопировано' : 'Копировать'}</span>
      </button>
    </div>
  );
}

/** Cents -> "15.00". Two decimals always, so an amount reads as money. */
function formatCents(minor: number): string {
  return (minor / 100).toFixed(2);
}

function formatDeadline(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** A 66-character hash does not fit a phone; the ends are enough to recognise it. */
function shortHash(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}
