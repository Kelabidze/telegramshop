import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Viewer } from '@shop/shared';
import {
  CLUB_TIER_PERCENT,
  daysSince,
  displayNameSchema,
  pluralDays,
  viewerDisplayName,
} from '@shop/shared';
import { ApiError, api } from '../api/client.ts';
import { ClubChannelLink, EmptyState } from '../components/ui.tsx';
import { haptic, openChannel } from '../telegram/webapp.ts';

/** Only staff see their role; for a buyer it is noise. */
const STAFF_ROLE_LABEL: Partial<Record<Viewer['role'], string>> = {
  ADMIN: 'Администратор',
  MANAGER: 'Менеджер',
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

  const name = viewerDisplayName(viewer);
  const initial = [...name][0] ?? '👋';
  const paidOrders =
    ordersQuery.data?.filter((order) => order.status === 'PAID').length ?? null;

  const days = daysSince(viewer.createdAt);
  const staffRole = STAFF_ROLE_LABEL[viewer.role];

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
        <p className="profile-hero__tenure">
          Ты с нами {days} {pluralDays(days)}!
        </p>
      </div>

      <RenamePanel viewer={viewer} />

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
              скидку {CLUB_TIER_PERCENT}%.
            </p>
            <ClubChannelLink label="Наш канал" />
          </>
        ) : (
          <>
            <div className="row">
              <span className="club-badge">Клубный тариф не активирован</span>
            </div>
            <p className="hint" style={{ margin: 0 }}>
              Подпишитесь на наш канал, чтобы получать скидку в{' '}
              {CLUB_TIER_PERCENT}% на все товары по клубному тарифу.
            </p>
            <ClubChannelLink />
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
        {/* Role only for staff: telling a buyer they are a "Покупатель" is noise. */}
        {staffRole ? <InfoRow label="Роль" value={staffRole} /> : null}
        <InfoRow label="Telegram ID" value={viewer.telegramId} />
        {paidOrders !== null ? (
          <InfoRow label="Оплаченных заказов" value={String(paidOrders)} />
        ) : null}
      </div>

      <p className="hint" style={{ marginTop: 16 }}>
        Имя в магазине можно изменить выше — в Telegram оно останется прежним.
      </p>
    </div>
  );
}

/**
 * Collapsed rename control.
 *
 * Collapsed by default so the profile does not open as a form: renaming is a
 * rare action, and an always-visible input invites accidental edits.
 */
function RenamePanel({ viewer }: { viewer: Viewer }) {
  const [isOpen, setOpen] = useState(false);
  const [value, setValue] = useState(() => viewerDisplayName(viewer));
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (next: string | null) => api.updateDisplayName(next),
    onSuccess: (updated) => {
      // Written straight into the cache: the header reads the same `['me']`
      // entry, so it renames in the same frame instead of after a refetch.
      queryClient.setQueryData(['me'], updated);
      haptic('success');
      setOpen(false);
      setError(null);
    },
    onError: (err) => {
      haptic('error');
      setError(
        err instanceof ApiError ? err.message : 'Не удалось сохранить имя.',
      );
    },
  });

  if (!isOpen) {
    return (
      <button
        type="button"
        className="button button--secondary profile-rename__toggle"
        onClick={() => {
          haptic('tap');
          setValue(viewerDisplayName(viewer));
          setError(null);
          setOpen(true);
        }}
      >
        Изменить имя в магазине
      </button>
    );
  }

  function submit() {
    const parsed = displayNameSchema.safeParse(value);
    if (!parsed.success) {
      // Validated with the same schema the server uses, so the message the user
      // sees is the rule that will actually be enforced.
      setError(parsed.error.issues[0]?.message ?? 'Имя не подходит.');
      return;
    }
    mutation.mutate(parsed.data);
  }

  return (
    <div className="card stack profile-rename">
      <label className="hint" htmlFor="display-name">
        Как вас называть в магазине
      </label>
      <input
        id="display-name"
        className="input"
        value={value}
        maxLength={32}
        autoComplete="off"
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
        }}
      />
      {error ? (
        <p className="hint" style={{ margin: 0, color: 'var(--tg-destructive-text-color)' }}>
          {error}
        </p>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={mutation.isPending}
          onClick={submit}
        >
          {mutation.isPending ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={mutation.isPending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Отмена
        </button>
        <div className="spacer" />
        {viewer.displayName ? (
          <button
            type="button"
            className="button button--danger"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(null)}
          >
            Сбросить
          </button>
        ) : null}
      </div>
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
