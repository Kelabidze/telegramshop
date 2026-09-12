import { config } from '../config.js';
import { prisma } from '../db.js';
import { normalizeAddress } from './addresses.js';
import { weiToString } from './amounts.js';
import { RpcError, getRpcClient, type BscRpcClient } from './rpc.js';
import { parseTransferLog, transferToAddressesFilter } from './usdt.js';
import { expireStaleIntents, reconcileIntent } from '../services/crypto-payments.js';

/**
 * The chain watcher.
 *
 * Its entire job is to turn `Transfer` logs into `CryptoTransaction` rows and
 * mark them final. It never decides an intent's status and never touches an
 * order вЂ” that belongs to `services/crypto-payments.ts`. Keeping the component
 * most exposed to RPC failures, duplicate logs and reorgs away from money
 * decisions is the point of the split.
 *
 * Four properties it is built around:
 *
 *  1. **Single-flight.** One pass at a time, enforced by a flag. A poller that
 *     spawns a detached task per tick will eventually run two passes over the
 *     same range concurrently.
 *  2. **Cursor advances only after a range is fully handled.** A crash re-reads
 *     a range; it never skips one. Skipping loses a payment permanently.
 *  3. **Deduplication is a database constraint.** `@@unique([txHash, logIndex])`
 *     plus insert-and-catch, never check-then-insert.
 *  4. **Finality comes from the `finalized` tag**, not from counting blocks.
 */

/** Bounded, so a stuck reorg check cannot wedge a pass forever. */
const MAX_REORG_CHECKS_PER_PASS = 50;

/**
 * How long a deposit address stays watched after its intent closed.
 *
 * Late transfers are the reason: a buyer can send just after the deadline, and
 * that money has to be recorded rather than silently missed. A week is far longer
 * than any plausible delay while still bounding the working set вЂ” and once
 * sweeping exists, a swept address leaves the set on its own regardless.
 */
const LATE_WATCH_MS = 7 * 24 * 60 * 60 * 1000;

export interface MonitorPassResult {
  scanned: boolean;
  headBlock: string | null;
  finalizedBlock: string | null;
  /** True when finality was inferred from depth because the tag was unavailable. */
  usedFallbackFinality: boolean;
  walletsScanned: number;
  rangesScanned: number;
  transfersFound: number;
  transfersInserted: number;
  transactionsConfirmed: number;
  transactionsOrphaned: number;
  intentsReconciled: number;
  intentsExpired: number;
  error: string | null;
}

export interface MonitorState {
  running: boolean;
  lastPassAt: string | null;
  lastSuccessAt: string | null;
  lastResult: MonitorPassResult | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** Ticks skipped because a pass was still running. */
  skippedTicks: number;
}

const state: MonitorState = {
  running: false,
  lastPassAt: null,
  lastSuccessAt: null,
  lastResult: null,
  consecutiveFailures: 0,
  lastError: null,
  skippedTicks: 0,
};

export function getMonitorState(): Readonly<MonitorState> {
  return { ...state };
}

function emptyResult(): MonitorPassResult {
  return {
    scanned: false,
    headBlock: null,
    finalizedBlock: null,
    usedFallbackFinality: false,
    walletsScanned: 0,
    rangesScanned: 0,
    transfersFound: 0,
    transfersInserted: 0,
    transactionsConfirmed: 0,
    transactionsOrphaned: 0,
    intentsReconciled: 0,
    intentsExpired: 0,
    error: null,
  };
}

/**
 * The finality frontier: everything at or below this height is settled.
 *
 * Prefers BSC's `finalized` tag, which both configured endpoints serve. Falls
 * back to a depth rule only when the tag is unavailable вЂ” and that fallback is
 * deliberately conservative, because the honest response to "I cannot tell
 * whether this is final" is to wait longer, not to assume it is.
 */
async function resolveFinalityFrontier(
  rpc: BscRpcClient,
  head: bigint,
): Promise<{ frontier: bigint; finalized: bigint | null; usedFallback: boolean }> {
  const finalized = await rpc.getFinalizedBlockNumber();
  if (finalized !== null) {
    return { frontier: finalized, finalized, usedFallback: false };
  }
  const depth = BigInt(config.crypto.fallbackConfirmations);
  const frontier = head > depth ? head - depth : 0n;
  return { frontier, finalized: null, usedFallback: true };
}

/**
 * Records the transfers found in one range.
 *
 * Insert-and-catch rather than a prior existence check: a unique-constraint
 * violation is the database telling us this exact `(txHash, logIndex)` is already
 * known, and it says so atomically. A `SELECT` first would leave the window in
 * which two passes both see nothing and both insert.
 */
async function recordTransfers(
  logs: ReturnType<typeof parseTransferLog>[],
  walletsByAddress: Map<string, { id: string; intentId: string | null }>,
): Promise<number> {
  let inserted = 0;

  for (const transfer of logs) {
    if (!transfer) continue;
    const wallet = walletsByAddress.get(normalizeAddress(transfer.to));
    // A transfer to an address we do not own cannot happen given the filter, but
    // acting on one would be worse than ignoring it.
    if (!wallet) continue;

    try {
      await prisma.cryptoTransaction.create({
        data: {
          txHash: transfer.txHash,
          logIndex: transfer.logIndex,
          walletId: wallet.id,
          // Attached to whichever intent the address currently serves. Null when
          // the intent expired or was never created: the money is recorded either
          // way, so late funds stay visible instead of vanishing.
          intentId: wallet.intentId,
          fromAddress: normalizeAddress(transfer.from),
          amountWei: weiToString(transfer.amountWei),
          blockNumber: transfer.blockNumber,
          blockHash: transfer.blockHash,
          status: 'SEEN',
        },
      });
      inserted += 1;
    } catch {
      // Already recorded. Exactly the outcome the unique key exists to produce.
    }
  }

  return inserted;
}

/**
 * Promotes finalised transfers and demotes ones whose block is gone.
 *
 * A log being returned by `eth_getLogs` is not proof the transaction survived:
 * the block can be reorged away. So before a transfer counts as money, the
 * canonical block at its height must still carry the hash we recorded, and the
 * receipt must show success.
 */
async function settleSeenTransactions(
  rpc: BscRpcClient,
  head: bigint,
  frontier: bigint,
): Promise<{ confirmed: number; orphaned: number; touchedIntents: Set<string> }> {
  const pending = await prisma.cryptoTransaction.findMany({
    where: { status: 'SEEN' },
    orderBy: { blockNumber: 'asc' },
    take: MAX_REORG_CHECKS_PER_PASS,
    select: {
      id: true,
      txHash: true,
      blockNumber: true,
      blockHash: true,
      intentId: true,
    },
  });

  let confirmed = 0;
  let orphaned = 0;
  const touchedIntents = new Set<string>();

  for (const tx of pending) {
    const confirmations = head >= tx.blockNumber ? head - tx.blockNumber : 0n;

    // Keep the diagnostic counter fresh even while waiting for finality, so the
    // UI can show progress rather than a frozen zero.
    await prisma.cryptoTransaction.update({
      where: { id: tx.id },
      data: { confirmations: Number(confirmations) },
    });

    if (tx.blockNumber > frontier) continue;

    // Reorg check: is the block we saw it in still the canonical one?
    const canonicalHash = await rpc.getBlockHash(tx.blockNumber);
    if (canonicalHash && canonicalHash.toLowerCase() !== tx.blockHash) {
      await prisma.cryptoTransaction.update({
        where: { id: tx.id },
        data: { status: 'ORPHANED' },
      });
      orphaned += 1;
      if (tx.intentId) touchedIntents.add(tx.intentId);
      continue;
    }

    // And did the transaction itself succeed? A reverted transaction can still
    // appear in a block.
    const receipt = await rpc.getTransactionReceipt(tx.txHash);
    if (!receipt || receipt.status !== '0x1') {
      // No receipt yet is not a failure вЂ” leave it SEEN and look again next pass.
      if (receipt && receipt.status !== '0x1') {
        await prisma.cryptoTransaction.update({
          where: { id: tx.id },
          data: { status: 'ORPHANED' },
        });
        orphaned += 1;
        if (tx.intentId) touchedIntents.add(tx.intentId);
      }
      continue;
    }
    if (receipt.blockHash.toLowerCase() !== tx.blockHash) {
      await prisma.cryptoTransaction.update({
        where: { id: tx.id },
        data: { status: 'ORPHANED' },
      });
      orphaned += 1;
      if (tx.intentId) touchedIntents.add(tx.intentId);
      continue;
    }

    await prisma.cryptoTransaction.update({
      where: { id: tx.id },
      data: {
        status: 'CONFIRMED',
        confirmations: Number(confirmations),
        confirmedAt: new Date(),
      },
    });
    confirmed += 1;
    if (tx.intentId) touchedIntents.add(tx.intentId);
  }

  return { confirmed, orphaned, touchedIntents };
}

/**
 * Reads one block range, halving it if an endpoint refuses the size.
 *
 * Public BSC endpoints cap `eth_getLogs` differently and inconsistently вЂ” a probe
 * against mainnet answered "limit exceeded" for a range the configured window
 * allowed. Giving up on such a range would stall the cursor behind it forever, and
 * widening the window is not something the operator should have to tune per
 * provider. So the range is split and retried, and the cursor advances only over
 * the part actually covered.
 *
 * Returns how far it got: on partial success the caller records that height, and
 * the next pass resumes from there rather than re-reading or skipping.
 */
async function scanRange(
  rpc: BscRpcClient,
  addresses: string[],
  from: bigint,
  to: bigint,
): Promise<{
  parsed: ReturnType<typeof parseTransferLog>[];
  covered: bigint;
  requests: number;
}> {
  const parsed: ReturnType<typeof parseTransferLog>[] = [];
  let cursor = from;
  let requests = 0;
  let span = to - from + 1n;

  while (cursor <= to) {
    const end = cursor + span - 1n > to ? to : cursor + span - 1n;
    try {
      const logs = await rpc.getLogs(
        transferToAddressesFilter(addresses, cursor, end),
      );
      requests += 1;
      for (const log of logs) parsed.push(parseTransferLog(log));
      cursor = end + 1n;
      continue;
    } catch (error) {
      requests += 1;
      const tooWide =
        error instanceof RpcError &&
        error.retryable &&
        span > 1n;
      if (!tooWide) {
        // Either not a size problem, or already down to a single block. Report how
        // far we genuinely got; `cursor - 1n` may be `from - 1n`, which correctly
        // means "nothing new was covered".
        if (cursor === from) throw error;
        return { parsed, covered: cursor - 1n, requests };
      }
      // Halve and retry the same starting point.
      span = span / 2n;
    }
  }

  return { parsed, covered: to, requests };
}

/** One full pass. Callers must serialise; `startMonitor` does. */
export async function runMonitorPass(): Promise<MonitorPassResult> {
  const result = emptyResult();
  if (!config.crypto.enabled) return result;

  const rpc = getRpcClient();
  const head = await rpc.getBlockNumber();
  const { frontier, finalized, usedFallback } = await resolveFinalityFrontier(
    rpc,
    head,
  );

  result.scanned = true;
  result.headBlock = head.toString();
  result.finalizedBlock = finalized === null ? null : finalized.toString();
  result.usedFallbackFinality = usedFallback;

  /**
   * Which addresses to watch.
   *
   * Wider than "intents that are still open", on purpose. A transfer can land
   * just after the deadline, or simply be slow, and an address dropped from the
   * scan set the moment its intent closed would make that money invisible: the
   * funds sit at an address the shop controls but has no record of receiving, and
   * the buyer has nothing to point at.
   *
   * So an address stays watched while any of these hold:
   *  - its intent can still be paid;
   *  - it has a transfer that has not reached finality yet;
   *  - it holds confirmed funds that have not been swept.
   *
   * The last arm is what keeps a settled-but-unswept address in view, and it is
   * also why this does not grow without bound: once sweeping exists, a swept
   * wallet leaves the set. Until then `LATE_WATCH_MS` bounds it by age instead вЂ”
   * an address nobody has paid in a week is not about to be paid.
   */
  const lateWatchFrom = new Date(Date.now() - LATE_WATCH_MS);
  const wallets = await prisma.depositWallet.findMany({
    where: {
      OR: [
        { intent: { status: { in: ['AWAITING', 'CONFIRMING', 'UNDERPAID'] } } },
        { transactions: { some: { status: 'SEEN' } } },
        // Recently-closed intents: the window in which a late transfer is
        // plausible. Bounded by age so the working set cannot grow forever.
        {
          sweepStatus: { in: ['NONE', 'PENDING'] },
          createdAt: { gte: lateWatchFrom },
        },
      ],
    },
    take: 200,
    select: {
      id: true,
      address: true,
      lastScannedBlock: true,
      intent: { select: { id: true, status: true } },
    },
  });

  result.walletsScanned = wallets.length;

  const walletsByAddress = new Map(
    wallets.map((w) => [
      normalizeAddress(w.address),
      { id: w.id, intentId: w.intent?.id ?? null },
    ]),
  );

  /**
   * Group addresses by their cursor so one `eth_getLogs` covers many of them.
   *
   * Topic slots accept an array as an OR, so wallets sharing a starting block
   * share a request. Per-wallet requests would multiply RPC load by the number of
   * open payments вЂ” the failure mode the exchanger's per-wallet loop had.
   */
  const byCursor = new Map<string, { from: bigint; addresses: string[]; ids: string[] }>();
  for (const wallet of wallets) {
    // A wallet with no cursor starts slightly before now: it cannot have been
    // paid before it existed, so earlier history holds nothing for it.
    const lag = BigInt(config.crypto.scanStartLagBlocks);
    const start =
      wallet.lastScannedBlock > 0n
        ? wallet.lastScannedBlock + 1n
        : head > lag
          ? head - lag
          : 0n;
    const key = start.toString();
    const bucket = byCursor.get(key) ?? { from: start, addresses: [], ids: [] };
    bucket.addresses.push(wallet.address);
    bucket.ids.push(wallet.id);
    byCursor.set(key, bucket);
  }

  const window = BigInt(config.crypto.scanWindowBlocks);
  const touchedIntents = new Set<string>();

  for (const bucket of byCursor.values()) {
    if (bucket.from > head) continue;

    // One window per pass per bucket. A wallet far behind catches up over several
    // passes rather than issuing one enormous request that the endpoint refuses.
    const to = bucket.from + window - 1n > head ? head : bucket.from + window - 1n;

    const scanned = await scanRange(rpc, bucket.addresses, bucket.from, to);
    result.rangesScanned += scanned.requests;
    result.transfersFound += scanned.parsed.filter((p) => p !== null).length;
    result.transfersInserted += await recordTransfers(
      scanned.parsed,
      walletsByAddress,
    );

    // Cursor advances only now, after the range's logs are recorded вЂ” and only to
    // the height actually covered. Advancing before, or past an unscanned gap,
    // would turn a failure into a permanently skipped range.
    await prisma.depositWallet.updateMany({
      where: { id: { in: bucket.ids } },
      data: { lastScannedBlock: scanned.covered },
    });
  }

  const settled = await settleSeenTransactions(rpc, head, frontier);
  result.transactionsConfirmed = settled.confirmed;
  result.transactionsOrphaned = settled.orphaned;
  for (const id of settled.touchedIntents) touchedIntents.add(id);

  // Any intent whose address received something this pass is worth recomputing,
  // even if nothing confirmed: it may need to move AWAITING -> CONFIRMING.
  if (result.transfersInserted > 0) {
    for (const wallet of wallets) {
      if (wallet.intent) touchedIntents.add(wallet.intent.id);
    }
  }

  for (const intentId of touchedIntents) {
    await reconcileIntent(intentId);
    result.intentsReconciled += 1;
  }

  result.intentsExpired = await expireStaleIntents();

  return result;
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;

/**
 * Starts the polling loop.
 *
 * `setTimeout` chained after each pass, not `setInterval`: an interval fires
 * regardless of whether the previous pass finished, which is how overlapping
 * passes start. Backoff is exponential on consecutive failures so a dead RPC
 * produces a slowing trickle of retries rather than a hot loop.
 */
export function startMonitor(log: {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}): void {
  if (!config.crypto.enabled) {
    log.info({ reason: 'crypto payments disabled' }, 'USDT monitor not started');
    return;
  }
  if (config.crypto.monitorIntervalMs === 0) {
    log.info({ reason: 'interval is 0' }, 'USDT monitor not started');
    return;
  }
  if (timer) return;

  stopped = false;
  log.info(
    {
      intervalMs: config.crypto.monitorIntervalMs,
      windowBlocks: config.crypto.scanWindowBlocks,
      endpoints: getRpcClient().getStats().endpointCount,
    },
    'USDT monitor started',
  );

  const tick = async () => {
    if (stopped) return;

    // Single-flight. A skipped tick is recorded rather than silently dropped, so
    // a pass that consistently outlasts the interval is visible.
    if (state.running) {
      state.skippedTicks += 1;
      schedule(config.crypto.monitorIntervalMs);
      return;
    }

    state.running = true;
    state.lastPassAt = new Date().toISOString();
    try {
      const result = await runMonitorPass();
      state.lastResult = result;
      state.lastSuccessAt = new Date().toISOString();
      state.consecutiveFailures = 0;
      state.lastError = null;

      // Only log passes that did something: a quiet shop would otherwise fill the
      // journal with identical "nothing happened" lines.
      if (
        result.transfersFound > 0 ||
        result.transfersInserted > 0 ||
        result.transactionsConfirmed > 0 ||
        result.transactionsOrphaned > 0 ||
        result.intentsExpired > 0
      ) {
        log.info(
          {
            head: result.headBlock,
            finalized: result.finalizedBlock,
            fallbackFinality: result.usedFallbackFinality,
            wallets: result.walletsScanned,
            ranges: result.rangesScanned,
            found: result.transfersFound,
            inserted: result.transfersInserted,
            confirmed: result.transactionsConfirmed,
            orphaned: result.transactionsOrphaned,
            reconciled: result.intentsReconciled,
            expired: result.intentsExpired,
          },
          'USDT monitor pass',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.consecutiveFailures += 1;
      state.lastError = message;
      // A failing pass must never take the API down with it.
      log.warn(
        { error: message, consecutiveFailures: state.consecutiveFailures },
        'USDT monitor pass failed',
      );
    } finally {
      state.running = false;
    }

    schedule(nextDelayMs());
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
    // Do not hold the event loop open: the process should be able to exit.
    timer.unref?.();
  };

  // First pass shortly after boot rather than immediately, so startup work and
  // the first RPC round trip do not compete.
  schedule(2_000);
}

function nextDelayMs(): number {
  const base = config.crypto.monitorIntervalMs;
  if (state.consecutiveFailures === 0) return base;
  // 2x per failure, capped at 10 minutes.
  const factor = Math.min(2 ** state.consecutiveFailures, 40);
  return Math.min(base * factor, 600_000);
}

export function stopMonitor(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
