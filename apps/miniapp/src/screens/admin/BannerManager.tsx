import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BANNER_MAX_VISIBLE,
  type Banner,
  type Category,
  type MediaShape,
  type ProductSection,
} from '@shop/shared';
import { ApiError, api } from '../../api/client.ts';
import { MediaPicker } from '../../components/MediaPicker.tsx';
import { ErrorState, Spinner } from '../../components/ui.tsx';
import { haptic, showConfirm } from '../../telegram/webapp.ts';
import { Field } from './forms.tsx';

/**
 * Banner CRUD for one storefront section.
 *
 * Mounted once per staff tab and given the section it edits, so the catalog tab
 * never lists the «Абуз» poster and vice versa. Filtering happens here rather
 * than in a per-section endpoint: `GET /api/banners/all` already returns every
 * row with its `section`, and one list is one request no matter how many tabs
 * read it.
 *
 * Visibility is a switch on the row, not something buried in the form. Hiding a
 * banner is the operation staff reach for under pressure — wrong promo live,
 * campaign over — and it must not require opening an editor and finding a
 * checkbox. The switch sends `PUT { isActive }` alone, which the partial update
 * schema guarantees leaves every other field untouched.
 */
export function BannerManager({
  section,
  categories,
}: {
  section: ProductSection;
  /** Targets for the in-app `category:slug` link. */
  categories: Category[];
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Banner | 'new' | null>(null);

  const bannersQuery = useQuery({
    queryKey: ['staff-banners'],
    queryFn: () => api.listAllBanners(),
  });

  const banners = useMemo(
    () => (bannersQuery.data ?? []).filter((b) => b.section === section),
    [bannersQuery.data, section],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['staff-banners'] });
    // The storefront query is keyed by section, so both keys are refreshed:
    // moving a banner between sections changes two screens.
    void queryClient.invalidateQueries({ queryKey: ['banners'] });
  };

  /**
   * Flips visibility straight from the row.
   *
   * No optimistic update: a banner is decoration, and a switch that snaps back
   * on a failed request is more confusing than one that waits for the answer.
   */
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.updateBanner(id, { isActive }),
    onSuccess: () => {
      haptic('success');
      invalidate();
    },
    onError: () => haptic('error'),
  });

  const visibleCount = banners.filter((b) => b.isActive).length;
  const cap = BANNER_MAX_VISIBLE[section];

  /**
   * The states are rendered under the heading, not instead of it.
   *
   * This block sits between other sections of a tab, so returning early would
   * make the whole «Баннеры» section vanish while it loads — indistinguishable
   * from a section that does not exist. A failed load is reported rather than
   * shown as an empty list, which would read as "no banners yet" and invite a
   * duplicate.
   */
  return (
    <>
      <h2 className="section-title">Баннеры</h2>

      {bannersQuery.isPending ? <Spinner label="Загружаем баннеры…" /> : null}

      {bannersQuery.isError ? (
        <ErrorState
          message={(bannersQuery.error as Error).message}
          onRetry={() => void bannersQuery.refetch()}
        />
      ) : null}

      {bannersQuery.isSuccess ? (
        <>
          <p className="hint" style={{ marginTop: -8 }}>
            {/*
              The cap is server-side, so staff can switch on more banners than the
              storefront will show. Saying the number here is the only way that is not
              a mystery: the extra ones are simply never rendered.
            */}
            {section === 'ABUSE'
              ? `Квадратный баннер над каталогом раздела. На витрине показывается ${cap} — самый верхний по порядку.`
              : `Полоса над каталогом. На витрине показываются первые ${cap} по порядку.`}
            {visibleCount > cap
              ? ` Сейчас включено ${visibleCount}, остальные не видны.`
              : ''}
          </p>

          <div className="stack">
            {banners.map((banner) => (
              <div key={banner.id} className="card row">
                {banner.imageUrl ? (
                  <img
                    src={banner.imageUrl}
                    alt=""
                    style={{
                      width: section === 'ABUSE' ? 40 : 56,
                      height: 40,
                      objectFit: 'cover',
                      borderRadius: 6,
                      flex: '0 0 auto',
                    }}
                  />
                ) : null}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{banner.title}</div>
                  <div className="hint">
                    {banner.isActive ? 'Показывается' : 'Скрыт'}
                    {` · порядок ${banner.sortOrder}`}
                  </div>
                </div>
                {/*
                  A checkbox rather than a styled switch: it is the one control
                  Telegram's WebView renders natively on every platform, and a promo
                  toggle is not worth a widget that might not respond to a tap.
                */}
                <label className="row" style={{ gap: 6, flex: '0 0 auto' }}>
                  <input
                    type="checkbox"
                    checked={banner.isActive}
                    disabled={toggle.isPending}
                    onChange={(e) => {
                      haptic('selection');
                      toggle.mutate({ id: banner.id, isActive: e.target.checked });
                    }}
                  />
                  <span className="hint">Вкл</span>
                </label>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => {
                    haptic('tap');
                    setEditing(banner);
                  }}
                >
                  Изменить
                </button>
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
              + Баннер
            </button>
          </div>

          {toggle.isError ? (
            <p
              className="hint"
              style={{ color: 'var(--zone-error)', marginTop: 8 }}
            >
              Не удалось переключить показ. Попробуйте ещё раз.
            </p>
          ) : null}

          {editing ? (
            <BannerForm
              // Keyed so switching rows remounts the form: kept state would save one
              // banner's fields onto another.
              key={editing === 'new' ? 'new' : editing.id}
              banner={editing === 'new' ? null : editing}
              section={section}
              categories={categories}
              onClose={() => setEditing(null)}
              onSaved={() => {
                invalidate();
                setEditing(null);
              }}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Which recommended artwork size a section's banner is framed for. */
const MEDIA_SHAPE_BY_SECTION: Record<ProductSection, MediaShape> = {
  SHOP: 'banner',
  ABUSE: 'bannerSquare',
};

function BannerForm({
  banner,
  section,
  categories,
  onClose,
  onSaved,
}: {
  banner: Banner | null;
  /** Fixed by the tab the form was opened from, so it is not a picker. */
  section: ProductSection;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = banner === null;
  const [title, setTitle] = useState(banner?.title ?? '');
  const [subtitle, setSubtitle] = useState(banner?.subtitle ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(banner?.imageUrl ?? null);
  // `category:slug` keeps the tap inside the app; an https link leaves it.
  const [linkUrl, setLinkUrl] = useState(banner?.linkUrl ?? '');
  const [isActive, setIsActive] = useState(banner?.isActive ?? true);
  const [sortOrder, setSortOrder] = useState(String(banner?.sortOrder ?? 0));
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error('Заголовок не может быть пустым.');
      const order = Number.parseInt(sortOrder, 10);
      if (!Number.isInteger(order) || order < 0) {
        throw new Error('Порядок — целое неотрицательное число.');
      }
      const fields = {
        title: title.trim(),
        subtitle: subtitle.trim() || null,
        imageUrl,
        linkUrl: linkUrl.trim() || null,
        isActive,
        sortOrder: order,
        // Sent explicitly on update too: a banner opened from this tab belongs to
        // this section, and saying so repairs a row that was created elsewhere.
        section,
      };
      if (isNew) return api.createBanner(fields);
      return api.updateBanner(banner.id, fields);
    },
    onSuccess: () => {
      haptic('success');
      onSaved();
    },
    onError: (err) => {
      haptic('error');
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteBanner(banner!.id),
    onSuccess: () => {
      haptic('success');
      onSaved();
    },
    onError: (err) => {
      haptic('error');
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить.');
    },
  });

  return (
    <div className="card stack" style={{ marginTop: 12 }}>
      <strong>{isNew ? 'Новый баннер' : 'Баннер'}</strong>
      <Field label="Заголовок">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Подпись">
        <input
          className="input"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
        />
      </Field>
      <MediaPicker
        value={imageUrl}
        onChange={setImageUrl}
        shape={MEDIA_SHAPE_BY_SECTION[section]}
      />
      <Field label="Куда ведёт">
        <select
          className="input"
          value={linkUrl.startsWith('category:') ? linkUrl : linkUrl ? 'external' : ''}
          onChange={(e) => {
            const next = e.target.value;
            setLinkUrl(next === 'external' ? 'https://' : next);
          }}
        >
          <option value="">Без перехода</option>
          {categories.map((c) => (
            <option key={c.id} value={`category:${c.slug}`}>
              Категория: {c.title}
            </option>
          ))}
          <option value="external">Внешняя ссылка…</option>
        </select>
      </Field>
      {linkUrl && !linkUrl.startsWith('category:') ? (
        <Field label="Ссылка (только https://)">
          <input
            className="input"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://t.me/…"
          />
        </Field>
      ) : null}
      <Field label="Порядок (меньше — выше)">
        <input
          className="input"
          inputMode="numeric"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
        />
      </Field>
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        Показывать в магазине
      </label>
      {error ? (
        <p className="hint" style={{ color: 'var(--zone-error)', margin: 0 }}>
          {error}
        </p>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Сохранить
        </button>
        <button type="button" className="button button--secondary" onClick={onClose}>
          Отмена
        </button>
        <div className="spacer" />
        {!isNew ? (
          <button
            type="button"
            className="button button--danger"
            disabled={remove.isPending}
            onClick={() => {
              void showConfirm('Удалить баннер?').then((ok) => {
                if (ok) remove.mutate();
              });
            }}
          >
            Удалить
          </button>
        ) : null}
      </div>
    </div>
  );
}
