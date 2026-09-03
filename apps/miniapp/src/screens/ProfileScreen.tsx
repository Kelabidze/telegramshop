import { useQuery } from '@tanstack/react-query';
import type { Viewer } from '@shop/shared';
import { CLUB_TIER_PERCENT } from '@shop/shared';
import { api } from '../api/client.ts';
import { ClubChannelButton, EmptyState } from '../components/ui.tsx';
import { openChannel } from '../telegram/webapp.ts';

const ROLE_LABEL: Record<Viewer['role'], string> = {
  ADMIN: 'Администратор',
  MANAGER: 'Менеджер',
  USER: 'Покупатель',
};

/**
 * Profile screen.
 *
 * Reached by tapping the header, left via Telegram's BackButton or by picking
 * any tab (both wired in `App.tsx`). No MainButton here: the screen has no
 * single primary action, and a native button labelled "Назад" would duplicate
 * the BackButton.
 */
export function ProfileScreen({
  viewer,
  isPending,
}: {
  viewer: Viewer | null;
  isPending: boolean;
}) {
  // Order count is the one piece of profile data not already in `['me']`.
  // Enabled only for an identified viewer: without a signature it is a 401.
  const ordersQuery = useQuery({
    queryKey: ['orders'],
    queryFn: () => api.listOrders(),
    enabled: viewer !== null,
    retry: false,
  });

  if (isPending) {
    return (
      <div className="page">
        <div className="profile-hero">
          <div className="skeleton profile-hero__avatar-skeleton" />
          <div className="skeleton skeleton--text" style={{ width: 160 }} />
          <div
            className="skeleton skeleton--text skeleton--text-sm"
            style={{ width: 110 }}
          />
        </div>
      </div>
    );
  }

  if (!viewer) {
    return (
      <EmptyState
        emoji="🔐"
        title="Профиль недоступен"
        description="Откройте приложение из Telegram, чтобы увидеть свои данные и клубный статус."
      />
    );
  }

  const name = [viewer.firstName, viewer.lastName].filter(Boolean).join(' ');
  const initial = [...viewer.firstName.trim()][0] ?? '👋';
  const paidOrders =
    ordersQuery.data?.filter((order) => order.status === 'PAID').length ?? null;

  return (
    <div className="page">
      <div className="profile-hero">
        <div className="profile-hero__avatar" aria-hidden="true">
          {initial}
        </div>
        <h1 className="title" style={{ marginTop: 12 }}>
          {name}
        </h1>
        {viewer.username ? (
          <p className="subtitle">@{viewer.username}</p>
        ) : null}
      </div>

      <h2 className="section-title">Клубный статус</h2>

      <div className="card stack">
        {viewer.isSubscribedChannel ? (
          <>
            <div className="row">
              <span className="club-badge club-badge--active">
                Клубный тариф {CLUB_TIER_PERCENT}% активирован
              </span>
            </div>
            <p className="hint" style={{ margin: 0 }}>
              Вы подписаны на канал, поэтому цены в приложении уже учитывают
              клубную выгоду.
            </p>
          </>
        ) : (
          <>
            <div className="row">
              <span className="club-badge">Клубный тариф не активирован</span>
            </div>
            <p className="hint" style={{ margin: 0 }}>
              Подпишитесь на наш канал, чтобы получать клубный тариф{' '}
              {CLUB_TIER_PERCENT}% на все товары.
            </p>
            <ClubChannelButton label="Перейти в канал" />
            {!openChannel.isAvailable() ? (
              <p className="hint" style={{ margin: 0 }}>
                Ссылка на канал появится здесь позже.
              </p>
            ) : null}
          </>
        )}
      </div>

      <h2 className="section-title">Данные аккаунта</h2>

      <div className="card stack" style={{ gap: 10 }}>
        <InfoRow label="Роль" value={ROLE_LABEL[viewer.role]} />
        <InfoRow label="Telegram ID" value={viewer.telegramId} />
        {paidOrders !== null ? (
          <InfoRow label="Оплаченных заказов" value={String(paidOrders)} />
        ) : null}
      </div>

      <p className="hint" style={{ marginTop: 16 }}>
        Данные берутся из вашего профиля Telegram и обновляются автоматически.
      </p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span className="hint">{label}</span>
      <div className="spacer" />
      <span style={{ fontWeight: 500, textAlign: 'right', minWidth: 0 }}>
        {value}
      </span>
    </div>
  );
}
