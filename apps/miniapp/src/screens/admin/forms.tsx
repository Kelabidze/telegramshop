import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  emojiSchema,
  formatMoney,
  slugSchema,
  starsForRubMinor,
  usdtMinorForRubMinor,
  type Category,
  type Country,
  type FulfillmentKind,
  type Product,
  type ProductMediaMode,
  type ProductSection,
} from '@shop/shared';
import { ApiError, api } from '../../api/client.ts';
import { MediaPicker } from '../../components/MediaPicker.tsx';
import { haptic, showAlert, showConfirm } from '../../telegram/webapp.ts';

/**
 * Editing forms shared by the staff screens.
 *
 * Extracted from `AdminCatalogScreen` when the «Абуз» section got a tab of its
 * own: both tabs write the same `Product` and the same `Country` through the
 * same endpoints. Two copies of a form that has to clear `countryId` on a
 * non-variation, or write exactly one artwork source, would only stay correct
 * until the first edit to one of them.
 */

/**
 * Where the product being edited sits in the storefront.
 *
 * The catalog tab lets staff choose freely. The «Абуз» tab already knows — the
 * form was opened from a specific section root — so it fixes the placement
 * rather than offering pickers that could silently move a variation into
 * another section or hang it off the wrong parent.
 *
 * `parentOptions` lives inside the `choose` variant because a list of possible
 * parents only means anything where there is a picker to fill.
 */
export type ProductPlacement =
  | { kind: 'choose'; categories: Category[]; parentOptions: Product[] }
  | {
      kind: 'fixed';
      section: ProductSection;
      parentId: string | null;
      /** Seeds the slug of a new variation, e.g. `bybit` -> `bybit-usa`. */
      slugPrefix?: string;
    };

/**
 * Read-only preview of what a rouble price becomes on the other rails.
 *
 * Deliberately not editable. One base price with derived amounts cannot drift; two
 * editable prices would need to be kept in step by hand, and the stale one would be
 * the one a buyer pays.
 *
 * Never required for saving: the rate query is allowed to fail, and the form works
 * without it. An exchange being unreachable must not stop staff from setting a price.
 */
function PriceDerivationPreview({ baseRubMinor }: { baseRubMinor: number }) {
  const optionsQuery = useQuery({
    queryKey: ['payment-options'],
    queryFn: () => api.getPaymentOptions(),
    staleTime: 60 * 1000,
    retry: false,
  });

  const valid = Number.isInteger(baseRubMinor) && baseRubMinor > 0;
  if (!valid) return null;

  const rates = optionsQuery.data?.rates;
  const usdtRate = optionsQuery.data?.usdtRate ?? null;
  if (!rates) return null;

  const stars = starsForRubMinor(baseRubMinor, rates);
  const usdt = usdtMinorForRubMinor(baseRubMinor, rates);

  return (
    <div className="card stack" style={{ gap: 6, marginTop: 4 }}>
      <div className="row">
        <span className="hint">Telegram Stars</span>
        <div className="spacer" />
        <strong>{formatMoney(stars, 'XTR')}</strong>
      </div>
      <div className="row">
        <span className="hint">USDT</span>
        <div className="spacer" />
        <strong>{usdtRate ? formatMoney(usdt, 'USDT') : '—'}</strong>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {usdtRate
          ? `Курс ${usdtRate.display} ₽ за USDT${usdtRate.source === 'RAPIRA' ? ' · Rapira' : ' · конфигурация'}. Рассчитывается автоматически.`
          : 'Курс USDT недоступен — цену в рублях это сохранить не мешает.'}
      </p>
    </div>
  );
}

export function ProductForm({
  product,
  countries,
  placement,
  onClose,
  onSaved,
}: {
  product: Product | null;
  countries: Country[];
  placement: ProductPlacement;
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

  // Placement: the fixed variant wins over the product's stored values, because
  // it is the context the form was opened from.
  const [section, setSection] = useState<ProductSection>(
    placement.kind === 'fixed'
      ? placement.section
      : (product?.section ?? 'SHOP'),
  );
  const [parentId, setParentId] = useState(
    placement.kind === 'fixed'
      ? (placement.parentId ?? '')
      : (product?.parentId ?? ''),
  );
  const [countryId, setCountryId] = useState(product?.countryId ?? '');
  const [error, setError] = useState<string | null>(null);

  /**
   * A country belongs to an «Абуз» variation and nowhere else.
   *
   * Both halves matter. A country on a product with no parent is not a variation
   * of anything, and a country on a SHOP product is worse than useless:
   * `listCountries` shows a country as soon as *any* active product references
   * it, so a stray label would put a flag in the storefront carousel whose
   * filter — which matches parents through their variations — returns nothing.
   * An empty filter reads as a broken screen.
   */
  const isCountryVariation = section === 'ABUSE' && parentId !== '';

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

      // Sent explicitly as null when this is not a country variation: the field
      // has to be cleared on a product that used to be one, not merely ignored.
      const effectiveCountryId = isCountryVariation ? countryId || null : null;

      if (isNew) {
        return api.createProduct({
          slug: parsedSlug.data,
          title: title.trim(),
          description: description.trim(),
          amountMinor,
          // RUB is the base currency: one price per product, from which Stars and
          // USDT are derived at checkout.
          currency: 'RUB',
          fulfillmentKind,
          categoryId: categoryId || null,
          isActive,
          sortOrder: 0,
          section,
          parentId: parentId || null,
          countryId: effectiveCountryId,
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
        section,
        parentId: parentId || null,
        countryId: effectiveCountryId,
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

  /**
   * Picking a country fills the empty name and slug of a new variation.
   *
   * Only when they are still empty: overwriting what someone typed would fight
   * the person using the form. Without this, attaching countries to two dozen
   * roots means hand-typing a slug for every single one.
   */
  const selectCountry = (nextId: string) => {
    setCountryId(nextId);
    if (!isNew) return;
    const country = countries.find((c) => c.id === nextId);
    if (!country) return;
    if (!title.trim()) setTitle(country.title);
    if (!slug.trim() && placement.kind === 'fixed' && placement.slugPrefix) {
      setSlug(`${placement.slugPrefix}-${country.slug}`);
    }
  };

  // A section root is bought through its variations, so its own price is never
  // charged. Worth saying next to the field rather than leaving staff to wonder
  // why the storefront ignores what they typed.
  const isSectionRoot =
    placement.kind === 'fixed' &&
    placement.parentId === null &&
    section === 'ABUSE';

  return (
    <div className="card stack" style={{ marginTop: 12 }}>
      <strong>
        {isNew
          ? isCountryVariation
            ? 'Новая вариация'
            : 'Новый товар'
          : isCountryVariation
            ? 'Вариация'
            : 'Товар'}
      </strong>

      {isCountryVariation ? (
        <Field label="Страна">
          <select
            className="input"
            value={countryId}
            onChange={(e) => selectCountry(e.target.value)}
          >
            <option value="">Без страны</option>
            {countries.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji ? `${c.emoji} ` : ''}
                {c.title}
                {c.isActive ? '' : ' (скрыта)'}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field label="Название">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Slug">
        <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </Field>
      {/*
        Kopecks, not roubles: the field is the raw column value, and a form that
        silently multiplied by 100 would make "what did I type" and "what is
        stored" two different questions. The hint states the conversion instead.
      */}
      <Field label="Базовая цена, копейки">
        <input
          className="input"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <p className="hint" style={{ margin: 0 }}>
        {amount && Number.isInteger(Number(amount)) && Number(amount) > 0
          ? `Это ${formatMoney(Number(amount), 'RUB')}. Stars и USDT считаются от неё по курсу сервера.`
          : 'В копейках: 129000 = 1290 ₽. Цены в Stars и USDT считаются от неё автоматически.'}
      </p>
      {/*
        Read-only derived prices, so staff can see what a rouble figure becomes on
        the other rails before saving. There is deliberately no USDT input: two
        editable prices for one product would need keeping in step by hand, and the
        one nobody updated would be the one somebody paid.

        Absent when the rate is unknown — and that never blocks saving, because a
        rouble price must not depend on an exchange being reachable.
      */}
      <PriceDerivationPreview baseRubMinor={Number(amount)} />
      {amountHint ? <p className="hint" style={{ margin: 0 }}>{amountHint}</p> : null}
      {isSectionRoot ? (
        <p className="hint" style={{ margin: 0 }}>
          Цена родителя не списывается: на витрине показывается «от X» по самой
          дешёвой вариации. Оставьте 0.
        </p>
      ) : null}

      {/*
        Placement pickers appear only where the placement is a decision. In the
        «Абуз» tab the section and the parent come from the row the form was
        opened on.
      */}
      {placement.kind === 'choose' ? (
        <>
          <Field label="Раздел">
            <select
              className="input"
              value={section}
              onChange={(e) => setSection(e.target.value as ProductSection)}
            >
              <option value="SHOP">Каталог</option>
              <option value="ABUSE">Всё для Абуза</option>
            </select>
          </Field>

          <Field label="Категория">
            <select
              className="input"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Без категории</option>
              {placement.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </Field>

          {/*
            Making this a variation of another product. Parents are listed, never
            variations: a variation of a variation has no meaning, and the
            storefront only ever renders one level.
          */}
          <Field label="Вариант товара">
            <select
              className="input"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">Самостоятельный товар</option>
              {placement.parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  Вариант: {p.title}
                </option>
              ))}
            </select>
          </Field>

          {/*
            The country selector is for «Абуз» variations only — see
            `isCountryVariation`. A country on a SHOP product would put a dead
            flag in the storefront carousel.
          */}
          {isCountryVariation ? (
            <Field label="Страна варианта">
              <select
                className="input"
                value={countryId}
                onChange={(e) => setCountryId(e.target.value)}
              >
                <option value="">Без страны</option>
                {countries.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji ? `${c.emoji} ` : ''}
                    {c.title}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </>
      ) : null}

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

export function CountryForm({
  country,
  onClose,
  onSaved,
}: {
  country: Country | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = country === null;
  const [title, setTitle] = useState(country?.title ?? '');
  const [slug, setSlug] = useState(country?.slug ?? '');
  const [emoji, setEmoji] = useState(country?.emoji ?? '');
  const [isActive, setIsActive] = useState(country?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const parsed = slugSchema.safeParse(slug.trim());
      if (!parsed.success) {
        throw new Error('Slug: латиница, цифры и дефисы, например united-states.');
      }
      if (!title.trim()) throw new Error('Название не может быть пустым.');
      const fields = {
        title: title.trim(),
        slug: parsed.data,
        emoji: emoji.trim() || null,
        isActive,
      };
      if (isNew) return api.createCountry({ ...fields, sortOrder: 0 });
      return api.updateCountry(country.id, fields);
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
    mutationFn: () => api.deleteCountry(country!.id),
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
      <strong>{isNew ? 'Новая страна' : 'Страна'}</strong>
      <Field label="Название">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Slug">
        <input
          className="input"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="united-states"
        />
      </Field>
      <Field label="Флаг (эмодзи)">
        <input
          className="input"
          value={emoji}
          maxLength={8}
          onChange={(e) => setEmoji(e.target.value)}
          placeholder="🇺🇸"
        />
      </Field>
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        Показывать в карусели
      </label>
      <p className="hint" style={{ margin: 0 }}>
        Страна появится в карусели, только когда к ней привязан хотя бы один
        активный вариант товара: пустой фильтр выглядит как сломанный экран.
      </p>
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
              void showConfirm(
                'Удалить страну? Варианты товаров останутся, но потеряют привязку.',
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

export function Field({
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
