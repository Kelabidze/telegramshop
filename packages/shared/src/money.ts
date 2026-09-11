import { z } from 'zod';

/**
 * Currency handling.
 *
 * Money is ALWAYS an integer in the currency's smallest unit:
 *  - RUB/USD/EUR -> kopecks/cents (100 = 1.00)
 *  - XTR (Telegram Stars) -> whole stars, no fractions
 *
 * Never use floats for money. `0.1 + 0.2 !== 0.3`.
 */
export const CURRENCIES = ['XTR', 'RUB', 'USD', 'EUR', 'USDT'] as const;
export const currencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof currencySchema>;

/**
 * Number of minor units in one major unit. Stars have no minor units.
 *
 * USDT is 2 here, not 18. The token has 18 decimals on BSC, but that is a
 * *chain* concern: 0.01 USDT is 10^16 wei, and 10^16 exceeds
 * `Number.MAX_SAFE_INTEGER` (~9.007 × 10^15), so wei can never be a JS number.
 * Accounting therefore uses cents like any other decimal currency, and the
 * exact on-chain amount is carried separately as a decimal string. The two are
 * bridged in one place only — `apps/api/src/crypto/amounts.ts`.
 */
const CURRENCY_EXPONENT: Record<Currency, number> = {
  XTR: 0,
  RUB: 2,
  USD: 2,
  EUR: 2,
  USDT: 2,
};

export function currencyExponent(currency: Currency): number {
  return CURRENCY_EXPONENT[currency];
}

/** 1999 + RUB -> "19,99 ₽" ; 500 + XTR -> "500 ⭐" ; 1500 + USDT -> "15.00 USDT" */
export function formatMoney(
  amountMinor: number,
  currency: Currency,
  locale = 'ru-RU',
): string {
  if (currency === 'XTR') {
    return `${new Intl.NumberFormat(locale).format(amountMinor)} \u2B50`;
  }
  if (currency === 'USDT') {
    // Not `style: 'currency'`: USDT is not an ISO 4217 code, and Intl either
    // throws on it or prints the raw code in an unpredictable position. The
    // decimal separator is forced to a dot too — an amount a buyer is about to
    // retype into a wallet must not appear as "15,00".
    return `${(amountMinor / 100).toFixed(2)} USDT`;
  }
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(amountMinor / 10 ** exponent);
}

/** Money amount: non-negative integer, in minor units. */
export const amountMinorSchema = z
  .number()
  .int('Amount must be an integer in minor units')
  .nonnegative();

export const priceSchema = z.object({
  amountMinor: amountMinorSchema,
  currency: currencySchema,
});
export type Price = z.infer<typeof priceSchema>;
