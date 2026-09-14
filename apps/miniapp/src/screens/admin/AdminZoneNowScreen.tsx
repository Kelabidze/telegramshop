import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ZoneNowCard, ZoneNowCardInput } from '@shop/shared';
import { api } from '../../api/client.ts';
import { haptic } from '../../telegram/webapp.ts';

/**
 * Admin: Zone Now card management.
 *
 * Create and edit the "Сейчас в ZONE" editorial card shown on Home.
 * Only one card is shown at a time (the active one with the lowest sortOrder).
 */
export function AdminZoneNowScreen() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: cards = [], isLoading } = useQuery({
    queryKey: ['admin', 'zone-now'],
    queryFn: api.adminListZoneNowCards,
  });

  const createMutation = useMutation({
    mutationFn: api.adminCreateZoneNowCard,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'zone-now'] });
      queryClient.invalidateQueries({ queryKey: ['zone-now'] });
      setCreating(false);
      haptic('success');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<ZoneNowCardInput> }) =>
      api.adminUpdateZoneNowCard(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'zone-now'] });
      queryClient.invalidateQueries({ queryKey: ['zone-now'] });
      setEditing(null);
      haptic('success');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.adminDeleteZoneNowCard,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'zone-now'] });
      queryClient.invalidateQueries({ queryKey: ['zone-now'] });
      haptic('success');
    },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const input: ZoneNowCardInput = {
      title: formData.get('title') as string,
      text: formData.get('text') as string,
      imageUrl: (formData.get('imageUrl') as string) || null,
      actionLabel: (formData.get('actionLabel') as string) || null,
      actionUrl: (formData.get('actionUrl') as string) || null,
      isActive: formData.get('isActive') === 'on',
      sortOrder: parseInt(formData.get('sortOrder') as string, 10) || 0,
    };

    if (editing) {
      updateMutation.mutate({ id: editing, input });
    } else {
      createMutation.mutate(input);
    }
  };

  if (isLoading) {
    return (
      <div className="page">
        <h1 className="title">Zone Now</h1>
        <p className="hint">Загрузка...</p>
      </div>
    );
  }

  const editingCard = editing ? cards.find((c) => c.id === editing) : null;
  const showForm = creating || editing;

  return (
    <div className="page">
      <h1 className="title">Zone Now</h1>
      <p className="hint" style={{ marginBottom: 20 }}>
        Управление карточкой «Сейчас в ZONE». Отображается только одна активная
        карточка с минимальным sortOrder.
      </p>

      {!showForm ? (
        <>
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              haptic('tap');
              setCreating(true);
            }}
            style={{ marginBottom: 20 }}
          >
            Создать карточку
          </button>

          {cards.length === 0 ? (
            <p className="hint">Нет карточек. Создайте первую.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {cards.map((card) => (
                <ZoneNowCardItem
                  key={card.id}
                  card={card}
                  onEdit={() => {
                    haptic('tap');
                    setEditing(card.id);
                  }}
                  onDelete={() => {
                    haptic('tap');
                    if (confirm(`Удалить "${card.title}"?`)) {
                      deleteMutation.mutate(card.id);
                    }
                  }}
                  onToggleActive={() => {
                    haptic('tap');
                    updateMutation.mutate({
                      id: card.id,
                      input: { isActive: !card.isActive },
                    });
                  }}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label>
            <span className="label">Заголовок</span>
            <input
              type="text"
              name="title"
              className="input"
              defaultValue={editingCard?.title ?? ''}
              required
              maxLength={120}
            />
          </label>

          <label>
            <span className="label">Текст</span>
            <textarea
              name="text"
              className="input"
              defaultValue={editingCard?.text ?? ''}
              required
              maxLength={500}
              rows={4}
            />
          </label>

          <label>
            <span className="label">Изображение (URL)</span>
            <input
              type="url"
              name="imageUrl"
              className="input"
              defaultValue={editingCard?.imageUrl ?? ''}
              maxLength={2000}
            />
          </label>

          <label>
            <span className="label">Кнопка: текст</span>
            <input
              type="text"
              name="actionLabel"
              className="input"
              defaultValue={editingCard?.actionLabel ?? ''}
              maxLength={60}
            />
          </label>

          <label>
            <span className="label">Кнопка: ссылка</span>
            <input
              type="url"
              name="actionUrl"
              className="input"
              defaultValue={editingCard?.actionUrl ?? ''}
              maxLength={2000}
            />
          </label>

          <label>
            <span className="label">Порядок сортировки</span>
            <input
              type="number"
              name="sortOrder"
              className="input"
              defaultValue={editingCard?.sortOrder ?? 0}
              min={0}
              max={10000}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={editingCard?.isActive ?? false}
            />
            <span>Активна</span>
          </label>

          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <button type="submit" className="button button--primary" disabled={createMutation.isPending || updateMutation.isPending}>
              {editing ? 'Сохранить' : 'Создать'}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                haptic('tap');
                setEditing(null);
                setCreating(false);
              }}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ZoneNowCardItem({
  card,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  card: ZoneNowCard;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
}) {
  return (
    <div
      style={{
        padding: 16,
        background: 'var(--zone-surface)',
        borderRadius: 8,
        border: '1px solid var(--zone-border)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{card.title}</h3>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--zone-text-secondary)' }}>
            {card.text.slice(0, 80)}{card.text.length > 80 ? '...' : ''}
          </p>
        </div>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 4,
            fontSize: 12,
            background: card.isActive ? 'var(--zone-success)' : 'var(--zone-text-muted)',
            color: '#fff',
          }}
        >
          {card.isActive ? 'Активна' : 'Неактивна'}
        </span>
      </div>

      {card.imageUrl && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--zone-text-muted)' }}>
          Изображение: {card.imageUrl.slice(0, 50)}...
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" className="button button--ghost button--compact" onClick={onEdit}>
          Изменить
        </button>
        <button type="button" className="button button--ghost button--compact" onClick={onToggleActive}>
          {card.isActive ? 'Деактивировать' : 'Активировать'}
        </button>
        <button
          type="button"
          className="button button--ghost button--compact"
          onClick={onDelete}
          style={{ color: 'var(--zone-error)' }}
        >
          Удалить
        </button>
      </div>
    </div>
  );
}
