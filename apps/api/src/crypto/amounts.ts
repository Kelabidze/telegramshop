import { USDT_DECIMALS, formatWei } from '@shop/shared';

/**
 * The bridge between accounting money and on-chain money.
 *
 * Two representations exist and must never be confused:
 *
 *  - **minor units** — USDT cents, a JS `number`. What the order, the totals and
 *    every UI price use, exactly like any other decimal currency.
 *  - **wei** — 18-decimal token units, a `bigint`, persisted as a decimal string.
 *    What the chain moves and what reconciliation compares.
 *
 * A `number` cannot hold wei: 0.01 USDT is 10^16 and `Number.MAX_SAFE_INTEGER`
 * is ~9.007 × 10^15. Anything that arithmetic-ises wei goes through `bigint`
 * here, and nowhere else, so there is one place to be sure about.
 */

/** 10^18: token units in one whole USDT. */
export const WEI_PER_USDT = 10n ** BigInt(USDT_DECIMALS);
/** 10^16: token units in one USDT cent. */
export const WEI_PER_USDT_MINOR = WEI_PER_USDT / 100n;

/**
 * Cents -> exact token units.
 *
 * Exact in both directions: a cent is 10^16 wei with no remainder, so this
 * conversion never rounds and `weiToMinorFloor(minorToWei(n)) === n` holds for
 * every n. That property is what lets the UI show a cent amount while the chain
 * checks a wei amount and the two cannot disagree.
 */
export function minorToWei(amountMinor: number): bigint {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error(`Expected a non-negative integer of minor units, got ${amountMinor}`);
  }
  return BigInt(amountMinor) * WEI_PER_USDT_MINOR;
}

/**
 * Token units -> cents, rounded DOWN.
 *
 * Down, because this is used to describe money that has already arrived. Rounding
 * up would let 0.999 wei short of a cent read as a full cent, and a payment that
 * is one wei short is short — the exact comparison against `expectedAmountWei` is
 * what decides, and this number must never contradict it.
 */
export function weiToMinorFloor(wei: bigint): number {
  const minor = wei / WEI_PER_USDT_MINOR;
  // Cents comfortably fit a JS number; wei does not. Guard rather than silently
  // lose precision if an absurd amount ever appears.
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Amount too large to express in minor units');
  }
  return Number(minor);
}

/** Parses a persisted decimal string. Rejects anything that is not a plain integer. */
export function parseWei(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Malformed wei string: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Serialises for storage and for the wire. JSON has no BigInt. */
export function weiToString(wei: bigint): string {
  if (wei < 0n) throw new Error('Wei amount cannot be negative');
  return wei.toString();
}

/** Sums persisted wei strings without ever touching a float. */
export function sumWei(values: readonly string[]): bigint {
  return values.reduce<bigint>((acc, value) => acc + parseWei(value), 0n);
}

/** Human-readable amount for display, e.g. "15.00". Derived from wei, not floats. */
export function formatUsdtAmount(wei: bigint): string {
  const text = formatWei(weiToString(wei));
  // Always two decimals: an amount a buyer retypes into a wallet should look
  // like money, and "15" next to "15.00" invites doubt about which is meant.
  if (!text.includes('.')) return `${text}.00`;
  const [whole, fraction = ''] = text.split('.');
  return fraction.length >= 2 ? text : `${whole}.${fraction.padEnd(2, '0')}`;
}

/** Decodes a 32-byte hex word (an ABI uint256) into a bigint. */
export function decodeUint256(hexWord: string): bigint {
  const cleaned = hexWord.startsWith('0x') ? hexWord.slice(2) : hexWord;
  if (cleaned.length === 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error('Malformed uint256 word');
  }
  return BigInt(`0x${cleaned}`);
}
