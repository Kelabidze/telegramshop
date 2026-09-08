import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Country } from '@shop/shared';
import { api } from '../api/client.ts';
import {
  EmptyState,
  ErrorState,
  ProductSkeletonGrid,
} from '../components/ui.tsx';
import { ProductGrid } from '../components/ProductGrid.tsx';
import {
  forgetScrollPosition,
  useScrollRestoration,
} from '../hooks/useScrollRestoration.ts';
import { haptic } from '../telegram/webapp.ts';

/**
 * «Всё для Абуза».
 *
 * Same shape as the catalog, filtered along a different axis: countries instead
 * of categories. The two are separate screens rather than one parameterised
 * component because the filter is not the only difference — this section sells
 * products with variations, so its cards read "from X" and lead to a selector.
 *
 * Countries are a horizontal scroller, not a wrapping grid: a flat list of twenty
 * flags in a grid would push the products off the first screen.
 */
export function AbuseScreen({
  isSubscribedChannel,
  onOpenProduct,
}: {
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
}) {
  const [country, setCountry] = useState<string | null>(null);

  const countriesQuery = useQuery({
    queryKey: ['countries'],
    queryFn: () => api.listCountries(),
    staleTime: 5 * 60 * 1000,
  });

  const productsQuery = useQuery({
    queryKey: ['products', 'ABUSE', country],
    queryFn: () =>
      api.listProducts({
        section: 'ABUSE',
        ...(country ? { country } : {}),
      }),
  });

  useScrollRestoration(
    `abuse:${country ?? 'all'}`,
    productsQuery.data !== undefined,
  );

  const selectCountry = (next: string | null) => {
    haptic('selection');
    forgetScrollPosition(`abuse:${next ?? 'all'}`);
    setCountry(next);
    window.scrollTo(0, 0);
  };

  const countries = countriesQuery.data ?? [];
  const selectedTitle =
    countries.find((c) => c.slug === country)?.title ?? null;

  return (
    <div className="page">
      <h1 className="title">Всё для Абуза</h1>
      <p className="subtitle">Аккаунты и доступы под разные страны</p>

      {countries.length > 0 ? (
        <CountryRow
          countries={countries}
          selected={country}
          onSelect={(slug) => selectCountry(country === slug ? null : slug)}
        />
      ) : null}

      <div className="row" style={{ marginTop: 20 }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          {selectedTitle ?? 'Все товары'}
        </h2>
        <div className="spacer" />
        {country ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => selectCountry(null)}
          >
            Все страны ✕
          </button>
        ) : null}
      </div>

      {productsQuery.isPending ? <ProductSkeletonGrid /> : null}

      {productsQuery.isError ? (
        <ErrorState
          message={(productsQuery.error as Error).message}
          onRetry={() => void productsQuery.refetch()}
        />
      ) : null}

      {productsQuery.data?.length === 0 ? (
        <EmptyState
          emoji="🔍"
          title="Пока ничего нет"
          description={
            country
              ? 'Для этой страны товаров нет. Попробуйте другую.'
              : 'Раздел скоро наполнится. Заглядывайте позже.'
          }
        />
      ) : null}

      {productsQuery.data && productsQuery.data.length > 0 ? (
        <ProductGrid
          products={productsQuery.data}
          isSubscribedChannel={isSubscribedChannel}
          onOpenProduct={onOpenProduct}
        />
      ) : null}
    </div>
  );
}

function CountryRow({
  countries,
  selected,
  onSelect,
}: {
  countries: Country[];
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  return (
    <div className="country-row" style={{ marginTop: 12 }}>
      {countries.map((country) => (
        <button
          key={country.id}
          type="button"
          className="country-chip"
          aria-pressed={selected === country.slug}
          onClick={() => onSelect(country.slug)}
        >
          <span className="country-chip__flag" aria-hidden="true">
            {country.emoji || '🌍'}
          </span>
          {country.title}
        </button>
      ))}
    </div>
  );
}
