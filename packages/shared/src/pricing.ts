/**
 * Club pricing.
 *
 * The amount stored in the database is the **club tier** price — what a member
 * of the Telegram channel pays (P). Everyone else pays the standard price (L),
 * defined as the amount the club adjustment reduces to the stored one:
 *
 *   P = L × (1 − 0.05)   ⇒   L = P ÷ 0.95
 *
 * This is deliberately not "stored × 1.05": losing a 5% club rate costs
 * ~5.26%, not 5%. Getting the direction wrong would understate what membership
 * is worth and make the two sides of the app disagree about the total.
 *
 * Nothing here decides what a buyer is charged — the API always recomputes
 * totals from the database. These helpers exist so the Mini App and the API
 * derive the same numbers from the same stored price.
 */

/** Club tier granted for a channel membership, in basis points (5% = 500). */
export const CLUB_TIER_BPS = 500;

const BPS_DENOMINATOR = 10_000;

/** Human-facing percentage, for copy like «Клубный тариф 5%». */
export const CLUB_TIER_PERCENT = CLUB_TIER_BPS / (BPS_DENOMINATOR / 100);

/**
 * Standard price for a stored (club tier) amount: L = round(P / 0.95).
 *
 * Integer arithmetic throughout: money is minor units, and `amount / 0.95` in
 * floating point drifts. `amount × 10000 / 9500` stays exact until the final
 * rounding, which is nearest-integer so the effective adjustment is as close to
 * 5% as an integer currency allows.
 *
 * Rounding is per unit, not per line: the API stores `unitAmountMinor` per
 * order line and multiplies by quantity, so rounding the line total instead
 * would make the two disagree by a minor unit.
 */
export function standardUnitMinor(clubTierMinor: number): number {
  if (!Number.isInteger(clubTierMinor) || clubTierMinor <= 0) {
    // 0 stays 0: a free product has no standard price to raise.
    return Math.max(0, Math.trunc(clubTierMinor));
  }
  const numerator = clubTierMinor * BPS_DENOMINATOR;
  const denominator = BPS_DENOMINATOR - CLUB_TIER_BPS;
  return Math.round(numerator / denominator);
}

/**
 * What this viewer pays for one unit.
 *
 * The single place both the API and the Mini App ask, so a member never sees
 * one number and is charged another.
 */
export function effectiveUnitMinor(
  clubTierMinor: number,
  isSubscribedChannel: boolean,
): number {
  return isSubscribedChannel ? clubTierMinor : standardUnitMinor(clubTierMinor);
}

/** What the club tier is worth on one unit: L − P. */
export function tierAdjustmentMinor(clubTierMinor: number): number {
  return standardUnitMinor(clubTierMinor) - clubTierMinor;
}

/**
 * Totals for a set of cart lines.
 *
 * Returned as a group so the UI can show the amount due and the value of
 * membership without recomputing either.
 */
export interface CartTotals {
  /** Sum at the price this viewer pays. */
  payableMinor: number;
  /** Sum at the club tier price. */
  clubTierMinor: number;
  /** Sum at the standard price. */
  standardMinor: number;
  /** standardMinor − clubTierMinor: what membership is worth on this cart. */
  tierAdjustmentMinor: number;
}

export function cartTotals(
  lines: ReadonlyArray<{ unitAmountMinor: number; quantity: number }>,
  isSubscribedChannel: boolean,
): CartTotals {
  let clubTier = 0;
  let standard = 0;
  for (const line of lines) {
    clubTier += line.unitAmountMinor * line.quantity;
    standard += standardUnitMinor(line.unitAmountMinor) * line.quantity;
  }
  return {
    payableMinor: isSubscribedChannel ? clubTier : standard,
    clubTierMinor: clubTier,
    standardMinor: standard,
    tierAdjustmentMinor: standard - clubTier,
  };
}
