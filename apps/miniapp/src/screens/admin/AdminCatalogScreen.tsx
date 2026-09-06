import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  emojiSchema,
  formatMoney,
  slugSchema,
  type Banner,
  type Category,
  type FulfillmentKind,
  type Product,
  type ProductMediaMode,
} from '@shop/shared';
import { ApiError, api } from '../../api/client.ts';
import { MediaPicker } from '../../components/MediaPicker.tsx';
import { EmptyState, ErrorState, Spinner } from '../../components/ui.tsx';
import { haptic, showAlert, showConfirm } from '../../telegram/webapp.ts';

const FULFILLMENT_LABEL: Record<FulfillmentKind, string> = {
  LICENSE_KEY: 'Ключ',
  FILE: 'Файл',
  LINK: 'Ссылка',
};

/**
 * Staff catalog: categories and products, including hidden ones.
 *
 * Uses the staff endpoints, not the public catalog: `GET /api/products` hides
 * `isActive: false`, and an admin who cannot see a deactivated product cannot
 * bring it back.
 */
export function AdminCatalogScreen() {
  const queryClient = useQueryClient();
  const [editingCategory, setEditingCategory] = useState<Category | 'new' | null>(
    null,
  );
  const [editingProduct, setEditingProduct] = useState<Product | 'new' | null>(
    null,
  );
  const [editingBanner, setEditingBanner] = useState<Banner | 'new' | null>(null);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.listCategories(),
  });
  const productsQuery = useQuery({
    queryKey: ['staff-products'],
    queryFn: () => api.listAllProducts(),
  });
  const bannersQuery = useQuery({
    queryKey: ['staff-banners'],
    queryFn: () => api.listAllBanners(),
  });

  const categories = categoriesQuery.data ?? [];
  const products = productsQuery.data ?? [];
  const banners = bannersQuery.data ?? [];

  if (categoriesQuery.isPending || productsQuery.isPending) {
    return <Spinner label="Загружаем каталог…" />;
  }
  if (categoriesQuery.isError) {
    return (
      <ErrorState
        message={(categoriesQuery.error as Error).message}
        onRetry={() => void categoriesQuery.refetch()}
      />
    );
  }
  if (productsQuery.isError) {
    return (
      <ErrorState
        message={(productsQuery.error as Error).message}
        onRetry={() => void productsQuery.refetch()}
      />
    );
  }

  return (
    <div className="page">
      <h1 className="title">Каталог</h1>
      <p className="subtitle">Категории и товары, включая скрытые</p>

      <h2 className="section-title">Категории</h2>
      <div className="stack">
        {categories.map((category) => (
          <div key={category.id} className="card row">
            <span aria-hidden="true">{category.emoji || '🗂'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{category.title}</div>
              <div className="hint">{category.slug}</div>
            </div>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                haptic('tap');
                setEditingCategory(category);
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
            setEditingCategory('new');
          }}
        >
          + Категория
        </button>
      </div>

      {editingCategory ? (
        <CategoryForm
          category={editingCategory === 'new' ? null : editingCategory}
          onClose={() => setEditingCategory(null)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['categories'] });
            setEditingCategory(null);
          }}
        />
      ) : null}

      <h2 className="section-title">Баннеры</h2>
      <div className="stack">
        {banners.map((banner) => (
          <div key={banner.id} className="card row">
            {banner.imageUrl ? (
              <img
                src={banner.imageUrl}
                alt=""
                style={{
                  width: 56,
                  height: 32,
                  objectFit: 'cover',
                  borderRadius: 6,
                }}
              />
            ) : null}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{banner.title}</div>
              <div className="hint">
                {banner.isActive ? 'Показывается' : 'Скрыт'}
              </div>
            </div>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                haptic('tap');
                setEditingBanner(banner);
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
            setEditingBanner('new');
          }}
        >
          + Баннер
        </button>
      </div>

      {editingBanner ? (
        <BannerForm
          banner={editingBanner === 'new' ? null : editingBanner}
          categories={categories}
          onClose={() => setEditingBanner(null)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['banners'] });
            void queryClient.invalidateQueries({ queryKey: ['staff-banners'] });
            setEditingBanner(null);
          }}
        />
      ) : null}

      <h2 className="section-title">Товары</h2>
      {products.length === 0 ? (
        <EmptyState
          emoji="📦"
          title="Товаров нет"
          description="Добавьте первый товар — он сразу появится в магазине."
        />
      ) : (
        <div className="stack">
          {products.map((product) => (
            <ProductRow
              key={product.id}
              product={product}
              categoryTitle={
                categories.find((c) => c.id === product.categoryId)?.title ??
                'Без категории'
              }
              onEdit={() => {
                haptic('tap');
                setEditingProduct(product);
              }}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        className="button button--secondary"
        style={{ marginTop: 12, width: '100%' }}
        onClick={() => {
          haptic('tap');
          setEditingProduct('new');
        }}
      >
        + Товар
      </button>

      {editingProduct ? (
        <ProductForm
          product={editingProduct === 'new' ? null : editingProduct}
          categories={categories}
          onClose={() => setEditingProduct(null)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['staff-products'] });
            void queryClient.invalidateQueries({ queryKey: ['products'] });
            setEditingProduct(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ProductRow({
  product,
  categoryTitle,
  onEdit,
}: {
  product: Product;
  categoryTitle: string;
  onEdit: () => void;
}) {
  return (
    <button type="button" className="card" onClick={onEdit} style={{ textAlign: 'left' }}>
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{product.title}</div>
          <div className="hint">
            {categoryTitle}
            {' · '}
            {FULFILLMENT_LABEL[product.fulfillmentKind]}
            {product.stock !== null ? ` · остаток ${product.stock}` : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 600 }}>
            {formatMoney(product.amountMinor, product.currency)}
          </div>
          <span className={product.isActive ? 'badge' : 'badge badge--danger'}>
            {product.isActive ? 'В продаже' : 'Скрыт'}
          </span>
        </div>
      </div>
    </button>
  );
}

function CategoryForm({
  category,
  onClose,
  onSaved,
}: {
  category: Category | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(category?.title ?? '');
  const [slug, setSlug] = useState(category?.slug ?? '');
  const [emoji, setEmoji] = useState(category?.emoji ?? '');
  const [error, setError] = useState<string | null>(null);
  const isNew = category === null;

  const mutation = useMutation({
    mutationFn: async () => {
      const parsed = slugSchema.safeParse(slug.trim());
      if (!parsed.success) {
        throw new Error('Slug: латиница, цифры и дефисы, например gift-cards.');
      }
      if (!title.trim()) throw new Error('Название не может быть пустым.');
      const fields = {
        title: title.trim(),
        slug: parsed.data,
        emoji: emoji.trim() || null,
      };
      // `sortOrder` is required on create and must be absent on update: sending
      // it here would reset the ordering of a category somebody had arranged.
      if (isNew) return api.createCategory({ ...fields, sortOrder: 0 });
      return api.updateCategory(category.id, fields);
    },
    onSuccess: () => {
      haptic('success');
      onSaved();
    },
    onError: (err) => {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить.');
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteCategory(category!.id),
    onSuccess: () => {
      haptic('success');
      onSaved();
    },
    onError: (err) => {
      haptic('error');
      setError(
        err instanceof ApiError ? err.message : 'Не удалось удалить категорию.',
      );
    },
  });

  return (
    <div className="card stack" style={{ marginTop: 12 }}>
      <strong>{isNew ? 'Новая категория' : 'Категория'}</strong>
      <Field label="Название">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Slug">
        <input
          className="input"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="gift-cards"
        />
      </Field>
      <Field label="Эмодзи">
        <input className="input" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
      </Field>
      {error ? <p className="hint" style={{ color: 'var(--tg-destructive-text-color)', margin: 0 }}>{error}</p> : null}
      <div className="row">
        <button type="button" className="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
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
              void showConfirm(
                'Удалить категорию? Товары останутся, но потеряют группировку.',
              ).then((ok) => {
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

function ProductForm({
  product,
  categories,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = product === null;
  const [title, setTitle] = useState(product?.title ?? '');
  const [slug, setSlug] = useState(product?.slug ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [amount, setAmount] = useState(String(product?.amountMinor ?? ''));
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(product?.imageUrl ?? null);
  const [emoji, setEmoji] = useState(product?.emoji ?? '');
  // Which artwork the card should use. Derived from what the product already
  // has, so opening an existing product lands on the mode it is actually using.
  const [mediaMode, setMediaMode] = useState<ProductMediaMode>(
    product?.imageUrl ? 'IMAGE' : 'EMOJI',
  );
  const [fulfillmentKind, setFulfillmentKind] = useState<FulfillmentKind>(
    product?.fulfillmentKind ?? 'LICENSE_KEY',
  );
  const [keysText, setKeysText] = useState('');
  const [staticPayload, setStaticPayload] = useState('');
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const parsedSlug = slugSchema.safeParse(slug.trim());
      if (!parsedSlug.success) {
        throw new Error('Slug: латиница, цифры и дефисы.');
      }
      if (!title.trim()) throw new Error('Название не может быть пустым.');
      const amountMinor = Number.parseInt(amount, 10);
      if (!Number.isInteger(amountMinor) || amountMinor < 0) {
        throw new Error('Цена — целое неотрицательное число в минорных единицах.');
      }
      const licenseKeys = keysText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      // Exactly one artwork source is written, and the other is cleared. Leaving
      // both set would make the card's appearance depend on which field a
      // component happened to check first.
      let artwork: { imageUrl: string | null; emoji: string | null };
      if (mediaMode === 'IMAGE') {
        if (!imageUrl) throw new Error('Загрузите картинку или выберите эмодзи.');
        artwork = { imageUrl, emoji: null };
      } else {
        const parsedEmoji = emojiSchema.safeParse(emoji);
        if (!parsedEmoji.success) {
          throw new Error(parsedEmoji.error.issues[0]?.message ?? 'Укажите эмодзи.');
        }
        artwork = { imageUrl: null, emoji: parsedEmoji.data };
      }

      if (isNew) {
        return api.createProduct({
          slug: parsedSlug.data,
          title: title.trim(),
          description: description.trim(),
          amountMinor,
          currency: 'XTR',
          fulfillmentKind,
          categoryId: categoryId || null,
          isActive,
          sortOrder: 0,
          ...artwork,
          staticPayload:
            fulfillmentKind === 'LICENSE_KEY' ? null : staticPayload.trim() || null,
          licenseKeys: fulfillmentKind === 'LICENSE_KEY' ? licenseKeys : undefined,
        });
      }
      return api.updateProduct(product.id, {
        slug: parsedSlug.data,
        title: title.trim(),
        description: description.trim(),
        amountMinor,
        fulfillmentKind,
        categoryId: categoryId || null,
        isActive,
        ...artwork,
        staticPayload:
          fulfillmentKind === 'LICENSE_KEY'
            ? undefined
            : staticPayload.trim() || null,
        licenseKeys: fulfillmentKind === 'LICENSE_KEY' ? licenseKeys : undefined,
      });
    },
    onSuccess: (result) => {
      haptic('success');
      if ('keysAdded' in result && result.keysAdded > 0) {
        showAlert(`Добавлено ключей: ${result.keysAdded}`);
      }
      onSaved();
    },
    onError: (err) => {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить.');
    },
  });

  const hide = useMutation({
    mutationFn: () => api.deactivateProduct(product!.id),
    onSuccess: () => {
      haptic('success');
      onSaved();
    },
    onError: (err) => {
      haptic('error');
      setError(err instanceof ApiError ? err.message : 'Не удалось скрыть товар.');
    },
  });

  const amountHint = useMemo(() => {
    const n = Number.parseInt(amount, 10);
    if (!Number.isInteger(n) || n < 0) return null;
    return formatMoney(n, 'XTR');
  }, [amount]);

  return (
    <div className="card stack" style={{ marginTop: 12 }}>
      <strong>{isNew ? 'Новый товар' : 'Товар'}</strong>
      <Field label="Название">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Slug">
        <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </Field>
      <Field label="Цена, ⭐">
        <input
          className="input"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      {amountHint ? <p className="hint" style={{ margin: 0 }}>{amountHint}</p> : null}
      <Field label="Категория">
        <select
          className="input"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Без категории</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Выдача">
        <select
          className="input"
          value={fulfillmentKind}
          onChange={(e) => setFulfillmentKind(e.target.value as FulfillmentKind)}
        >
          <option value="LICENSE_KEY">Ключ активации</option>
          <option value="FILE">Файл / ссылка на скачивание</option>
          <option value="LINK">Постоянная ссылка</option>
        </select>
      </Field>
      {fulfillmentKind === 'LICENSE_KEY' ? (
        <Field label="Ключи (по одному в строке). Уже выданные не удаляются.">
          <textarea
            className="input"
            rows={4}
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
            placeholder={'KEY-AAAA\nKEY-BBBB'}
          />
        </Field>
      ) : (
        <Field label="Ссылка / payload (записывается, в списке не показывается)">
          <input
            className="input"
            value={staticPayload}
            onChange={(e) => setStaticPayload(e.target.value)}
            placeholder="https://…"
          />
        </Field>
      )}
      <Field label="Оформление карточки">
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className={mediaMode === 'EMOJI' ? 'button' : 'button button--secondary'}
            onClick={() => setMediaMode('EMOJI')}
          >
            Эмодзи
          </button>
          <button
            type="button"
            className={mediaMode === 'IMAGE' ? 'button' : 'button button--secondary'}
            onClick={() => setMediaMode('IMAGE')}
          >
            Картинка
          </button>
        </div>
      </Field>

      {mediaMode === 'EMOJI' ? (
        <Field label="Эмодзи для карточки">
          <input
            className="input"
            value={emoji}
            maxLength={8}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="🎁"
          />
        </Field>
      ) : (
        <MediaPicker value={imageUrl} onChange={setImageUrl} shape="product" />
      )}

      <Field label="Описание">
        <textarea
          className="input"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        В продаже
      </label>
      {error ? (
        <p className="hint" style={{ color: 'var(--tg-destructive-text-color)', margin: 0 }}>
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
        {!isNew && product.isActive ? (
          <button
            type="button"
            className="button button--danger"
            disabled={hide.isPending}
            onClick={() => {
              void showConfirm(
                'Скрыть товар из витрины? Заказы с ним останутся читаемыми.',
              ).then((ok) => {
                if (ok) hide.mutate();
              });
            }}
          >
            Скрыть
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BannerForm({
  banner,
  categories,
  onClose,
  onSaved,
}: {
  banner: Banner | null;
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
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error('Заголовок не может быть пустым.');
      const fields = {
        title: title.trim(),
        subtitle: subtitle.trim() || null,
        imageUrl,
        linkUrl: linkUrl.trim() || null,
        isActive,
      };
      if (isNew) return api.createBanner({ ...fields, sortOrder: 0 });
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
      <MediaPicker value={imageUrl} onChange={setImageUrl} shape="banner" />
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
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        Показывать в магазине
      </label>
      {error ? (
        <p className="hint" style={{ color: 'var(--tg-destructive-text-color)', margin: 0 }}>
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="hint">{label}</span>
      {children}
    </label>
  );
}
