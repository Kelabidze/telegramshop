import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type PaymentRates,
  convertRubMinor,
  formatWei,
  isPaymentCurrency,
  payableMinorForCurrency,
  rateForCurrency,
  starsForRubMinor,
  usdtMinorForRubMinor,
} from '@shop/shared';
import {
  WEI_PER_USDT,
  WEI_PER_USDT_MINOR,
  formatUsdtAmount,
  minorToWei,
  parseWei,
  sumWei,
  weiToMinorFloor,
  weiToString,
} from './amounts.js';

/**
 * The RUB base price and its two derived currencies.
 *
 * The property that matters most is the last one in this file: the number shown
 * to a buyer and the number the chain is asked for must be the same number. A
 * mismatch of one wei turns a correct payment into an UNDERPAID intent.
 */

/** The production defaults: 86 ₽ per USDT, 1.30 ₽ per Star. */
const RATES: PaymentRates = {
  usdtRubMinorPerUnit: 8_600,
  starRubMinorPerUnit: 130,
};

describe('RUB -> USDT conversion', () => {
  it('converts a whole-rouble price at the configured rate', () => {
    // 1290 ₽ = 129_000 kopecks. 129_000 / 8_600 = 15 USDT exactly -> 1500 cents.
    assert.equal(usdtMinorForRubMinor(129_000, RATES), 1_500);
  });

  it('rounds UP, so the shop is never short of the base price', () => {
    // 100 ₽ = 10_000 kopecks. 10_000 / 8_600 = 1.1627... USDT.
    // Ceil to cents: 1.17 USDT = 117 cents, not 116.
    assert.equal(usdtMinorForRubMinor(10_000, RATES), 117);

    // 1 kopeck is far below a cent of USDT but must still cost something.
    assert.equal(usdtMinorForRubMinor(1, RATES), 1);
  });

  it('keeps zero at zero: a free product does not acquire a price', () => {
    assert.equal(usdtMinorForRubMinor(0, RATES), 0);
    assert.equal(starsForRubMinor(0, RATES), 0);
  });

  it('is monotonic — a higher base price never costs less', () => {
    let previous = 0;
    for (let rub = 0; rub <= 500_000; rub += 997) {
      const usdt = usdtMinorForRubMinor(rub, RATES);
      assert.ok(
        usdt >= previous,
        `price went backwards at ${rub} kopecks: ${usdt} < ${previous}`,
      );
      previous = usdt;
    }
  });

  it('never charges less than the base price is worth', () => {
    // The point of ceil: converting back at the same rate must reach or exceed
    // the original, never fall short.
    for (const rub of [1, 99, 100, 12_345, 129_000, 1_000_000]) {
      const cents = usdtMinorForRubMinor(rub, RATES);
      const backToKopecks = (cents * RATES.usdtRubMinorPerUnit) / 100;
      assert.ok(
        backToKopecks >= rub,
        `${rub} kopecks -> ${cents} cents -> ${backToKopecks} kopecks lost value`,
      );
    }
  });

  it('rejects a non-positive rate rather than dividing by it', () => {
    assert.throws(() => convertRubMinor(1_000, 0, 2), /positive integer/);
    assert.throws(() => convertRubMinor(1_000, -86, 2), /positive integer/);
  });
});

describe('RUB -> Stars conversion', () => {
  it('yields a whole number of Stars', () => {
    // 129_000 kopecks / 130 = 992.3... -> 993 whole Stars.
    const stars = starsForRubMinor(129_000, RATES);
    assert.equal(stars, 993);
    assert.ok(Number.isInteger(stars));
  });

  it('produces integers for every input, since Stars have no minor unit', () => {
    for (let rub = 1; rub <= 200_000; rub += 331) {
      assert.ok(
        Number.isInteger(starsForRubMinor(rub, RATES)),
        `fractional Stars at ${rub} kopecks`,
      );
    }
  });

  it('charges at least one Star for any non-zero price', () => {
    assert.equal(starsForRubMinor(1, RATES), 1);
  });
});

describe('payment currency dispatch', () => {
  it('routes each currency to its own derivation', () => {
    assert.equal(
      payableMinorForCurrency(129_000, 'XTR', RATES),
      starsForRubMinor(129_000, RATES),
    );
    assert.equal(
      payableMinorForCurrency(129_000, 'USDT', RATES),
      usdtMinorForRubMinor(129_000, RATES),
    );
  });

  it('reports the rate that was used, for the order snapshot', () => {
    assert.equal(rateForCurrency('USDT', RATES), 8_600);
    assert.equal(rateForCurrency('XTR', RATES), 130);
  });

  it('recognises only currencies a buyer can actually be charged in', () => {
    assert.equal(isPaymentCurrency('XTR'), true);
    assert.equal(isPaymentCurrency('USDT'), true);
    // RUB is the unit of account, not a rail: nothing charges roubles directly.
    assert.equal(isPaymentCurrency('RUB'), false);
    assert.equal(isPaymentCurrency('EUR'), false);
  });
});

describe('USDT minor units <-> wei', () => {
  it('uses 18 decimals, so one USDT is 10^18 wei', () => {
    assert.equal(WEI_PER_USDT, 10n ** 18n);
    assert.equal(WEI_PER_USDT_MINOR, 10n ** 16n);
  });

  it('converts cents to wei exactly', () => {
    assert.equal(minorToWei(1_500), 15_000_000_000_000_000_000n);
    assert.equal(minorToWei(1), 10_000_000_000_000_000n);
    assert.equal(minorToWei(0), 0n);
  });

  it('round-trips every cent amount without loss', () => {
    // The property the whole two-representation scheme rests on: a cent is a
    // whole number of wei, so nothing is ever lost converting between them.
    for (const cents of [0, 1, 2, 99, 100, 1_500, 123_456, 99_999_999]) {
      assert.equal(weiToMinorFloor(minorToWei(cents)), cents);
    }
  });

  it('floors when converting wei to cents, so a short payment reads as short', () => {
    // One wei less than 15.00 USDT must not round up to 1500 cents: the exact
    // comparison would reject it, and this number must not contradict that.
    const oneWeiShort = minorToWei(1_500) - 1n;
    assert.equal(weiToMinorFloor(oneWeiShort), 1_499);
  });

  it('refuses amounts a JS number cannot hold', () => {
    assert.throws(() => minorToWei(1.5), /non-negative integer/);
    assert.throws(() => minorToWei(-1), /non-negative integer/);
  });

  it('rejects malformed persisted strings instead of coercing them', () => {
    // A wei column is attacker-adjacent input once a log has been parsed into it.
    for (const bad of ['', '-1', '1.5', '0x10', 'abc', ' 1', '01']) {
      assert.throws(() => parseWei(bad), /Malformed wei string/, `accepted ${bad}`);
    }
    assert.equal(parseWei('0'), 0n);
    assert.equal(parseWei('15000000000000000000'), 15_000_000_000_000_000_000n);
  });

  it('sums wei with BigInt, past the safe integer range', () => {
    // Two amounts whose sum exceeds Number.MAX_SAFE_INTEGER: a float sum here
    // would silently lose the low digits.
    const total = sumWei(['9007199254740993', '9007199254740993']);
    assert.equal(total, 18_014_398_509_481_986n);
    assert.equal(weiToString(total), '18014398509481986');
  });

  it('never serialises a negative amount', () => {
    assert.throws(() => weiToString(-1n), /cannot be negative/);
  });
});

describe('display formatting', () => {
  it('formats wei as a plain decimal string', () => {
    assert.equal(formatWei('15000000000000000000'), '15');
    assert.equal(formatWei('15500000000000000000'), '15.5');
    assert.equal(formatWei('10000000000000000'), '0.01');
    assert.equal(formatWei('0'), '0');
  });

  it('always shows two decimals for an amount a buyer retypes', () => {
    assert.equal(formatUsdtAmount(minorToWei(1_500)), '15.00');
    assert.equal(formatUsdtAmount(minorToWei(1_550)), '15.50');
    assert.equal(formatUsdtAmount(minorToWei(1)), '0.01');
    assert.equal(formatUsdtAmount(0n), '0.00');
  });

  it('shows exactly what the chain will be asked for', () => {
    // The invariant that prevents "the app said 15.00 but the payment says
    // UNDERPAID": the displayed string, parsed back, must equal the expected wei.
    for (const rub of [1, 10_000, 129_000, 999_999]) {
      const cents = usdtMinorForRubMinor(rub, RATES);
      const expectedWei = minorToWei(cents);
      const shown = formatUsdtAmount(expectedWei);

      // What a wallet sends when the buyer types `shown`.
      const [whole, fraction = ''] = shown.split('.');
      const walletWei =
        BigInt(whole!) * WEI_PER_USDT +
        BigInt(fraction.padEnd(18, '0'));

      assert.equal(
        walletWei,
        expectedWei,
        `displayed ${shown} does not equal expected ${expectedWei} for ${rub} kopecks`,
      );
    }
  });
});
