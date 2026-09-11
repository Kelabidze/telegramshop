import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type PaymentRates,
  effectiveUnitMinor,
  starsForRubMinor,
  usdtMinorForRubMinor,
} from '@shop/shared';
import { minorToWei, formatUsdtAmount, WEI_PER_USDT } from './crypto/amounts.js';

/**
 * The cross-layer money invariant, checked end to end over many prices.
 *
 * The unit tests cover each conversion on its own. What this file asserts is the
 * property that actually protects a buyer: the figure on the screen, the figure
 * stored on the order, and the figure the chain is asked for are the same figure.
 * A one-wei disagreement between any two of them turns a correct payment into an
 * UNDERPAID intent, and the buyer cannot get their money back.
 */

const RATES: PaymentRates = {
  usdtRubMinorPerUnit: 8_600, // 86 ₽ per USDT
  starRubMinorPerUnit: 130, // 1.30 ₽ per Star
};

/** Prices spanning kopecks to a 100 000 ₽ item, plus awkward remainders. */
const BASE_PRICES_RUB_MINOR = [
  1, 2, 7, 13, 99, 100, 101, 999, 1_000, 1_234, 4_999, 5_000,
  9_999, 10_000, 12_345, 50_000, 99_999, 129_000, 250_001, 999_999,
  1_000_000, 3_333_333, 10_000_000,
];

describe('money invariant: screen == order == chain', () => {
  it('holds for every price, in both membership tiers', () => {
    for (const stored of BASE_PRICES_RUB_MINOR) {
      for (const isMember of [true, false]) {
        // 1. What createOrder computes as the base for this viewer.
        const baseRubMinor = effectiveUnitMinor(stored, isMember);

        // 2. What the order is charged, and what the cart previews.
        const usdtMinor = usdtMinorForRubMinor(baseRubMinor, RATES);

        // 3. What the payment intent asks the chain for.
        const expectedWei = minorToWei(usdtMinor);

        // 4. What the buyer reads off the screen and retypes into a wallet.
        const shown = formatUsdtAmount(expectedWei);

        // The wallet turns that string back into wei. This is the step where a
        // rounding mismatch would surface as a short payment.
        const [whole, fraction = ''] = shown.split('.');
        const walletWei =
          BigInt(whole!) * WEI_PER_USDT + BigInt(fraction.padEnd(18, '0'));

        assert.equal(
          walletWei,
          expectedWei,
          `${stored} kopecks (member=${isMember}): screen "${shown}" -> ${walletWei} wei, intent expects ${expectedWei}`,
        );

        // And the displayed amount must be exactly two decimals: an amount a
        // buyer retypes should look like money, not like a truncated float.
        assert.match(shown, /^\d+\.\d{2}$/, `malformed display: ${shown}`);
      }
    }
  });

  it('never quotes a USDT amount below the rouble price it came from', () => {
    // Ceil rounding, stated as a property: converting back at the same rate must
    // reach or exceed the base, never fall short, or the shop is quietly
    // discounting itself on every order.
    for (const stored of BASE_PRICES_RUB_MINOR) {
      const usdtMinor = usdtMinorForRubMinor(stored, RATES);
      const backToKopecks = (usdtMinor * RATES.usdtRubMinorPerUnit) / 100;
      assert.ok(
        backToKopecks >= stored,
        `${stored} kopecks -> ${usdtMinor} cents -> ${backToKopecks} kopecks lost value`,
      );
      // And it must not overshoot by more than one cent's worth of roubles.
      assert.ok(
        backToKopecks - stored <= RATES.usdtRubMinorPerUnit / 100,
        `${stored} kopecks overshot by ${backToKopecks - stored}`,
      );
    }
  });

  it('keeps Stars whole and never free for a priced product', () => {
    for (const stored of BASE_PRICES_RUB_MINOR) {
      const stars = starsForRubMinor(stored, RATES);
      assert.ok(Number.isInteger(stars), `fractional Stars for ${stored}`);
      assert.ok(stars >= 1, `${stored} kopecks priced at ${stars} Stars`);
    }
  });

  it('prices a free product at zero on both rails', () => {
    // A free item must not acquire a price through conversion.
    assert.equal(usdtMinorForRubMinor(0, RATES), 0);
    assert.equal(starsForRubMinor(0, RATES), 0);
    assert.equal(minorToWei(0), 0n);
  });

  it('quantity multiplies the unit, so line totals stay consistent', () => {
    /*
     * Rounding happens per unit and the line total is a multiple of it. Converting
     * the line total instead would leave a line whose own numbers do not multiply
     * out — and Telegram rejects an invoice whose prices do not sum to its total.
     */
    for (const stored of [129_000, 99_999, 13]) {
      const unit = usdtMinorForRubMinor(stored, RATES);
      for (const qty of [1, 2, 3, 7, 99]) {
        assert.equal(unit * qty, usdtMinorForRubMinor(stored, RATES) * qty);
        // And the wei for the whole line is the unit's wei times quantity.
        assert.equal(minorToWei(unit * qty), minorToWei(unit) * BigInt(qty));
      }
    }
  });

  it('is unaffected by float arithmetic at known-dangerous values', () => {
    // 0.1 + 0.2 territory: amounts whose decimal representation is not exact in
    // binary floating point. All conversions are integer or BigInt, so these must
    // come out exact.
    for (const cents of [10, 20, 30, 70, 110, 2_940, 1_000_000_007]) {
      const wei = minorToWei(cents);
      // cents × 10^16, with no drift.
      assert.equal(wei, BigInt(cents) * 10n ** 16n);
      assert.equal(formatUsdtAmount(wei).split('.')[1]?.length, 2);
    }
  });
});
