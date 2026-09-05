import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatMoney,
  slugSchema,
  type Category,
  type FulfillmentKind,
  type Product,
} from '@shop/shared';
import { ApiError, api } from '../../api/client.ts';
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

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.listCategories(),
  });
  const productsQuery = useQuery({
    queryKey: ['staff-products'],
    queryFn: () => api.listAllProducts(),
  });

  const categories = categoriesQuery.data ?? [];
  const products = productsQuery.data ?? [];

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
