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
 * Extracted from `AdminCatalogScreen` when the В«РђР±СѓР·В» section got a tab of its
 * own: both tabs write the same `Product` and the same `Country` through the
 * same endpoints. Two copies of a form that has to clear `countryId` on a
 * non-variation, or write exactly one artwork source, would only stay correct
 * until the first edit to one of them.
 */

/**
 * Where the product being edited sits in the storefront.
 *
 * The catalog tab lets staff choose freely. The В«РђР±СѓР·В» tab already knows вЂ” the
 * form was opened from a specific section root вЂ” so it fixes the placement
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
        <strong>{usdtRate ? formatMoney(usdt, 'USDT') : 'вЂ”'}</strong>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {usdtRate
          ? `РљСѓСЂСЃ ${usdtRate.display} в‚Ѕ Р·Р° USDT${usdtRate.source === 'RAPIRA' ? ' В· Rapira' : ' В· РєРѕРЅС„РёРіСѓСЂР°С†РёСЏ'}. Р Р°СЃСЃС‡РёС‚С‹РІР°РµС‚СЃСЏ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё.`
          : 'РљСѓСЂСЃ USDT РЅРµРґРѕСЃС‚СѓРїРµРЅ вЂ” С†РµРЅСѓ РІ СЂСѓР±Р»СЏС… СЌС‚Рѕ СЃРѕС…СЂР°РЅРёС‚СЊ РЅРµ РјРµС€Р°РµС‚.'}
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
   * A country belongs to an В«РђР±СѓР·В» variation and nowhere else.
   *
   * Both halves matter. A country on a product with no parent is not a variation
   * of anything, and a country on a SHOP product is worse than useless:
   * `listCountries` shows a country as soon as *any* active product references
   * it, so a stray label would put a flag in the storefront carousel whose
   * filter вЂ” which matches parents through their variations вЂ” returns nothing.
   * An empty filter reads as a broken screen.
   */
  const isCountryVariation = section === 'ABUSE' && parentId !== '';

  const mutation = useMutation({
    mutationFn: async () => {
      const parsedSlug = slugSchema.safeParse(slug.trim());
      if (!parsedSlug.success) {
        throw new Error('Slug: Р»Р°С‚РёРЅРёС†Р°, С†РёС„СЂС‹ Рё РґРµС„РёСЃС‹.');
      }
      if (!title.trim()) throw new Error('РќР°Р·РІР°РЅРёРµ РЅРµ РјРѕР¶РµС‚ Р±С‹С‚СЊ РїСѓСЃС‚С‹Рј.');
      const amountMinor = Number.parseInt(amount, 10);
      if (!Number.isInteger(amountMinor) || amountMinor < 0) {
        throw new Error('Р¦РµРЅР° вЂ” С†РµР»РѕРµ РЅРµРѕС‚СЂРёС†Р°С‚РµР»СЊРЅРѕРµ С‡РёСЃР»Рѕ РІ РјРёРЅРѕСЂРЅС‹С… РµРґРёРЅРёС†Р°С….');
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
        if (!imageUrl) throw new Error('Р—Р°РіСЂСѓР·РёС‚Рµ РєР°СЂС‚РёРЅРєСѓ РёР»Рё РІС‹Р±РµСЂРёС‚Рµ СЌРјРѕРґР·Рё.');
        artwork = { imageUrl, emoji: null };
      } else {
        const parsedEmoji = emojiSchema.safeParse(emoji);
        if (!parsedEmoji.success) {
          throw new Error(parsedEmoji.error.issues[0]?.message ?? 'РЈРєР°Р¶РёС‚Рµ СЌРјРѕРґР·Рё.');
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
        showAlert(`Р”РѕР±Р°РІР»РµРЅРѕ РєР»СЋС‡РµР№: ${result.keysAdded}`);
      }
      onSaved();
    },
    onError: (err) => {
      haptic('error');
      setError(err instanceof Error ? err.message : 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЊ.');
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
      setError(err instanceof ApiError ? err.message : 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРєСЂС‹С‚СЊ С‚РѕРІР°СЂ.');
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
            ? 'РќРѕРІР°СЏ РІР°СЂРёР°С†РёСЏ'
            : 'РќРѕРІС‹Р№ С‚РѕРІР°СЂ'
          : isCountryVariation
            ? 'Р’Р°СЂРёР°С†РёСЏ'
            : 'РўРѕРІР°СЂ'}
      </strong>

      {isCountryVariation ? (
        <Field label="РЎС‚СЂР°РЅР°">
          <select
            className="input"
            value={countryId}
            onChange={(e) => selectCountry(e.target.value)}
          >
            <option value="">Р‘РµР· СЃС‚СЂР°РЅС‹</option>
            {countries.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji ? `${c.emoji} ` : ''}
                {c.title}
                {c.isActive ? '' : ' (СЃРєСЂС‹С‚Р°)'}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field label="РќР°Р·РІР°РЅРёРµ">
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
      <Field label="Р‘Р°Р·РѕРІР°СЏ С†РµРЅР°, РєРѕРїРµР№РєРё">
        <input
          className="input"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <p className="hint" style={{ margin: 0 }}>
        {amount && Number.isInteger(Number(amount)) && Number(amount) > 0
          ? `Р­С‚Рѕ ${formatMoney(Number(amount), 'RUB')}. Stars Рё USDT СЃС‡РёС‚Р°СЋС‚СЃСЏ РѕС‚ РЅРµС‘ РїРѕ РєСѓСЂСЃСѓ СЃРµСЂРІРµСЂР°.`
          : 'Р’ РєРѕРїРµР№РєР°С…: 129000 = 1290 в‚Ѕ. Р¦РµРЅС‹ РІ Stars Рё USDT СЃС‡РёС‚Р°СЋС‚СЃСЏ РѕС‚ РЅРµС‘ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё.'}
      </p>
      {/*
        Read-only derived prices, so staff can see what a rouble figure becomes on
        the other rails before saving. There is deliberately no USDT input: two
        editable prices for one product would need keeping in step by hand, and the
        one nobody updated would be the one somebody paid.

        Absent when the rate is unknown вЂ” and that never blocks saving, because a
        rouble price must not depend on an exchange being reachable.
      */}
      <PriceDerivationPreview baseRubMinor={Number(amount)} />
      {amountHint ? <p className="hint" style={{ margin: 0 }}>{amountHint}</p> : null}
      {isSectionRoot ? (
        <p className="hint" style={{ margin: 0 }}>
          Р¦РµРЅР° СЂРѕРґРёС‚РµР»СЏ РЅРµ СЃРїРёСЃС‹РІР°РµС‚СЃСЏ: РЅР° РІРёС‚СЂРёРЅРµ РїРѕРєР°Р·С‹РІР°РµС‚СЃСЏ В«РѕС‚ XВ» РїРѕ СЃР°РјРѕР№
          РґРµС€С‘РІРѕР№ РІР°СЂРёР°С†РёРё. РћСЃС‚Р°РІСЊС‚Рµ 0.
        </p>
      ) : null}

      {/*
        Placement pickers appear only where the placement is a decision. In the
        В«РђР±СѓР·В» tab the section and the parent come from the row the form was
        opened on.
      */}
      {placement.kind === 'choose' ? (
        <>
          <Field label="Р Р°Р·РґРµР»">
            <select
              className="input"
              value={section}
              onChange={(e) => setSection(e.target.value as ProductSection)}
            >
              <option value="SHOP">РљР°С‚Р°Р»РѕРі</option>
              <option value="ABUSE">Р’СЃС‘ РґР»СЏ РђР±СѓР·Р°</option>
            </select>
          </Field>

          <Field label="РљР°С‚РµРіРѕСЂРёСЏ">
            <select
              className="input"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Р‘РµР· РєР°С‚РµРіРѕСЂРёРё</option>
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
          <Field label="Р’Р°СЂРёР°РЅС‚ С‚РѕРІР°СЂР°">
            <select
              className="input"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">РЎР°РјРѕСЃС‚РѕСЏС‚РµР»СЊРЅС‹Р№ С‚РѕРІР°СЂ</option>
              {placement.parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  Р’Р°СЂРёР°РЅС‚: {p.title}
                </option>
              ))}
            </select>
          </Field>

          {/*
            The country selector is for В«РђР±СѓР·В» variations only вЂ” see
            `isCountryVariation`. A country on a SHOP product would put a dead
            flag in the storefront carousel.
          */}
          {isCountryVariation ? (
            <Field label="РЎС‚СЂР°РЅР° РІР°СЂРёР°РЅС‚Р°">
              <select
                className="input"
                value={countryId}
                onChange={(e) => setCountryId(e.target.value)}
              >
                <option value="">Р‘РµР· СЃС‚СЂР°РЅС‹</option>
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

      <Field label="Р’С‹РґР°С‡Р°">
        <select
          className="input"
          value={fulfillmentKind}
          onChange={(e) => setFulfillmentKind(e.target.value as FulfillmentKind)}
        >
          <option value="LICENSE_KEY">РљР»СЋС‡ Р°РєС‚РёРІР°С†РёРё</option>
          <option value="FILE">Р¤Р°Р№Р» / СЃСЃС‹Р»РєР° РЅР° СЃРєР°С‡РёРІР°РЅРёРµ</option>
          <option value="LINK">РџРѕСЃС‚РѕСЏРЅРЅР°СЏ СЃСЃС‹Р»РєР°</option>
        </select>
      </Field>
      {fulfillmentKind === 'LICENSE_KEY' ? (
        <Field label="РљР»СЋС‡Рё (РїРѕ РѕРґРЅРѕРјСѓ РІ СЃС‚СЂРѕРєРµ). РЈР¶Рµ РІС‹РґР°РЅРЅС‹Рµ РЅРµ СѓРґР°Р»СЏСЋС‚СЃСЏ.">
          <textarea
            className="input"
            rows={4}
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
            placeholder={'KEY-AAAA\nKEY-BBBB'}
          />
        </Field>
      ) : (
        <Field label="РЎСЃС‹Р»РєР° / payload (Р·Р°РїРёСЃС‹РІР°РµС‚СЃСЏ, РІ СЃРїРёСЃРєРµ РЅРµ РїРѕРєР°Р·С‹РІР°РµС‚СЃСЏ)">
          <input
            className="input"
            value={staticPayload}
            onChange={(e) => setStaticPayload(e.target.value)}
            placeholder="https://вЂ¦"
          />
        </Field>
      )}
      <Field label="РћС„РѕСЂРјР»РµРЅРёРµ РєР°СЂС‚РѕС‡РєРё">
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className={mediaMode === 'EMOJI' ? 'button' : 'button button--secondary'}
            onClick={() => setMediaMode('EMOJI')}
          >
            Р­РјРѕРґР·Рё
          </button>
          <button
            type="button"
            className={mediaMode === 'IMAGE' ? 'button' : 'button button--secondary'}
            onClick={() => setMediaMode('IMAGE')}
          >
            РљР°СЂС‚РёРЅРєР°
          </button>
        </div>
      </Field>

      {mediaMode === 'EMOJI' ? (
        <Field label="Р­РјРѕРґР·Рё РґР»СЏ РєР°СЂС‚РѕС‡РєРё">
          <input
            className="input"
            value={emoji}
            maxLength={8}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="рџЋЃ"
          />
        </Field>
      ) : (
        <MediaPicker value={imageUrl} onChange={setImageUrl} shape="product" />
      )}

      <Field label="РћРїРёСЃР°РЅРёРµ">
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
        Р’ РїСЂРѕРґР°Р¶Рµ
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
          РЎРѕС…СЂР°РЅРёС‚СЊ
        </button>
        <button type="button" className="button button--secondary" onClick={onClose}>
          РћС‚РјРµРЅР°
        </button>
        <div className="spacer" />
        {!isNew && product.isActive ? (
          <button
            type="button"
            className="button button--danger"
            disabled={hide.isPending}
            onClick={() => {
              void showConfirm(
                'РЎРєСЂС‹С‚СЊ С‚РѕРІР°СЂ РёР· РІРёС‚СЂРёРЅС‹? Р—Р°РєР°Р·С‹ СЃ РЅРёРј РѕСЃС‚Р°РЅСѓС‚СЃСЏ С‡РёС‚Р°РµРјС‹РјРё.',
              ).then((ok) => {
                if (ok) hide.mutate();
              });
            }}
          >
            РЎРєСЂС‹С‚СЊ
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
        throw new Error('Slug: Р»Р°С‚РёРЅРёС†Р°, С†РёС„СЂС‹ Рё РґРµС„РёСЃС‹, РЅР°РїСЂРёРјРµСЂ united-states.');
      }
      if (!title.trim()) throw new Error('РќР°Р·РІР°РЅРёРµ РЅРµ РјРѕР¶РµС‚ Р±С‹С‚СЊ РїСѓСЃС‚С‹Рј.');
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
      setError(err instanceof ApiError ? err.message : 'РќРµ СѓРґР°Р»РѕСЃСЊ СѓРґР°Р»РёС‚СЊ.');
    },
  });

  return (
    <div className="card stack" style={{ marginTop: 12 }}>
      <strong>{isNew ? 'РќРѕРІР°СЏ СЃС‚СЂР°РЅР°' : 'РЎС‚СЂР°РЅР°'}</strong>
      <Field label="РќР°Р·РІР°РЅРёРµ">
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
      <Field label="Р¤Р»Р°Рі (СЌРјРѕРґР·Рё)">
        <input
          className="input"
          value={emoji}
          maxLength={8}
          onChange={(e) => setEmoji(e.target.value)}
          placeholder="рџ‡єрџ‡ё"
        />
      </Field>
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        РџРѕРєР°Р·С‹РІР°С‚СЊ РІ РєР°СЂСѓСЃРµР»Рё
      </label>
      <p className="hint" style={{ margin: 0 }}>
        РЎС‚СЂР°РЅР° РїРѕСЏРІРёС‚СЃСЏ РІ РєР°СЂСѓСЃРµР»Рё, С‚РѕР»СЊРєРѕ РєРѕРіРґР° Рє РЅРµР№ РїСЂРёРІСЏР·Р°РЅ С…РѕС‚СЏ Р±С‹ РѕРґРёРЅ
        Р°РєС‚РёРІРЅС‹Р№ РІР°СЂРёР°РЅС‚ С‚РѕРІР°СЂР°: РїСѓСЃС‚РѕР№ С„РёР»СЊС‚СЂ РІС‹РіР»СЏРґРёС‚ РєР°Рє СЃР»РѕРјР°РЅРЅС‹Р№ СЌРєСЂР°РЅ.
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
          РЎРѕС…СЂР°РЅРёС‚СЊ
        </button>
        <button type="button" className="button button--secondary" onClick={onClose}>
          РћС‚РјРµРЅР°
        </button>
        <div className="spacer" />
        {!isNew ? (
          <button
            type="button"
            className="button button--danger"
            disabled={remove.isPending}
            onClick={() => {
              void showConfirm(
                'РЈРґР°Р»РёС‚СЊ СЃС‚СЂР°РЅСѓ? Р’Р°СЂРёР°РЅС‚С‹ С‚РѕРІР°СЂРѕРІ РѕСЃС‚Р°РЅСѓС‚СЃСЏ, РЅРѕ РїРѕС‚РµСЂСЏСЋС‚ РїСЂРёРІСЏР·РєСѓ.',
              ).then((ok) => {
                if (ok) remove.mutate();
              });
            }}
          >
            РЈРґР°Р»РёС‚СЊ
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
