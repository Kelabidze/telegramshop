import { keccak_256 } from '@noble/hashes/sha3';
import { config } from '../config.js';
import { decodeUint256 } from './amounts.js';
import { normalizeAddress } from './addresses.js';
import type { GetLogsFilter, RpcLog } from './rpc.js';
import { hexToBigInt } from './rpc.js';

/**
 * BEP20 `Transfer` events for a deposit address.
 *
 * Events, not balances. A balance answers "how much is there", which cannot
 * distinguish one payment from two, cannot be attributed to a transaction, and
 * cannot be deduplicated — so an intent settled from a balance reading can be
 * settled twice. A `Transfer` log carries a transaction hash and a log index,
 * which is what makes a payment a discrete, idempotent fact.
 */

/** `keccak256("Transfer(address,address,uint256)")` — topic0 of the event. */
export const TRANSFER_TOPIC = `0x${Buffer.from(
  keccak_256(Buffer.from('Transfer(address,address,uint256)', 'ascii')),
).toString('hex')}`;

/** An address as a 32-byte topic: left-padded to 64 hex chars. */
export function addressToTopic(address: string): string {
  return `0x${normalizeAddress(address).replace(/^0x/, '').padStart(64, '0')}`;
}

/** A 32-byte address topic back to an address. */
function topicToAddress(topic: string): string {
  return `0x${topic.replace(/^0x/, '').slice(-40)}`.toLowerCase();
}

/**
 * Filter for transfers **into** one address.
 *
 * `topics` is positional: topic0 pins the event signature, topic1 (`from`) is
 * left open, topic2 (`to`) is the deposit address. Filtering server-side matters
 * — a filter on the contract alone returns every USDT transfer on BSC.
 */
export function transferToAddressFilter(
  address: string,
  fromBlock: bigint,
  toBlock: bigint,
): GetLogsFilter {
  return {
    address: normalizeAddress(config.crypto.usdtContract),
    fromBlock,
    toBlock,
    topics: [TRANSFER_TOPIC, null, addressToTopic(address)],
  };
}

/** Filter matching transfers into any of several addresses in one call. */
export function transferToAddressesFilter(
  addresses: readonly string[],
  fromBlock: bigint,
  toBlock: bigint,
): GetLogsFilter {
  return {
    address: normalizeAddress(config.crypto.usdtContract),
    fromBlock,
    toBlock,
    // An array in a topic slot is an OR, so one request covers every open
    // address instead of one request per address per range.
    topics: [
      TRANSFER_TOPIC,
      null,
      addresses.map(addressToTopic) as unknown as string,
    ],
  };
}

export interface ParsedTransfer {
  from: string;
  to: string;
  amountWei: bigint;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
}

/**
 * Decodes one log, or returns null when it is not a transfer we can trust.
 *
 * Every field is validated rather than assumed. A log is attacker-influenced
 * input: the contract is filtered server-side, but a compromised or simply buggy
 * endpoint can return anything, and a malformed amount that parsed as garbage
 * would become a payment.
 */
export function parseTransferLog(log: RpcLog): ParsedTransfer | null {
  // `removed: true` means the log's block left the canonical chain.
  if (log.removed === true) return null;

  const topics = log.topics ?? [];
  if (topics.length < 3) return null;
  if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) return null;

  // Re-check the emitting contract: the filter should guarantee it, but this is
  // the last point before an amount becomes money.
  if (
    normalizeAddress(log.address) !== normalizeAddress(config.crypto.usdtContract)
  ) {
    return null;
  }

  if (!log.transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) {
    return null;
  }
  if (!log.blockHash || !/^0x[0-9a-fA-F]{64}$/.test(log.blockHash)) return null;

  let amountWei: bigint;
  let blockNumber: bigint;
  let logIndex: bigint;
  try {
    amountWei = decodeUint256(log.data);
    blockNumber = hexToBigInt(log.blockNumber);
    logIndex = hexToBigInt(log.logIndex);
  } catch {
    return null;
  }

  // Zero-value transfers are legal on-chain and settle nothing.
  if (amountWei <= 0n) return null;

  return {
    from: topicToAddress(topics[1]!),
    to: topicToAddress(topics[2]!),
    amountWei,
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(logIndex),
    blockNumber,
    blockHash: log.blockHash.toLowerCase(),
  };
}
