import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney, type Country, type Product } from '@shop/shared';
import { api } from '../../api/client.ts';
import { EmptyState, ErrorState, Spinner } from '../../components/ui.tsx';
import { haptic } from '../../telegram/webapp.ts';
import { BannerManager } from './BannerManager.tsx';
import { CountryForm, ProductForm } from './forms.tsx';

/**
 * Staff screen for «Всё для абуза».
 *
 * A tab of its own rather than more sections inside the catalog screen. The
 * section is edited along a different axis than the shop: its banner, a root
 * product, the countries hanging off it, and the list of countries themselves.
 * Mixed into the catalog these were a flat list of every product — roots and
 * variations side by side, with no way to see which country a root was still
 * missing, which is what made the panel unusable at two dozen roots.
 *
 * The storefront currently shows this section as the ordinary catalog behind a
 * square banner; the country listing is switched off there. This tab is
 * unchanged by that and stays the place where roots, their country variations and
 * the country list are maintained — the data has to be ready before the listing
 * comes back, not after.
 *
 * The hierarchy is built here rather than requested: `GET /api/products/all`
 * already returns every product with its `parentId`, so grouping in memory costs
 * one pass and no extra endpoint.
 */
export function AdminAbuseScreen() {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<
    | { kind: 'root'; product: Product | 'new' }
    | { kind: 'variation'; parent: Product; product: Product | 'new' }
    | { kind: 'country'; country: Country | 'new' }
    | null
  >(null);

  const productsQuery = useQuery({
    queryKey: ['staff-products'],
    queryFn: () => api.listAllProducts(),
  });
  const countriesQuery = useQuery({
    queryKey: ['staff-countries'],
    queryFn: () => api.listAllCountries(),
  });
  /**
   * Only for the banner's in-app link target.
   *
   * Categories are managed in the catalog tab; here they are just the list of
   * places a banner tap can lead, which is the same list the storefront filters
   * by now that this section shows the ordinary catalog.
   */
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.listCategories(),
  });

  const products = productsQuery.data ?? [];
  const countries = countriesQuery.data ?? [];
  const categories = categoriesQuery.data ?? [];

  /**
   * Roots of the section with their variations attached.
   *
   * Section is read from the root only. A variation inherits its placement from
   * the parent it hangs off, and filtering children by section too would hide a
   * variation whose `section` was left at the default — making it invisible here
   * while it still sells on the storefront.
   */
  const roots = useMemo(() => {
    const byParent = new Map<string, Product[]>();
    for (const product of products) {
      if (product.parentId === null) continue;
      const siblings = byParent.get(product.parentId) ?? [];
      siblings.push(product);
      byParent.set(product.parentId, siblings);
    }
    return products
      .filter((p) => p.section === 'ABUSE' && p.parentId === null)
      .map((root) => ({ root, variations: byParent.get(root.id) ?? [] }));
  }, [products]);

  const countryById = useMemo(
    () => new Map(countries.map((c) => [c.id, c])),
    [countries],
  );

  const invalidateProducts = () => {
    void queryClient.invalidateQueries({ queryKey: ['staff-products'] });
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    // A new variation can make a previously empty country appear in the
    // storefront carousel, so that list is stale too.
    void queryClient.invalidateQueries({ queryKey: ['countries'] });
  };

  if (productsQuery.isPending || countriesQuery.isPending) {
    return <Spinner label="Загружаем раздел…" />;
  }
  if (productsQuery.isError) {
    return (
      <ErrorState
        message={(productsQuery.error as Error).message}
        onRetry={() => void productsQuery.refetch()}
      />
    );
  }
  if (countriesQuery.isError) {
    return (
      <ErrorState
        message={(countriesQuery.error as Error).message}
        onRetry={() => void countriesQuery.refetch()}
      />
    );
  }

  return (
    <div className="page">
      <h1 className="title">Всё для абуза</h1>
      <p className="subtitle">
        Баннер раздела, родительские товары, их страны и список стран
      </p>

      <BannerManager section="ABUSE" categories={categories} />

      <h2 className="section-title">Товары раздела</h2>
      <p className="hint" style={{ marginTop: -8 }}>
        Витрина раздела сейчас показывает обычный каталог: эта иерархия
        поддерживается для возврата выдачи по странам и на витрине не видна.
      </p>

      {roots.length === 0 ? (
        <EmptyState
          emoji="🎯"
          title="Раздел пуст"
          description="Добавьте родительский товар, затем привяжите к нему страны."
        />
      ) : (
        <div className="stack">
          {roots.map(({ root, variations }) => (
            <AbuseRootRow
              key={root.id}
              root={root}
              variations={variations}
              countryById={countryById}
              expanded={expandedId === root.id}
              onToggle={() => {
                haptic('tap');
                setExpandedId(expandedId === root.id ? null : root.id);
              }}
              onEditRoot={() => {
                haptic('tap');
                setEditing({ kind: 'root', product: root });
              }}
              onAddVariation={() => {
                haptic('tap');
                setEditing({ kind: 'variation', parent: root, product: 'new' });
              }}
              onEditVariation={(variation) => {
                haptic('tap');
                setEditing({
                  kind: 'variation',
                  parent: root,
                  product: variation,
                });
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
          setEditing({ kind: 'root', product: 'new' });
        }}
      >
        + Родительский товар
      </button>

      <h2 className="section-title">Страны</h2>
      <p className="hint" style={{ marginTop: -8 }}>
        Ярлыки для вариаций. Страна появляется в карусели только с активным
        товаром.
      </p>
      <div className="stack">
        {countries.map((country) => (
          <div key={country.id} className="card row">
            <span aria-hidden="true">{country.emoji || '🌍'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{country.title}</div>
              <div className="hint">
                {country.slug}
                {country.isActive ? '' : ' · скрыта'}
              </div>
            </div>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                haptic('tap');
                setEditing({ kind: 'country', country });
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
            setEditing({ kind: 'country', country: 'new' });
          }}
        >
          + Страна
        </button>
      </div>

      {/*
        One form at a time, keyed so switching rows remounts it: a form that kept
        the previous row's state would save one product's fields onto another.
      */}
      {editing?.kind === 'root' ? (
        <ProductForm
          key={editing.product === 'new' ? 'new-root' : editing.product.id}
          product={editing.product === 'new' ? null : editing.product}
          countries={countries}
          // A root of this section: no parent, and the section is not up for
          // debate — this tab is what it means.
          placement={{ kind: 'fixed', section: 'ABUSE', parentId: null }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidateProducts();
            setEditing(null);
          }}
        />
      ) : null}

      {editing?.kind === 'variation' ? (
        <ProductForm
          key={
            editing.product === 'new'
              ? `new-variation-${editing.parent.id}`
              : editing.product.id
          }
          product={editing.product === 'new' ? null : editing.product}
          countries={countries}
          placement={{
            kind: 'fixed',
            section: 'ABUSE',
            parentId: editing.parent.id,
            slugPrefix: editing.parent.slug,
          }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidateProducts();
            setEditing(null);
          }}
        />
      ) : null}

      {editing?.kind === 'country' ? (
        <CountryForm
          key={editing.country === 'new' ? 'new-country' : editing.country.id}
          country={editing.country === 'new' ? null : editing.country}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['countries'] });
            void queryClient.invalidateQueries({
              queryKey: ['staff-countries'],
            });
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * One section root with its countries.
 *
 * Collapsed by default: two dozen roots with five countries each is a hundred
 * rows, and the reason to open this screen is usually one product.
 */
function AbuseRootRow({
  root,
  variations,
  countryById,
  expanded,
  onToggle,
  onEditRoot,
  onAddVariation,
  onEditVariation,
}: {
  root: Product;
  variations: Product[];
  countryById: Map<string, Country>;
  expanded: boolean;
  onToggle: () => void;
  onEditRoot: () => void;
  onAddVariation: () => void;
  onEditVariation: (variation: Product) => void;
}) {
  const activeCount = variations.filter((v) => v.isActive).length;

  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row">
        <button
          type="button"
          className="button button--ghost"
          style={{ padding: 4 }}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Свернуть' : 'Развернуть'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span aria-hidden="true">{root.emoji || '🎯'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{root.title}</div>
          <div className="hint">
            {/*
              Zero variations is the state that breaks the storefront card, so it
              is named here instead of being shown as «0 стран» — the panel should
              say what needs doing. Worth keeping while the listing is off: a root
              left empty is what would render as «Ожидается поступление» the moment
              it comes back.
            */}
            {variations.length === 0
              ? 'нет стран — карточка будет «Ожидается поступление»'
              : `${activeCount} из ${variations.length} активны`}
            {root.isActive ? '' : ' · скрыт'}
          </div>
        </div>
        <button type="button" className="button button--ghost" onClick={onEditRoot}>
          Изменить
        </button>
      </div>

      {expanded ? (
        <div className="stack" style={{ gap: 6 }}>
          {variations.map((variation) => {
            const country = variation.countryId
              ? countryById.get(variation.countryId)
              : undefined;
            return (
              <button
                key={variation.id}
                type="button"
                className="variation-option"
                onClick={() => onEditVariation(variation)}
              >
                <span className="country-chip__flag" aria-hidden="true">
                  {country?.emoji || '🌍'}
                </span>
                <span className="variation-option__title">
                  {country?.title ?? variation.title}
                  {country ? '' : ' · без страны'}
                </span>
                <span className="hint">
                  {formatMoney(variation.amountMinor, variation.currency)}
                </span>
                {!variation.isActive ? (
                  <span className="badge badge--danger">Скрыт</span>
                ) : variation.stock !== null ? (
                  <span className="badge">{variation.stock}</span>
                ) : null}
              </button>
            );
          })}
          <button
            type="button"
            className="button button--secondary"
            onClick={onAddVariation}
          >
            + Страна к «{root.title}»
          </button>
        </div>
      ) : null}
    </div>
  );
}
