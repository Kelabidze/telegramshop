import { z } from 'zod';
import { amountMinorSchema, type Currency } from './money.js';

/**
 * Deriving payable prices from one base price in RUB.
 *
 * A product has exactly one price: `basePriceRubMinor`, in kopecks. Everything a
 * buyer can actually pay with — Telegram Stars, USDT — is derived from it here.
 * Three independent price columns would need three people to remember to change
 * them together, and the one they forgot would be the one a buyer paid.
 *
 * Rates are configuration, not code, and they are snapshotted onto the order at
 * checkout. So this module answers "what does this cost right now, at this
 * rate", never "what was it charged" — that question is answered by the order.
 *
 * Everything is integer arithmetic. Rates arrive as integers in minor units
 * (kopecks per unit) precisely so no float ever touches a price.
 */

/** Kopecks in one rouble. Base prices are stored in kopecks like any RUB amount. */
export const RUB_MINOR_PER_UNIT = 100;

/**
 * Rate set used to derive payable prices.
 *
 * Both fields are "RUB kopecks for one unit of the target currency", so the
 * conversion is always `rubMinor / rate` — one direction, one formula, no
 * chance of inverting one of them by accident.
 */
export const paymentRatesSchema = z.object({
  /** Kopecks per 1 USDT. 86 ₽ -> 8600. */
  usdtRubMinorPerUnit: z.number().int().positive(),
  /** Kopecks per 1 Telegram Star. */
  starRubMinorPerUnit: z.number().int().positive(),
});
export type PaymentRates = z.infer<typeof paymentRatesSchema>;

/**
 * Currencies a buyer can be charged in.
 *
 * RUB is here now: Cashera charges roubles directly, so for that rail the base
 * currency and the charged currency are the same and no conversion happens at
 * all. That is why `convertRubMinor` is never called for RUB — a rate of 1:1
 * would still round, and rounding a number that needs no conversion is how a
 * price picks up a stray kopeck.
 */
export const PAYMENT_CURRENCIES = ['XTR', 'USDT', 'RUB'] as const;
export const paymentCurrencySchema = z.enum(PAYMENT_CURRENCIES);
export type PaymentCurrency = z.infer<typeof paymentCurrencySchema>;

/**
 * Which provider settles which currency.
 *
 * Separate from the currency because they are different questions: a currency is
 * what the buyer is charged in, a provider is who moves the money. Two providers
 * could settle roubles one day, and this is where that choice would live.
 */
export const PAYMENT_PROVIDERS = ['telegram', 'cashera', 'native_bep20'] as const;
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS);
export type PaymentProviderName = z.infer<typeof paymentProviderSchema>;

export function providerForCurrency(
  currency: PaymentCurrency,
): PaymentProviderName {
  switch (currency) {
    case 'XTR':
      return 'telegram';
    case 'RUB':
      return 'cashera';
    case 'USDT':
      return 'native_bep20';
  }
}

/**
 * Rounding for every RUB -> payable conversion: **ceil**.
 *
 * Ceil, not round-half-up, and the reason is the on-chain path. A buyer is shown
 * an amount, types it into a wallet, and the monitor compares what arrived
 * against what was expected, exactly. Rounding down would make the shop
 * systematically ask for a hair less than the base price; worse, any rounding
 * that is not applied identically on both sides turns into an `UNDERPAID` intent
 * for a buyer who paid what the screen told them to.
 *
 * So: one rule, one place, ceil. The most a buyer over-pays is one minor unit —
 * one Star, or 0.01 USDT.
 *
 * Zero stays zero: a free product must not become "1 Star".
 */
export function convertRubMinor(
  baseRubMinor: number,
  rateRubMinorPerUnit: number,
  targetExponent: number,
): number {
  if (!Number.isInteger(baseRubMinor) || baseRubMinor <= 0) return 0;
  if (!Number.isInteger(rateRubMinorPerUnit) || rateRubMinorPerUnit <= 0) {
    throw new Error('Payment rate must be a positive integer in RUB minor units');
  }
  // baseRubMinor * 10^exponent / rate, rounded up. All three are integers, and
  // the product stays far below 2^53 for any realistic price (a 10 000 000 ₽
  // product is 10^9 kopecks; × 100 is 10^11).
  const scale = 10 ** targetExponent;
  const numerator = baseRubMinor * scale;
  return Math.ceil(numerator / rateRubMinorPerUnit);
}

/** Whole Stars for a base price. Stars have no minor unit, so exponent 0. */
export function starsForRubMinor(
  baseRubMinor: number,
  rates: PaymentRates,
): number {
  return convertRubMinor(baseRubMinor, rates.starRubMinorPerUnit, 0);
}

/** USDT cents for a base price. The chain amount is derived from this, never separately. */
export function usdtMinorForRubMinor(
  baseRubMinor: number,
  rates: PaymentRates,
): number {
  return convertRubMinor(baseRubMinor, rates.usdtRubMinorPerUnit, 2);
}

/** The single dispatch point: base price -> what this currency charges. */
export function payableMinorForCurrency(
  baseRubMinor: number,
  currency: PaymentCurrency,
  rates: PaymentRates,
): number {
  switch (currency) {
    case 'XTR':
      return starsForRubMinor(baseRubMinor, rates);
    case 'USDT':
      return usdtMinorForRubMinor(baseRubMinor, rates);
    // Identity. The base currency IS roubles, so there is nothing to convert and
    // nothing to round: 499 ₽ is 49900 kopecks, which is exactly what the base
    // price already holds and exactly what Cashera is sent.
    case 'RUB':
      return baseRubMinor;
  }
}

/** The rate that was used for a currency, for snapshotting onto the order. */
export function rateForCurrency(
  currency: PaymentCurrency,
  rates: PaymentRates,
): number {
  switch (currency) {
    case 'XTR':
      return rates.starRubMinorPerUnit;
    case 'USDT':
      return rates.usdtRubMinorPerUnit;
    // 100 kopecks per rouble: the snapshot stays truthful (`base / rate` is the
    // major-unit price) without implying a conversion took place.
    case 'RUB':
      return RUB_MINOR_PER_UNIT;
  }
}

/** True when `currency` is one a buyer can be charged in. */
export function isPaymentCurrency(
  currency: Currency,
): currency is PaymentCurrency {
  return (PAYMENT_CURRENCIES as readonly string[]).includes(currency);
}

/** A base price as stored on a product: kopecks, non-negative integer. */
export const basePriceRubMinorSchema = amountMinorSchema;

/**
 * What the storefront needs to preview prices before an order exists.
 *
 * Served by the API rather than hard-coded in the client. The server recomputes
 * every amount from the database at checkout regardless, so a stale client rate
 * could never produce a wrong charge — but it would show a figure that differs
 * from the one on the payment screen, and a price that changes between two
 * screens reads as a bug or a trick. One source, fetched.
 *
 * `usdtAvailable` travels with the rates because the picker needs both to render,
 * and two requests to decide one control is one request too many.
 */
export const paymentOptionsSchema = z.object({
  /**
   * Rates for previewing prices.
   *
   * `usdtRubMinorPerUnit` is the LIVE rate when one is available, so a preview
   * matches what checkout will quote. It is still only a preview: the order is
   * priced by the rate the server resolves at creation and snapshots, never by
   * anything the client computed or echoed back.
   */
  rates: paymentRatesSchema,
  /** False when the server has on-chain payments switched off. */
  usdtAvailable: z.boolean(),
  /** False when the card gateway is not configured. Defaulted for older clients. */
  cardAvailable: z.boolean().default(false),
  /**
   * Where the USDT rate in `rates` came from, so the UI can say so. Null when no
   * live rate could be fetched — in which case USDT checkout will refuse too.
   */
  usdtRate: z
    .object({
      source: z.enum(['RAPIRA', 'CONFIG']),
      side: z.enum(['ask', 'bid']).nullable(),
      /** Major-unit string for display, e.g. "94.78". */
      display: z.string(),
    })
    .nullable()
    .default(null),
});
export type PaymentOptions = z.infer<typeof paymentOptionsSchema>;
