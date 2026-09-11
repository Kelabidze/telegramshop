import { z } from 'zod';
import { cuidSchema } from './catalog.js';
import { amountMinorSchema } from './money.js';

/**
 * On-chain payment contract (BEP20 USDT on BNB Smart Chain).
 *
 * Two amount representations travel together, and the distinction is the whole
 * point:
 *
 *  - `expectedAmountMinor` — USDT cents, an integer. Accounting, display, sums.
 *  - `expectedAmountWei`   — a decimal **string** of the exact 18-decimal token
 *                            amount. This is what the chain compares against.
 *
 * Wei is a string because 0.01 USDT is 10^16, past `Number.MAX_SAFE_INTEGER`.
 * Any code that does arithmetic on it must parse to `BigInt` first. JSON has no
 * BigInt, so the wire format is a string end to end.
 */

/** BEP20 USDT on BSC mainnet. */
export const USDT_BSC_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
/** BEP20 USDT uses 18 decimals — unlike the 6 decimals of USDT on Tron/Ethereum. */
export const USDT_DECIMALS = 18;
export const BSC_CHAIN_ID = 56;

/**
 * Intent lifecycle:
 *   AWAITING   -> address issued, nothing seen on chain yet
 *   CONFIRMING -> transfer(s) seen, not yet final
 *   CONFIRMED  -> finalised and the amount matches; the order is paid from here
 *   UNDERPAID  -> finalised but short. Still open until `expiresAt`: a top-up
 *                 lands in the same intent and can complete it.
 *   OVERPAID   -> finalised and more than asked. The order IS paid; the excess
 *                 is recorded for a human, never silently pocketed.
 *   EXPIRED    -> deadline passed with nothing final. Late transfers are still
 *                 stored, so the money is visible rather than lost.
 *   CANCELLED  -> buyer walked away before paying
 *   FAILED     -> confirmed on chain but fulfilment could not complete
 */
export const CRYPTO_PAYMENT_STATUSES = [
  'AWAITING',
  'CONFIRMING',
  'CONFIRMED',
  'UNDERPAID',
  'OVERPAID',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
] as const;
export const cryptoPaymentStatusSchema = z.enum(CRYPTO_PAYMENT_STATUSES);
export type CryptoPaymentStatus = z.infer<typeof cryptoPaymentStatusSchema>;

/** Statuses that no longer accept a new payment. */
export const TERMINAL_CRYPTO_STATUSES: readonly CryptoPaymentStatus[] = [
  'CONFIRMED',
  'OVERPAID',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
];

export function isTerminalCryptoStatus(status: CryptoPaymentStatus): boolean {
  return TERMINAL_CRYPTO_STATUSES.includes(status);
}

/**
 * On-chain transaction lifecycle:
 *   SEEN      -> log found, not final yet
 *   CONFIRMED -> at or below the finalised head, receipt and blockHash verified
 *   ORPHANED  -> the block that carried it is no longer canonical (reorg)
 */
export const CRYPTO_TX_STATUSES = ['SEEN', 'CONFIRMED', 'ORPHANED'] as const;
export const cryptoTxStatusSchema = z.enum(CRYPTO_TX_STATUSES);
export type CryptoTxStatus = z.infer<typeof cryptoTxStatusSchema>;

/** Sweep state of a deposit wallet. Sweeping itself is a later phase. */
export const SWEEP_STATUSES = [
  'NONE',
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'FAILED',
] as const;
export const sweepStatusSchema = z.enum(SWEEP_STATUSES);
export type SweepStatus = z.infer<typeof sweepStatusSchema>;

/** A decimal integer string, e.g. "15000000000000000000". Never negative. */
export const weiStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/, 'Must be a non-negative decimal integer string');

/** A 0x-prefixed, lowercase-normalised EVM address. */
export const evmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a 0x-prefixed 20-byte address');

/** A 0x-prefixed 32-byte hash. */
export const txHashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a 0x-prefixed 32-byte hash');

/** One on-chain transfer, as the buyer and staff see it. */
export const cryptoTransactionSchema = z.object({
  txHash: txHashSchema,
  logIndex: z.number().int().nonnegative(),
  amountWei: weiStringSchema,
  /** USDT cents, for display alongside the exact amount. */
  amountMinor: amountMinorSchema,
  blockNumber: z.number().int().nonnegative(),
  confirmations: z.number().int().nonnegative(),
  status: cryptoTxStatusSchema,
  firstSeenAt: z.string().datetime(),
});
export type CryptoTransactionView = z.infer<typeof cryptoTransactionSchema>;

/**
 * What the Mini App needs to display a payment and poll it.
 *
 * Deliberately absent: derivation index, derivation path, anything about the
 * master key. The address is public; how it was produced is not the client's
 * business.
 */
export const cryptoPaymentSchema = z.object({
  id: cuidSchema,
  orderId: cuidSchema,
  status: cryptoPaymentStatusSchema,

  chain: z.literal('BSC'),
  chainId: z.literal(BSC_CHAIN_ID),
  asset: z.literal('USDT'),
  /** Token contract, so the UI can name the network precisely. */
  contract: evmAddressSchema,
  decimals: z.literal(USDT_DECIMALS),

  /** Where the buyer sends funds. Unique to this payment. */
  depositAddress: evmAddressSchema,

  /** Exact on-chain amount. Compared byte-for-byte by reconciliation. */
  expectedAmountWei: weiStringSchema,
  /** Same amount as USDT cents, for display and accounting. */
  expectedAmountMinor: amountMinorSchema,
  /** Human string the buyer retypes, e.g. "15.00". Derived from wei, not floats. */
  expectedAmountDisplay: z.string(),

  /** Confirmed so far, for partial-payment feedback. */
  receivedAmountWei: weiStringSchema,
  receivedAmountMinor: amountMinorSchema,

  /** Blocks since inclusion. Technical/diagnostic only — finality decides. */
  confirmations: z.number().int().nonnegative(),

  expiresAt: z.string().datetime(),
  confirmedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),

  transactions: z.array(cryptoTransactionSchema),
});
export type CryptoPayment = z.infer<typeof cryptoPaymentSchema>;

/** Rate snapshot carried on an order, so a config change cannot rewrite history. */
export const priceSnapshotSchema = z.object({
  baseRubMinor: amountMinorSchema,
  rateRubMinorPerUnit: z.number().int().positive(),
});
export type PriceSnapshot = z.infer<typeof priceSnapshotSchema>;

/** Formats a wei string as a decimal string. Pure BigInt, no floats. */
export function formatWei(wei: string, decimals = USDT_DECIMALS): string {
  const value = BigInt(wei);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  if (fraction === 0n) return whole.toString();
  const digits = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${digits}`;
}
