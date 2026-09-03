import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLUB_TIER_BPS,
  CLUB_TIER_PERCENT,
  cartTotals,
  effectiveUnitMinor,
  standardUnitMinor,
  tierAdjustmentMinor,
} from '@shop/shared';

/**
 * Club pricing math.
 *
 * Lives in the API workspace because that is where the test runner is: adding
 * `tsx` to `packages/shared` just to host these would be a new dependency for
 * no gain. The code under test is shared, and the API is the side that will
 * charge on it.
 */
describe('club tier pricing', () => {
  it('derives the standard price by dividing, not by adding 5%', () => {
    // 100 stored -> 105 standard. Adding 5% would give 105 here too, so the
    // difference only shows at larger amounts (below), but the direction is
    // what matters: P = L - 5% of L, therefore L = P / 0.95.
    assert.equal(standardUnitMinor(100), 105);

    // 10_000 / 0.95 = 10_526.3..., while 10_000 * 1.05 = 10_500. Getting this
    // backwards would silently understate what membership is worth.
    assert.equal(standardUnitMinor(10_000), 10_526);
    assert.notEqual(standardUnitMinor(10_000), 10_500);
  });

  it('applies the club tier to the standard price to reach the stored one', () => {
    // The defining property, checked over a wide range: taking CLUB_TIER_BPS
    // off the standard price must land back on the stored price, give or take
    // the single minor unit that integer rounding can cost.
    for (const stored of [1, 7, 19, 50, 99, 100, 499, 1_000, 12_345, 999_999]) {
      const standard = standardUnitMinor(stored);
      const roundTrip = Math.round(
        (standard * (10_000 - CLUB_TIER_BPS)) / 10_000,
      );
      assert.ok(
        Math.abs(roundTrip - stored) <= 1,
        `stored=${stored} standard=${standard} round-trip=${roundTrip}`,
      );
    }
  });

  it('always returns an integer: money is never a float', () => {
    for (const stored of [1, 3, 17, 333, 1_007, 88_888]) {
      const standard = standardUnitMinor(stored);
      assert.ok(
        Number.isInteger(standard),
        `standardUnitMinor(${stored}) = ${standard} is not an integer`,
      );
    }
  });

  it('leaves a free product free', () => {
    // Nothing to raise, and a "standard price" for a giveaway would be absurd.
    assert.equal(standardUnitMinor(0), 0);
    assert.equal(tierAdjustmentMinor(0), 0);
    assert.equal(effectiveUnitMinor(0, false), 0);
  });

  it('cannot express a club tier on a 1-star product', () => {
    // 1 / 0.95 = 1.05 -> rounds back to 1. The copy promises 5%, but on the
    // smallest possible amount in a zero-exponent currency there is no minor
    // unit to give: the member simply pays the same. Asserted so nobody
    // "fixes" it by forcing a minimum difference, which would overcharge
    // non-members by 100%.
    assert.equal(standardUnitMinor(1), 1);
    assert.equal(tierAdjustmentMinor(1), 0);
  });

  it('charges the stored price to a member and the standard price otherwise', () => {
    assert.equal(effectiveUnitMinor(1_000, true), 1_000);
    assert.equal(effectiveUnitMinor(1_000, false), standardUnitMinor(1_000));
    assert.ok(effectiveUnitMinor(1_000, false) > effectiveUnitMinor(1_000, true));
  });

  it('rounds per unit, so the cart total matches quantity × unit price', () => {
    // The API stores `unitAmountMinor` per order line and multiplies by
    // quantity. Rounding the line total instead would put the invoice and the
    // order line a minor unit apart, and the mismatch would only appear on
    // specific quantities.
    const stored = 333;
    const quantity = 7;
    const totals = cartTotals(
      [{ unitAmountMinor: stored, quantity }],
      false,
    );
    assert.equal(totals.payableMinor, standardUnitMinor(stored) * quantity);
  });

  it('sums a multi-line cart at the price the viewer pays', () => {
    const lines = [
      { unitAmountMinor: 500, quantity: 2 },
      { unitAmountMinor: 1_200, quantity: 1 },
    ];

    const member = cartTotals(lines, true);
    const guest = cartTotals(lines, false);

    assert.equal(member.payableMinor, 500 * 2 + 1_200);
    assert.equal(member.payableMinor, member.clubTierMinor);
    assert.equal(
      guest.payableMinor,
      standardUnitMinor(500) * 2 + standardUnitMinor(1_200),
    );
    assert.equal(guest.payableMinor, guest.standardMinor);

    // Both viewers agree on what membership is worth; only the amount due
    // differs. The UI shows this number as "you can save".
    assert.equal(member.tierAdjustmentMinor, guest.tierAdjustmentMinor);
    assert.equal(
      guest.tierAdjustmentMinor,
      guest.standardMinor - guest.clubTierMinor,
    );
    assert.ok(guest.tierAdjustmentMinor > 0);
  });

  it('reports an empty cart as zero rather than throwing', () => {
    const totals = cartTotals([], false);
    assert.deepEqual(totals, {
      payableMinor: 0,
      clubTierMinor: 0,
      standardMinor: 0,
      tierAdjustmentMinor: 0,
    });
  });

  it('keeps the advertised percentage in step with the stored rate', () => {
    // The UI prints CLUB_TIER_PERCENT; the math uses CLUB_TIER_BPS. Changing
    // one without the other would advertise a rate the prices do not reflect.
    assert.equal(CLUB_TIER_PERCENT, 5);
    assert.equal(CLUB_TIER_BPS, 500);
  });
});
