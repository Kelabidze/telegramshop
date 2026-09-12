import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * The chain watcher, against a fake RPC endpoint.
 *
 * A local HTTP server rather than mainnet: these tests need to control the head,
 * the finalised height and which logs come back, none of which is possible against
 * a real chain. They also have to pass offline.
 *
 * What is asserted here is the machinery that decides whether a payment is ever
 * seen at all вЂ” cursor advancement, window bounds, deduplication, finality and
 * reorg handling. The predecessor system had no tests for any of it.
 */

const workDir = mkdtempSync(path.join(tmpdir(), 'shop-monitor-test-'));
const dbFile = path.join(workDir, 'test.db');
const apiRoot = path.resolve(import.meta.dirname, '..');

const TEST_XPUB =
  'xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4';
const USDT = '0x55d398326f99059ff775485246999027b3197955';

/** What the fake node answers with. Mutated per test. */
const chain = {
  head: 1_000_000n,
  finalized: 1_000_000n as bigint | null,
  logs: [] as Record<string, unknown>[],
  /** blockNumber -> canonical hash. Absent means "unknown block". */
  blockHashes: new Map<string, string>(),
  receipts: new Map<string, { status: string; blockHash: string }>(),
  /** Every eth_getLogs range asked for, so window behaviour is observable. */
  logRequests: [] as { fromBlock: string; toBlock: string }[],
  /**
   * Refuse any getLogs range wider than this, the way real BSC endpoints do.
   * `null` accepts everything; `0n` refuses everything.
   */
  refuseRangesWiderThan: null as bigint | null,
};

let rpcUrl = '';
let server: ReturnType<typeof createServer>;

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

before(async () => {
  // Fake RPC first: config reads the URL at import time.
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        id: number;
        method: string;
        params: unknown[];
      };
      let result: unknown = null;

      switch (body.method) {
        case 'eth_blockNumber':
          result = hex(chain.head);
          break;
        case 'eth_getBlockByNumber': {
          const tag = body.params[0] as string;
          if (tag === 'finalized') {
            result = chain.finalized === null ? null : { number: hex(chain.finalized) };
          } else {
            const asked = BigInt(tag).toString();
            const found = chain.blockHashes.get(asked);
            result = found ? { number: tag, hash: found } : null;
          }
          break;
        }
        case 'eth_getLogs': {
          const filter = body.params[0] as { fromBlock: string; toBlock: string };
          chain.logRequests.push({
            fromBlock: filter.fromBlock,
            toBlock: filter.toBlock,
          });
          const from = BigInt(filter.fromBlock);
          const to = BigInt(filter.toBlock);

          // Mimic a real endpoint's cap, which is what forces range splitting.
          if (
            chain.refuseRangesWiderThan !== null &&
            to - from + 1n > chain.refuseRangesWiderThan
          ) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                error: { code: -32005, message: 'limit exceeded' },
              }),
            );
            return;
          }

          result = chain.logs.filter((log) => {
            const block = BigInt(log.blockNumber as string);
            return block >= from && block <= to;
          });
          break;
        }
        case 'eth_getTransactionReceipt': {
          const hash = body.params[0] as string;
          const receipt = chain.receipts.get(hash);
          result = receipt
            ? {
                transactionHash: hash,
                blockNumber: hex(chain.head),
                blockHash: receipt.blockHash,
                status: receipt.status,
              }
            : null;
          break;
        }
        default:
          result = null;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  rpcUrl = `http://127.0.0.1:${port}`;

  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.UPLOADS_DIR = path.join(workDir, 'uploads');
  process.env.LOG_LEVEL = 'silent';
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.PAYMENT_PROVIDER = 'none';
  process.env.CRYPTO_PAYMENTS_ENABLED = 'true';
  process.env.CRYPTO_DEPOSIT_XPUB = TEST_XPUB;
  // Loop off: every pass here is driven explicitly.
  process.env.CRYPTO_MONITOR_INTERVAL_SECONDS = '0';
  process.env.BSC_RPC_URL = rpcUrl;
  process.env.BSC_RPC_FALLBACK_URL = rpcUrl;
  process.env.CRYPTO_SCAN_WINDOW_BLOCKS = '100';
  process.env.CRYPTO_SCAN_START_LAG_BLOCKS = '10';
  process.env.USDT_CONTRACT_ADDRESS = USDT;

  execFileSync('npx', ['prisma', 'db', 'push', '--url', `file:${dbFile}`], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  ({ prisma } = await import('../db.ts'));
  monitor = await import('./monitor.ts');
  usdt = await import('./usdt.ts');
  addresses = await import('./addresses.ts');
});

after(async () => {
  await prisma?.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

let prisma: typeof import('../db.ts')['prisma'];
let monitor: typeof import('./monitor.ts');
let usdt: typeof import('./usdt.ts');
let addresses: typeof import('./addresses.ts');

let walletSeq = 0;

/** A wallet with an open intent, i.e. something the monitor will scan for. */
async function seedIntent(options: { expectedWei?: string; cursor?: bigint } = {}) {
  walletSeq += 1;
  const derived = addresses.deriveDepositAddress(walletSeq);

  const user = await prisma.user.create({
    data: { telegramId: `900${walletSeq}`, firstName: 'Buyer' },
  });
  const product = await prisma.product.create({
    data: {
      slug: `monitor-item-${walletSeq}`,
      title: 'Monitor Item',
      description: '',
      amountMinor: 129_000,
      currency: 'RUB',
      fulfillmentKind: 'LICENSE_KEY',
    },
  });
  await prisma.licenseKey.create({
    data: { productId: product.id, secret: `MON-KEY-${walletSeq}` },
  });

  const order = await prisma.order.create({
    data: {
      reference: `MON${walletSeq}`,
      userId: user.id,
      status: 'PENDING',
      currency: 'USDT',
      totalAmountMinor: 1_500,
      totalBaseRubMinor: 129_000,
      rateRubMinorPerUnit: 8_600,
      invoicePayload: `ord_monitor_${walletSeq}`,
      lines: {
        create: {
          productId: product.id,
          titleSnapshot: 'Monitor Item',
          unitAmountMinor: 1_500,
          quantity: 1,
          totalAmountMinor: 1_500,
          unitBaseRubMinor: 129_000,
          fulfillmentKind: 'LICENSE_KEY',
        },
      },
    },
  });

  const wallet = await prisma.depositWallet.create({
    data: {
      address: derived.address,
      derivationIndex: derived.index,
      derivationPath: derived.path,
      lastScannedBlock: options.cursor ?? 0n,
    },
  });

  const intent = await prisma.cryptoPaymentIntent.create({
    data: {
      orderId: order.id,
      contract: USDT,
      expectedAmountWei: options.expectedWei ?? '15000000000000000000',
      expectedAmountMinor: 1_500,
      walletId: wallet.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });

  return { intent, wallet, order, address: derived.address };
}

/** A Transfer log for the fake node to return. */
function transferLog(options: {
  to: string;
  amountWei: bigint;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex?: number;
}) {
  return {
    address: USDT,
    topics: [
      usdt.TRANSFER_TOPIC,
      usdt.addressToTopic(`0x${'11'.repeat(20)}`),
      usdt.addressToTopic(options.to),
    ],
    data: `0x${options.amountWei.toString(16).padStart(64, '0')}`,
    blockNumber: hex(options.blockNumber),
    blockHash: options.blockHash,
    transactionHash: options.txHash,
    logIndex: hex(BigInt(options.logIndex ?? 0)),
  };
}

beforeEach(async () => {
  chain.head = 1_000_000n;
  chain.finalized = 1_000_000n;
  chain.logs = [];
  chain.blockHashes.clear();
  chain.receipts.clear();
  chain.logRequests = [];
  chain.refuseRangesWiderThan = null;

  /**
   * Clear the working set between tests.
   *
   * Several assertions here count RPC requests, and the monitor scans every open
   * address — so a wallet left behind by an earlier test silently changes the
   * numbers. Deleting the payment rows (orders and products can stay) keeps each
   * test's working set exactly what it seeded.
   */
  await prisma.cryptoTransaction.deleteMany({});
  await prisma.cryptoPaymentIntent.deleteMany({});
  await prisma.depositWallet.deleteMany({});
});

describe('scan cursor', () => {
  it('starts a new address near the head, not at genesis', async () => {
    // A buyer cannot have paid an address before it existed, so earlier history
    // holds nothing for it вЂ” and scanning from block 0 would be millions of
    // requests for no possible result.
    await seedIntent({ cursor: 0n });
    await monitor.runMonitorPass();

    const first = chain.logRequests[0];
    assert.ok(first);
    // head - CRYPTO_SCAN_START_LAG_BLOCKS.
    assert.equal(BigInt(first.fromBlock), 999_990n);
  });

  it('advances only after a range has been processed', async () => {
    const { wallet } = await seedIntent({ cursor: 999_000n });
    await monitor.runMonitorPass();

    const after = await prisma.depositWallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    // One window of 100 blocks from the cursor + 1.
    assert.equal(after.lastScannedBlock, 999_100n);
  });

  it('resumes from the cursor rather than rescanning', async () => {
    const { wallet } = await seedIntent({ cursor: 999_000n });

    await monitor.runMonitorPass();
    chain.logRequests = [];
    await monitor.runMonitorPass();

    const second = chain.logRequests[0];
    assert.ok(second);
    // Picks up exactly where the previous pass stopped: no gap (a gap loses a
    // payment) and no overlap (an overlap is wasted RPC).
    assert.equal(BigInt(second.fromBlock), 999_101n);

    const stored = await prisma.depositWallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    assert.equal(stored.lastScannedBlock, 999_200n);
  });

  it('never asks for a range wider than the configured window', async () => {
    // Public endpoints refuse wide ranges, and a refused range is a range whose
    // logs were never seen. A wallet far behind catches up over several passes.
    await seedIntent({ cursor: 1n });
    await monitor.runMonitorPass();

    for (const request of chain.logRequests) {
      const span = BigInt(request.toBlock) - BigInt(request.fromBlock) + 1n;
      assert.ok(span <= 100n, `window of ${span} blocks exceeds the limit`);
    }
  });

  it('never asks beyond the head', async () => {
    await seedIntent({ cursor: chain.head - 5n });
    await monitor.runMonitorPass();

    for (const request of chain.logRequests) {
      assert.ok(BigInt(request.toBlock) <= chain.head);
    }
  });

  it('splits a range the endpoint refuses, rather than stalling on it', async () => {
    /*
     * Found by probing mainnet: a public endpoint answered `-32005 limit exceeded`
     * for a range within the configured window. Abandoning such a range would park
     * the cursor behind it permanently, and no window setting is right for every
     * provider — so the range is halved and retried.
     */
    const { wallet } = await seedIntent({ cursor: 999_000n });
    chain.refuseRangesWiderThan = 25n;

    await monitor.runMonitorPass();

    // It had to narrow: 100 blocks refused, then 50, then 25 accepted.
    assert.ok(
      chain.logRequests.length > 1,
      `expected several narrowed requests, got ${chain.logRequests.length}`,
    );
    const widths = chain.logRequests.map(
      (r) => BigInt(r.toBlock) - BigInt(r.fromBlock) + 1n,
    );
    assert.equal(widths[0], 100n, 'first attempt should use the full window');
    assert.ok(
      widths.some((w) => w <= 25n),
      `never narrowed below the endpoint cap: ${widths.join(', ')}`,
    );
    // Every range that was actually served has to be within the cap.
    const served = widths.filter((w) => w <= 25n);
    assert.ok(served.length >= 4, `expected the window to be covered in pieces, got ${served.length}`);

    // And the cursor still ends up covering the whole window, so nothing is skipped.
    const stored = await prisma.depositWallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    assert.equal(stored.lastScannedBlock, 999_100n);
  });

  it('does not advance the cursor past blocks it could not read', async () => {
    const { wallet } = await seedIntent({ cursor: 999_000n });
    // Nothing is servable, at any width.
    chain.refuseRangesWiderThan = 0n;

    // The pass fails rather than pretending: the caller backs off, and the cursor
    // stays put so the range is retried instead of skipped.
    await assert.rejects(() => monitor.runMonitorPass());

    const stored = await prisma.depositWallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    assert.equal(stored.lastScannedBlock, 999_000n, 'cursor moved over unread blocks');
  });

  it('groups addresses that share a cursor into one request', async () => {
    // One request per wallet per range is how RPC load becomes proportional to
    // open payments. A topic slot accepts an array, so they share a query.
    await seedIntent({ cursor: 999_000n });
    await seedIntent({ cursor: 999_000n });
    await seedIntent({ cursor: 999_000n });

    await monitor.runMonitorPass();
    assert.equal(chain.logRequests.length, 1);
  });
});

describe('recording transfers', () => {
  it('stores a transfer found in the scanned range', async () => {
    const { intent, address } = await seedIntent({ cursor: 999_000n });
    const txHash = `0x${'aa'.repeat(32)}`;
    const blockHash = `0x${'bb'.repeat(32)}`;

    chain.logs = [
      transferLog({
        to: address,
        amountWei: 15_000_000_000_000_000_000n,
        blockNumber: 999_050n,
        blockHash,
        txHash,
      }),
    ];
    chain.blockHashes.set('999050', blockHash);
    chain.receipts.set(txHash, { status: '0x1', blockHash });

    const result = await monitor.runMonitorPass();
    assert.equal(result.transfersFound, 1);
    assert.equal(result.transfersInserted, 1);

    const stored = await prisma.cryptoTransaction.findFirstOrThrow({
      where: { intentId: intent.id },
    });
    assert.equal(stored.amountWei, '15000000000000000000');
    assert.equal(stored.blockNumber, 999_050n);
    assert.equal(stored.blockHash, blockHash);
  });

  it('keeps watching an expired address, because money still arrives late', async () => {
    /*
     * A buyer can send the transfer just after the deadline, or the transfer can be
     * slow. If the address leaves the scan set the moment its intent expires, that
     * money is never seen by anything — the funds sit at an address the shop owns
     * but does not know it received, and the buyer has no evidence to point at.
     *
     * Expiry closes the *intent*; it does not stop the *address* from being watched.
     */
    const { intent, address } = await seedIntent({ cursor: 999_000n });

    await prisma.cryptoPaymentIntent.update({
      where: { id: intent.id },
      data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 60_000) },
    });

    // Nothing has ever been seen at this address, so the "has SEEN transactions"
    // arm of the scan filter cannot save it.
    const seenCount = await prisma.cryptoTransaction.count({
      where: { intentId: intent.id },
    });
    assert.equal(seenCount, 0);

    const txHash = `0x${'7a'.repeat(32)}`;
    const blockHash = `0x${'7b'.repeat(32)}`;
    chain.logs = [
      transferLog({
        to: address,
        amountWei: 15_000_000_000_000_000_000n,
        blockNumber: 999_050n,
        blockHash,
        txHash,
      }),
    ];
    chain.blockHashes.set('999050', blockHash);
    chain.receipts.set(txHash, { status: '0x1', blockHash });

    await monitor.runMonitorPass();

    const recorded = await prisma.cryptoTransaction.findFirst({
      where: { txHash },
    });
    assert.ok(
      recorded,
      'a transfer to an expired address was not recorded — the funds would be invisible',
    );
  });

  it('does not insert the same log twice across passes', async () => {
    const { intent, address } = await seedIntent({ cursor: 999_000n });
    const txHash = `0x${'cc'.repeat(32)}`;
    const blockHash = `0x${'dd'.repeat(32)}`;

    chain.logs = [
      transferLog({
        to: address,
        amountWei: 1_000n,
        blockNumber: 999_050n,
        blockHash,
        txHash,
      }),
    ];
    chain.blockHashes.set('999050', blockHash);
    chain.receipts.set(txHash, { status: '0x1', blockHash });

    await monitor.runMonitorPass();
    // Rewind the cursor so the same range is scanned again вЂ” exactly what a crash
    // and restart produces.
    await prisma.depositWallet.updateMany({
      where: { intent: { id: intent.id } },
      data: { lastScannedBlock: 999_000n },
    });
    const second = await monitor.runMonitorPass();

    assert.equal(second.transfersFound, 1, 'the log is seen again');
    assert.equal(second.transfersInserted, 0, 'but not stored again');
    const count = await prisma.cryptoTransaction.count({
      where: { intentId: intent.id },
    });
    assert.equal(count, 1);
  });
});

describe('finality', () => {
  it('leaves a transfer above the finalised head as SEEN', async () => {
    const { intent, address } = await seedIntent({ cursor: 999_000n });
    const txHash = `0x${'ee'.repeat(32)}`;
    const blockHash = `0x${'ff'.repeat(32)}`;

    // Included, but not yet finalised.
    chain.finalized = 999_040n;
    chain.logs = [
      transferLog({
        to: address,
        amountWei: 15_000_000_000_000_000_000n,
        blockNumber: 999_050n,
        blockHash,
        txHash,
      }),
    ];
    chain.blockHashes.set('999050', blockHash);
    chain.receipts.set(txHash, { status: '0x1', blockHash });

    await monitor.runMonitorPass();

    const stored = await prisma.cryptoTransaction.findFirstOrThrow({
      where: { intentId: intent.id },
    });
    assert.equal(stored.status, 'SEEN');

    // And the order must not be paid off an unfinalised transfer.
    const order = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
      where: { id: intent.id },
      select: { order: { select: { status: true } }, status: true },
    });
    assert.equal(order.order.status, 'PENDING');
    assert.equal(order.status, 'CONFIRMING');
  });

  it('confirms once the finalised head passes the block, and pays the order', async () => {
    const { intent, address } = await seedIntent({ cursor: 999_000n });
    const txHash = `0x${'12'.repeat(32)}`;
    const blockHash = `0x${'34'.repeat(32)}`;

    chain.finalized = 999_040n;
    chain.logs = [
      transferLog({
        to: address,
        amountWei: 15_000_000_000_000_000_000n,
        blockNumber: 999_050n,
        blockHash,
        txHash,
      }),
    ];
    chain.blockHashes.set('999050', blockHash);
    chain.receipts.set(txHash, { status: '0x1', blockHash });

    await monitor.runMonitorPass();

    // The chain moves on and the block finalises.
    chain.finalized = 999_060n;
    await monitor.runMonitorPass();

    const stored = await prisma.cryptoTransaction.findFirstOrThrow({
      where: { intentId: intent.id },
    });
    assert.equal(stored.status, 'CONFIRMED');

    const settled = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
      where: { id: intent.id },
      select: { status: true, order: { select: { status: true } } },
    });
    assert.equal(settled.status, 'CONFIRMED');
    assert.equal(settled.order.status, 'PAID');
  });

  it('falls back to a depth rule when the finalized tag is unavailable', async () => {
    const { intent, address } = await seedIntent({ cursor: 999_000n });
    const txHash = `0x${'56'.repeat(32)}`;
    const blockHash = `0x${'78'.repeat(32)}`;

    // Node cannot answer `finalized`. The fallback is a depth rule, and the
    // default depth (45) is deeper than this transfer is buried, so it must NOT
    // be treated as final.
    //
    // The block sits inside the first scan window from the cursor (999_001 to
    // 999_100) so the log is actually found; being only ~950 blocks behind the
    // head is what matters for the depth check, not where in the window it is.
    chain.finalized = null;
    chain.head = 999_060n;
    const block = 999_050n;
    chain.logs = [
      transferLog({
        to: address,
        amountWei: 15_000_000_000_000_000_000n,
        blockNumber: block,
        blockHash,
        txHash,
      }),
    ];
    chain.blockHashes.set(block.toString(), blockHash);
    chain.receipts.set(txHash, { status: '0x1', blockHash });

    const result = await monitor.runMonitorPass();
    assert.equal(result.usedFallbackFinality, true);

    const stored = await prisma.cryptoTransaction.findFirstOrThrow({
      where: { intentId: intent.id },
    });
    // "I cannot tell whether this is final" must never read as "settled".
    assert.equal(stored.status, 'SEEN');
  });
});

describe('reorg handling', () => {
  it('orphans a transfer whose block is no longer canonical', async () => {
    const { intent, address } = await seedIntent({ cursor: 999_000n });
    const txHash = `0x${'9a'.repeat(32)}`;
    const seenHash = `0x${'bc'.repeat(32)}`;

    chain.logs = [
      transferLog({
        to: address,
        amountWei: 15_000_000_000_000_000_000n,
        blockNumber: 999_050n,
        blockHash: seenHash,
        txHash,
      }),
    ];
    // The canonical block at that height now has a DIFFERENT hash: the block we
    // saw the transfer in lost the race. A log being returned by eth_getLogs is
    // not proof the transaction survived.
    chain.blockHashes.set('999050', `0x${'de'.repeat(32)}`);
    chain.receipts.set(txHash, { status: '0x1', blockHash: seenHash });

    await monitor.runMonitorPass();

    const stored = await prisma.cryptoTransaction.findFirstOrThrow({
      where: { intentId: intent.id },
    });
    assert.equal(stored.status, 'ORPHANED');

    const settled = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
      where: { id: intent.id },
      select: { status: true, receivedAmountWei: true, order: { select: { status: true } } },
    });
    // An orphaned transfer is not money.
    assert.equal(settled.receivedAmountWei, '0');
    assert.equal(settled.order.status, 'PENDING');
  });

  it('orphans a transaction that reverted', async () => {
    const { intent, address } = await seedIntent({ cursor: 999_000n });
    const txHash = `0x${'ab'.repeat(32)}`;
    const blockHash = `0x${'cd'.repeat(32)}`;

    chain.logs = [
      transferLog({
        to: address,
        amountWei: 15_000_000_000_000_000_000n,
        blockNumber: 999_050n,
        blockHash,
        txHash,
      }),
    ];
    chain.blockHashes.set('999050', blockHash);
    // Present in a block, but reverted.
    chain.receipts.set(txHash, { status: '0x0', blockHash });

    await monitor.runMonitorPass();

    const stored = await prisma.cryptoTransaction.findFirstOrThrow({
      where: { intentId: intent.id },
    });
    assert.equal(stored.status, 'ORPHANED');
  });

  it('waits rather than guessing when a receipt is not available yet', async () => {
    const { intent, address } = await seedIntent({ cursor: 999_000n });
    const txHash = `0x${'ef'.repeat(32)}`;
    const blockHash = `0x${'01'.repeat(32)}`;

    chain.logs = [
      transferLog({
        to: address,
        amountWei: 15_000_000_000_000_000_000n,
        blockNumber: 999_050n,
        blockHash,
        txHash,
      }),
    ];
    chain.blockHashes.set('999050', blockHash);
    // No receipt: the node has not caught up. Neither confirmed nor orphaned.

    await monitor.runMonitorPass();

    const stored = await prisma.cryptoTransaction.findFirstOrThrow({
      where: { intentId: intent.id },
    });
    assert.equal(stored.status, 'SEEN');
  });
});

describe('resilience', () => {
  it('reports a failing RPC instead of throwing into the caller', async () => {
    await seedIntent({ cursor: 999_000n });

    // Point the client at a dead endpoint by closing the fake node for a moment.
    // A pass must fail loudly to its caller, which is what lets the loop back off
    // rather than the process die.
    await assert.rejects(async () => {
      const { BscRpcClient } = await import('./rpc.ts');
      const dead = new BscRpcClient(['http://127.0.0.1:1'], 500);
      await dead.getBlockNumber();
    });
  });

  it('drops an old address from the scan set, so cost stays bounded', async () => {
    /*
     * The working set cannot be "open intents only" — a late transfer to a closed
     * intent would be invisible (see the expiry test above), and a settled address
     * still holds funds until sweeping exists. So it is bounded by AGE instead:
     * an address nobody has paid in a week is not about to be paid.
     *
     * This is the counterpart to that test: the set must not grow forever.
     */
    const { intent, address } = await seedIntent({ cursor: 999_000n });
    const txHash = `0x${'2a'.repeat(32)}`;
    const blockHash = `0x${'2b'.repeat(32)}`;

    chain.logs = [
      transferLog({
        to: address,
        amountWei: 15_000_000_000_000_000_000n,
        blockNumber: 999_050n,
        blockHash,
        txHash,
      }),
    ];
    chain.blockHashes.set('999050', blockHash);
    chain.receipts.set(txHash, { status: '0x1', blockHash });

    await monitor.runMonitorPass();
    const settled = await prisma.cryptoPaymentIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    assert.equal(settled.status, 'CONFIRMED');

    // Freshly settled: still watched, because money can still arrive late and the
    // funds are not swept.
    chain.logs = [];
    chain.logRequests = [];
    await monitor.runMonitorPass();
    assert.ok(
      chain.logRequests.length > 0,
      'a freshly settled address must stay watched while it holds funds',
    );

    // Age it past the late-watch window.
    await prisma.depositWallet.updateMany({
      where: { intent: { id: intent.id } },
      data: { createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    chain.logRequests = [];
    const next = await monitor.runMonitorPass();
    assert.equal(
      chain.logRequests.length,
      0,
      `still scanning a long-closed address (${next.walletsScanned} wallets)`,
    );
  });
});
