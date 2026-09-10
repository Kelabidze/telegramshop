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
import { haptic, showConfirm } from '../../telegram/webapp.ts';
import { BannerManager } from './BannerManager.tsx';
import { Field, ProductForm } from './forms.tsx';

const FULFILLMENT_LABEL: Record<FulfillmentKind, string> = {
  LICENSE_KEY: 'Ключ',
  FILE: 'Файл',
  LINK: 'Ссылка',
};

/**
 * Staff catalog: categories, the catalog's banners and shop products, including
 * hidden ones.
 *
 * Uses the staff endpoints, not the public catalog: `GET /api/products` hides
 * `isActive: false`, and an admin who cannot see a deactivated product cannot
 * bring it back.
 *
 * «Всё для абуза» is deliberately absent — it has its own tab
 * (`AdminAbuseScreen`), because it is edited by country rather than by category.
 * Its products are filtered out below so the same row is not editable from two
 * screens with different rules about placement. The same split applies to
 * banners: `BannerManager` is scoped to `SHOP` here and to `ABUSE` there, so the
 * poster of one section cannot be edited from the tab of the other.
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
  const countriesQuery = useQuery({
    queryKey: ['staff-countries'],
    queryFn: () => api.listAllCountries(),
  });

  const categories = categoriesQuery.data ?? [];
  const allProducts = productsQuery.data ?? [];
  // Only needed to keep a country label visible if an ABUSE product is somehow
  // opened here; the list itself is managed in the «Абуз» tab.
  const countries = countriesQuery.data ?? [];

  /** Shop products only: the other section has its own screen. */
  const products = useMemo(
    () => allProducts.filter((p) => p.section !== 'ABUSE'),
    [allProducts],
  );

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

      <BannerManager section="SHOP" categories={categories} />

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
          key={editingProduct === 'new' ? 'new' : editingProduct.id}
          product={editingProduct === 'new' ? null : editingProduct}
          countries={countries}
          placement={{
            kind: 'choose',
            categories,
            // Parents only: a variation of a variation has no meaning, and the
            // storefront renders exactly one level. Self-exclusion keeps a
            // product from becoming its own parent.
            parentOptions: allProducts.filter(
              (p) =>
                p.parentId === null &&
                p.id !== (editingProduct === 'new' ? '' : editingProduct.id),
            ),
          }}
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
