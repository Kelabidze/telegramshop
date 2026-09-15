import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Category,
  type ZoneNowCard,
  type ZoneNowCardInput,
} from '@shop/shared';
import { ApiError, api } from '../../api/client.ts';
import { MediaPicker } from '../../components/MediaPicker.tsx';
import { ErrorState, Spinner } from '../../components/ui.tsx';
import { haptic, showConfirm } from '../../telegram/webapp.ts';
import { Field } from './forms.tsx';

/**
 * «Сейчас в ZONE» editorial card management.
 *
 * Mounted as a section of the catalog tab rather than a tab of its own, the same
 * way `BannerManager` is: it is one row of editorial copy, and a whole tab slot
 * for it would push a real one out of a four-slot bar.
 *
 * Only one card is shown to buyers — the active one with the lowest `sortOrder`.
 * The API enforces that by deactivating the others when one is activated, so the
 * switch below cannot produce two live cards no matter how fast it is tapped.
 * Extra rows are therefore drafts: prepared copy that publishes with one tap.
 */
export function ZoneNowManager({ categories }: { categories: Category[] }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ZoneNowCard | 'new' | null>(null);

  const cardsQuery = useQuery({
    queryKey: ['staff-zone-now'],
    queryFn: () => api.adminListZoneNowCards(),
  });

  const cards = cardsQuery.data ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['staff-zone-now'] });
    // The storefront reads its own key, so both are refreshed: publishing a card
    // has to change the home screen, not just this list.
    void queryClient.invalidateQueries({ queryKey: ['zone-now'] });
  };

  /**
   * Publishes or hides a card straight from its row.
   *
   * Sends `isActive` alone. The partial update schema guarantees nothing else is
   * touched — the same reason the banner switch works this way: pulling wrong copy
   * off the home screen is what staff reach for under pressure, and it must not
   * require opening an editor and hunting for a checkbox.
   */
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.adminUpdateZoneNowCard(id, { isActive }),
    onSuccess: () => {
      haptic('success');
      invalidate();
    },
    onError: () => haptic('error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.adminDeleteZoneNowCard(id),
    onSuccess: () => {
      haptic('success');
      invalidate();
    },
    onError: () => haptic('error'),
  });

  if (cardsQuery.isPending) return <Spinner label="Загружаем «Сейчас в ZONE»…" />;
  if (cardsQuery.isError) {
    return (
      <ErrorState
        message={(cardsQuery.error as Error).message}
        onRetry={() => void cardsQuery.refetch()}
      />
    );
  }

  const activeCount = cards.filter((card) => card.isActive).length;

  return (
    <>
      <h2 className="section-title">Сейчас в ZONE</h2>
      <p className="hint" style={{ marginBottom: 8 }}>
        {activeCount === 0
          ? 'Ни одна карточка не активна — на главной раздел скрыт.'
          : 'Покупатели видят активную карточку. Остальные — черновики.'}
      </p>

      <div className="stack">
        {cards.map((card) => (
          <div key={card.id} className="card stack">
            <div className="row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{card.title}</div>
                <div className="hint">{card.text}</div>
              </div>
              <span
                className={`badge${card.isActive ? '' : ' badge--soon'}`}
                style={
                  card.isActive
                    ? {
                        color: 'var(--zone-success)',
                        background: 'var(--zone-success-tint)',
                      }
                    : undefined
                }
              >
                {card.isActive ? 'На главной' : 'Черновик'}
              </span>
            </div>

            <div className="row">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  haptic('tap');
                  setEditing(card);
                }}
              >
                Изменить
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={toggle.isPending}
                onClick={() => {
                  haptic('tap');
                  toggle.mutate({ id: card.id, isActive: !card.isActive });
                }}
              >
                {card.isActive ? 'Снять с главной' : 'Показать на главной'}
              </button>
              <div className="spacer" />
              <button
                type="button"
                className="button button--danger"
                disabled={remove.isPending}
                onClick={() => {
                  void showConfirm(`Удалить карточку «${card.title}»?`).then(
                    (ok) => {
                      if (ok) remove.mutate(card.id);
                    },
                  );
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}

        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            haptic('tap');
            setEditing('new');
          }}
        >
          + Карточка
        </button>
      </div>

      {editing ? (
        <ZoneNowForm
          card={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate();
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Create/edit form.
 *
 * The action link is deliberately two controls rather than one free-text field:
 * the contract accepts only `https://…` or `category:slug`, and a plain input
 * invites typing `/catalog`, which passes no validation and would silently do
 * nothing if it ever reached the storefront.
 */
function ZoneNowForm({
  card,
  categories,
  onClose,
  onSaved,
}: {
  card: ZoneNowCard | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = card === null;

  const initialSlug =
    card?.actionUrl?.startsWith('category:') === true
      ? card.actionUrl.slice('category:'.length)
      : '';

  const [title, setTitle] = useState(card?.title ?? '');
  const [text, setText] = useState(card?.text ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(card?.imageUrl ?? null);
  const [actionLabel, setActionLabel] = useState(card?.actionLabel ?? '');
  const [linkKind, setLinkKind] = useState<'none' | 'category' | 'external'>(
    card?.actionUrl == null ? 'none' : initialSlug ? 'category' : 'external',
  );
  const [categorySlug, setCategorySlug] = useState(
    initialSlug || (categories[0]?.slug ?? ''),
  );
  const [externalUrl, setExternalUrl] = useState(
    card?.actionUrl && !initialSlug ? card.actionUrl : '',
  );
  const [isActive, setIsActive] = useState(card?.isActive ?? false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: ZoneNowCardInput) =>
      isNew
        ? api.adminCreateZoneNowCard(input)
        : api.adminUpdateZoneNowCard(card.id, input),
    onSuccess: () => {
      haptic('success');
      onSaved();
    },
    onError: (err) => {
      haptic('error');
      setError(
        err instanceof ApiError ? err.message : 'Не удалось сохранить карточку.',
      );
    },
  });

  const actionUrl =
    linkKind === 'category'
      ? categorySlug
        ? `category:${categorySlug}`
        : null
      : linkKind === 'external'
        ? externalUrl.trim() || null
        : null;

  // A label with no destination renders no button, so the pair is required
  // together rather than each on its own.
  const linkIncomplete =
    (actionLabel.trim().length > 0 && actionUrl === null) ||
    (actionLabel.trim().length === 0 && actionUrl !== null);

  return (
    <div className="card stack" style={{ marginTop: 16 }}>
      <strong>{isNew ? 'Новая карточка' : 'Изменить карточку'}</strong>

      <Field label="Заголовок">
        <input
          className="input"
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>

      <Field label="Текст">
        <textarea
          className="input"
          rows={3}
          value={text}
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>

      <Field label="Картинка (необязательно)">
        <MediaPicker value={imageUrl} onChange={setImageUrl} shape="product" />
      </Field>

      <Field label="Текст кнопки (необязательно)">
        <input
          className="input"
          value={actionLabel}
          maxLength={60}
          placeholder="Например: Смотреть подборку"
          onChange={(event) => setActionLabel(event.target.value)}
        />
      </Field>

      <Field label="Куда ведёт кнопка">
        <select
          className="input"
          value={linkKind}
          onChange={(event) =>
            setLinkKind(event.target.value as 'none' | 'category' | 'external')
          }
        >
          <option value="none">Без кнопки</option>
          <option value="category">Категория в приложении</option>
          <option value="external">Внешняя ссылка</option>
        </select>
      </Field>

      {linkKind === 'category' ? (
        <Field label="Категория">
          <select
            className="input"
            value={categorySlug}
            onChange={(event) => setCategorySlug(event.target.value)}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.slug}>
                {category.title}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {linkKind === 'external' ? (
        <Field label="Ссылка (только https://)">
          <input
            className="input"
            value={externalUrl}
            maxLength={2000}
            placeholder="https://t.me/…"
            onChange={(event) => setExternalUrl(event.target.value)}
          />
        </Field>
      ) : null}

      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={isActive}
          onChange={(event) => setIsActive(event.target.checked)}
        />
        <span>Показывать на главной</span>
      </label>

      {isActive ? (
        <p className="hint" style={{ margin: 0 }}>
          Остальные карточки станут черновиками: на главной видна одна.
        </p>
      ) : null}

      {linkIncomplete ? (
        <p className="hint" style={{ margin: 0, color: 'var(--zone-warning)' }}>
          Кнопка появится только если заданы и текст, и назначение.
        </p>
      ) : null}

      {error ? (
        <p className="hint" style={{ margin: 0, color: 'var(--zone-error)' }}>
          {error}
        </p>
      ) : null}

      <div className="row">
        <button
          type="button"
          className="button"
          disabled={
            save.isPending || title.trim().length === 0 || text.trim().length === 0
          }
          onClick={() => {
            setError(null);
            save.mutate({
              title: title.trim(),
              text: text.trim(),
              imageUrl,
              actionLabel: actionLabel.trim() || null,
              actionUrl,
              isActive,
              sortOrder: card?.sortOrder ?? 0,
            });
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={save.isPending}
          onClick={onClose}
        >
          Отмена
        </button>
      </div>
    </div>
  );
}
