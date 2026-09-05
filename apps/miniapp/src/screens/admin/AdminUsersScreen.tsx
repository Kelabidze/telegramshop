import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PERMISSIONS,
  type Permission,
  type ShopUser,
  viewerDisplayName,
} from '@shop/shared';
import { ApiError, api } from '../../api/client.ts';
import { EmptyState, ErrorState, Spinner } from '../../components/ui.tsx';
import { haptic, showConfirm } from '../../telegram/webapp.ts';

const ROLE_LABEL: Record<ShopUser['role'], string> = {
  ADMIN: 'Администратор',
  MANAGER: 'Менеджер',
  USER: 'Покупатель',
};

const PERMISSION_LABEL: Record<Permission, string> = {
  EDIT_CATALOG: 'Каталог и категории',
  MANAGE_KEYS: 'Товары и ключи',
  VIEW_ORDERS: 'Все заказы',
  REFUND_ORDERS: 'Возвраты',
  MANAGE_MANAGERS: 'Персонал',
};

/**
 * Staff user list.
 *
 * Everyone, not just staff: appointing a manager starts from an existing buyer.
 * Roles are edited through the manager endpoints, which refuse to touch ADMIN —
 * that role comes from `ADMIN_TELEGRAM_IDS` and is not editable here by design.
 */
export function AdminUsersScreen() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ShopUser | null>(null);

  const query = useQuery({
    queryKey: ['staff-users', search],
    queryFn: () => api.listShopUsers(search.trim() ? { q: search.trim() } : {}),
  });

  if (query.isPending) return <Spinner label="Загружаем пользователей…" />;
  if (query.isError) {
    return (
      <ErrorState
        message={(query.error as Error).message}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const users = query.data ?? [];

  return (
    <div className="page">
      <h1 className="title">Пользователи</h1>
      <p className="subtitle">Всего в списке: {users.length}</p>

      <input
        className="input"
        style={{ marginTop: 12 }}
        value={search}
        placeholder="Поиск по имени, @username или ID"
        onChange={(event) => setSearch(event.target.value)}
      />

      {users.length === 0 ? (
        <EmptyState
          emoji="🔍"
          title="Никого не нашлось"
          description="Попробуйте другой запрос."
        />
      ) : (
        <div className="stack" style={{ marginTop: 12 }}>
          {users.map((user) => (
            <button
              key={user.id}
              type="button"
              className="card"
              style={{ textAlign: 'left' }}
              onClick={() => {
                haptic('tap');
                setSelected(user);
              }}
            >
              <div className="row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{viewerDisplayName(user)}</div>
                  <div className="hint">
                    {user.username ? `@${user.username} · ` : ''}
                    {user.telegramId}
                  </div>
                </div>
                <span
                  className={
                    user.role === 'USER' ? 'badge' : 'club-badge club-badge--active'
                  }
                >
                  {ROLE_LABEL[user.role]}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <UserDetails user={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}

function UserDetails({
  user,
  onClose,
}: {
  user: ShopUser;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [permissions, setPermissions] = useState<Permission[]>(user.permissions);
  const [error, setError] = useState<string | null>(null);

  const isConfigAdmin = user.role === 'ADMIN';

  function done() {
    void queryClient.invalidateQueries({ queryKey: ['staff-users'] });
    onClose();
  }

  const save = useMutation({
    mutationFn: () =>
      api.upsertManager({ telegramId: user.telegramId, permissions }),
    onSuccess: () => {
      haptic('success');
      done();
    },
    onError: (err) => {
      haptic('error');
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить.');
    },
  });

  const revoke = useMutation({
    mutationFn: () => api.revokeManager(user.telegramId),
    onSuccess: () => {
      haptic('success');
      done();
    },
    onError: (err) => {
      haptic('error');
      setError(err instanceof ApiError ? err.message : 'Не удалось снять роль.');
    },
  });

  return (
    <div className="card stack" style={{ marginTop: 16 }}>
      <strong>{viewerDisplayName(user)}</strong>
      <div className="stack" style={{ gap: 6 }}>
        <InfoRow label="Роль" value={ROLE_LABEL[user.role]} />
        <InfoRow label="Telegram ID" value={user.telegramId} />
        {user.username ? (
          <InfoRow label="Username" value={`@${user.username}`} />
        ) : null}
        <InfoRow label="Заказов" value={String(user.orderCount)} />
        <InfoRow
          label="В магазине с"
          value={new Date(user.createdAt).toLocaleDateString('ru-RU')}
        />
      </div>

      {isConfigAdmin ? (
        <p className="hint" style={{ margin: 0 }}>
          Доступ администратора выдаётся переменной ADMIN_TELEGRAM_IDS и не
          меняется из приложения — так его нельзя потерять или выдать по ошибке.
        </p>
      ) : (
        <>
          <span className="hint">Права менеджера</span>
          <div className="stack" style={{ gap: 6 }}>
            {PERMISSIONS.map((permission) => (
              <label key={permission} className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={permissions.includes(permission)}
                  onChange={(event) => {
                    setPermissions((prev) =>
                      event.target.checked
                        ? [...prev, permission]
                        : prev.filter((p) => p !== permission),
                    );
                  }}
                />
                {PERMISSION_LABEL[permission]}
              </label>
            ))}
          </div>
          <p className="hint" style={{ margin: 0 }}>
            Отмеченные права заменяют текущий набор целиком.
          </p>
        </>
      )}

      {error ? (
        <p
          className="hint"
          style={{ color: 'var(--tg-destructive-text-color)', margin: 0 }}
        >
          {error}
        </p>
      ) : null}

      <div className="row">
        {!isConfigAdmin ? (
          <button
            type="button"
            className="button"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            Сохранить права
          </button>
        ) : null}
        <button type="button" className="button button--secondary" onClick={onClose}>
          Закрыть
        </button>
        <div className="spacer" />
        {!isConfigAdmin && user.role === 'MANAGER' ? (
          <button
            type="button"
            className="button button--danger"
            disabled={revoke.isPending}
            onClick={() => {
              void showConfirm('Снять роль менеджера и все права?').then((ok) => {
                if (ok) revoke.mutate();
              });
            }}
          >
            Снять роль
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
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}
