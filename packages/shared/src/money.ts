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
export const CURRENCIES = ['XTR', 'RUB', 'USD', 'EUR'] as const;
export const currencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof currencySchema>;

/** Number of minor units in one major unit. Stars have no minor units. */
const CURRENCY_EXPONENT: Record<Currency, number> = {
  XTR: 0,
  RUB: 2,
  USD: 2,
  EUR: 2,
};

export function currencyExponent(currency: Currency): number {
  return CURRENCY_EXPONENT[currency];
}

/** 1999 + RUB -> "19,99 ₽" ; 500 + XTR -> "500 ⭐" */
export function formatMoney(
  amountMinor: number,
  currency: Currency,
  locale = 'ru-RU',
): string {
  if (currency === 'XTR') {
    return `${new Intl.NumberFormat(locale).format(amountMinor)} \u2B50`;
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
