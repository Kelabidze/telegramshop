import {
  type CryptoPayment,
  type CryptoPaymentStatus,
  type CryptoTransactionView,
  BSC_CHAIN_ID,
  USDT_DECIMALS,
  cryptoPaymentStatusSchema,
  cryptoTxStatusSchema,
} from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, notFound } from '../errors.js';
import {
  deriveDepositAddress,
  isDerivationAvailable,
  toChecksumAddress,
} from '../crypto/addresses.js';
import {
  formatUsdtAmount,
  minorToWei,
  parseWei,
  weiToMinorFloor,
  weiToString,
} from '../crypto/amounts.js';
import { markOrderPaid } from './orders.js';

/**
 * On-chain payment decisions.
 *
 * This module is the ONLY thing that decides an intent's status or marks an order
 * paid. The chain watcher records what it observed and nothing more. That split
 * is deliberate: the watcher is the component exposed to RPC lies, duplicate logs
 * and reorgs, and it should not be able to release goods.
 *
 * Every status is *recomputed* from the stored transaction rows rather than
 * incremented. A recompute run twice reaches the same answer; an increment run
 * twice does not, and "run twice" is the normal case for a poller.
 */

/** Intent states that can still absorb an incoming payment. */
const OPEN_STATUSES: CryptoPaymentStatus[] = [
  'AWAITING',
  'CONFIRMING',
  'UNDERPAID',
];

/**
 * The one shape every read in this module uses.
 *
 * A function rather than a shared `include` object: Prisma's generated types
 * reject a `readonly` include, and dropping `as const` would lose the literal
 * types the payload inference depends on. Loading through one helper also means
 * `toApiCryptoPayment` can never be handed a row missing its transactions.
 */
async function loadIntent(
  where: { id: string } | { orderId: string },
) {
  return prisma.cryptoPaymentIntent.findUnique({
    where,
    include: {
      wallet: { select: { address: true } },
      transactions: {
        orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
        select: {
          txHash: true,
          logIndex: true,
          amountWei: true,
          blockNumber: true,
          confirmations: true,
          status: true,
          firstSeenAt: true,
        },
      },
    },
  });
}

type IntentRow = NonNullable<Awaited<ReturnType<typeof loadIntent>>>;

/** Reloads after a write, so callers never map a stale row. */
async function reloadIntent(id: string): Promise<IntentRow> {
  const row = await loadIntent({ id });
  if (!row) throw new Error(`Payment intent ${id} disappeared mid-update`);
  return row;
}

function toApiCryptoPayment(intent: IntentRow): CryptoPayment {
  const transactions: CryptoTransactionView[] = intent.transactions.map((tx) => ({
    txHash: tx.txHash,
    logIndex: tx.logIndex,
    amountWei: tx.amountWei,
    amountMinor: weiToMinorFloor(parseWei(tx.amountWei)),
    blockNumber: Number(tx.blockNumber),
    confirmations: tx.confirmations,
    status: cryptoTxStatusSchema.catch('SEEN').parse(tx.status),
    firstSeenAt: tx.firstSeenAt.toISOString(),
  }));

  const receivedWei = parseWei(intent.receivedAmountWei);

  return {
    id: intent.id,
    orderId: intent.orderId,
    status: cryptoPaymentStatusSchema.catch('AWAITING').parse(intent.status),
    chain: 'BSC',
    chainId: BSC_CHAIN_ID,
    asset: 'USDT',
    contract: intent.contract,
    decimals: USDT_DECIMALS,
    // Checksummed for display: wallets show mixed case, and a buyer comparing
    // the two should not have to wonder whether the difference matters.
    depositAddress: toChecksumAddress(intent.wallet.address),
    expectedAmountWei: intent.expectedAmountWei,
    expectedAmountMinor: intent.expectedAmountMinor,
    expectedAmountDisplay: formatUsdtAmount(parseWei(intent.expectedAmountWei)),
    receivedAmountWei: intent.receivedAmountWei,
    receivedAmountMinor: weiToMinorFloor(receivedWei),
    confirmations: intent.confirmations,
    expiresAt: intent.expiresAt.toISOString(),
    confirmedAt: intent.confirmedAt ? intent.confirmedAt.toISOString() : null,
    createdAt: intent.createdAt.toISOString(),
    transactions,
  };
}

/**
 * Issues the next deposit address.
 *
 * The index comes from the current maximum, and `derivationIndex` is unique, so
 * two concurrent checkouts racing for the same index collide at the database
 * rather than sharing an address. Sharing one would make an incoming transfer
 * unattributable, which is the one thing this design cannot tolerate — hence the
 * retry loop rather than a best-effort read.
 */
async function allocateDepositWallet(): Promise<{ id: string; address: string }> {
  if (!isDerivationAvailable()) {
    throw new AppError(
      'CRYPTO_PAYMENTS_DISABLED',
      'Оплата USDT сейчас недоступна.',
    );
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const highest = await prisma.depositWallet.findFirst({
      orderBy: { derivationIndex: 'desc' },
      select: { derivationIndex: true },
    });
    const index = (highest?.derivationIndex ?? -1) + 1;
    const derived = deriveDepositAddress(index);

    try {
      const wallet = await prisma.depositWallet.create({
        data: {
          address: derived.address,
          derivationIndex: derived.index,
          derivationPath: derived.path,
          // Scanning starts near creation: a buyer cannot have paid an address
          // that did not exist, so earlier blocks hold nothing for it. The lag is
          // set by the monitor on first pass, which is where the chain head is
          // known.
          lastScannedBlock: 0n,
        },
        select: { id: true, address: true },
      });
      return wallet;
    } catch {
      // Lost the race for this index; the next read sees the winner's row.
    }
  }

  throw new AppError(
    'DEPOSIT_ADDRESS_UNAVAILABLE',
    'Не удалось выделить адрес для оплаты. Попробуйте ещё раз.',
  );
}

/**
 * Creates the intent for an order, or returns the live one it already has.
 *
 * Idempotent by design: a buyer who reloads the payment screen must land on the
 * same address and the same amount. Issuing a second address would split one
 * payment across two intents, and neither would ever reach its expected total.
 */
export async function createIntentForOrder(
  orderId: string,
): Promise<CryptoPayment> {
  if (!config.crypto.enabled) {
    throw new AppError(
      'CRYPTO_PAYMENTS_DISABLED',
      'Оплата USDT сейчас недоступна.',
    );
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      currency: true,
      totalAmountMinor: true,
      cryptoPayment: { select: { id: true } },
    },
  });
  if (!order) throw notFound(`Order ${orderId} was not found.`);

  if (order.cryptoPayment) {
    const existing = await getIntentByOrderId(orderId);
    if (existing) return existing;
  }

  if (order.status !== 'PENDING') {
    throw new AppError(
      'ORDER_NOT_PAYABLE',
      `Заказ уже в состоянии ${order.status} и не может быть оплачен.`,
    );
  }
  if (order.currency !== 'USDT') {
    throw new AppError(
      'CURRENCY_MISMATCH',
      `Заказ оформлен в ${order.currency}, а не в USDT.`,
    );
  }

  const wallet = await allocateDepositWallet();
  const expectedWei = minorToWei(order.totalAmountMinor);

  const created = await prisma.cryptoPaymentIntent.create({
    data: {
      orderId: order.id,
      chain: 'BSC',
      chainId: BSC_CHAIN_ID,
      asset: 'USDT',
      contract: config.crypto.usdtContract,
      decimals: USDT_DECIMALS,
      expectedAmountWei: weiToString(expectedWei),
      expectedAmountMinor: order.totalAmountMinor,
      status: 'AWAITING',
      walletId: wallet.id,
      expiresAt: new Date(Date.now() + config.crypto.paymentTtlMs),
    },
    select: { id: true },
  });

  return toApiCryptoPayment(await reloadIntent(created.id));
}

export async function getIntentByOrderId(
  orderId: string,
): Promise<CryptoPayment | null> {
  const intent = await loadIntent({ orderId });
  return intent ? toApiCryptoPayment(intent) : null;
}

/**
 * Recomputes an intent from its confirmed transactions and settles the order.
 *
 * The decision table, in one place:
 *
 *   received == expected  -> CONFIRMED, order paid
 *   received >  expected  -> OVERPAID, order paid, excess recorded
 *   0 < received < expected, deadline not passed -> UNDERPAID, stays open
 *   nothing confirmed, deadline passed           -> EXPIRED
 *
 * Only CONFIRMED transactions count. A `SEEN` row is a log that has not reached
 * finality, and an `ORPHANED` one is a log whose block is gone — neither is money.
 */
export async function reconcileIntent(intentId: string): Promise<CryptoPayment | null> {
  const intent = await loadIntent({ id: intentId });
  if (!intent) return null;

  const status = cryptoPaymentStatusSchema.catch('AWAITING').parse(intent.status);

  // Already settled: recomputing could only flip a paid order back, which is
  // never the right answer. A late extra transfer is recorded on the rows and
  // stays visible for a human.
  if (status === 'CONFIRMED' || status === 'OVERPAID') {
    return toApiCryptoPayment(intent);
  }
  if (status === 'CANCELLED') {
    return toApiCryptoPayment(intent);
  }

  const expectedWei = parseWei(intent.expectedAmountWei);
  const confirmed = intent.transactions.filter((tx) => tx.status === 'CONFIRMED');
  const receivedWei = confirmed.reduce<bigint>(
    (sum, tx) => sum + parseWei(tx.amountWei),
    0n,
  );
  const confirmations = confirmed.reduce(
    (max, tx) => Math.max(max, tx.confirmations),
    0,
  );

  const seenButUnconfirmed = intent.transactions.some((tx) => tx.status === 'SEEN');
  const expired = intent.expiresAt.getTime() <= Date.now();

  let nextStatus: CryptoPaymentStatus;
  let overpaidWei: bigint | null = null;

  if (receivedWei >= expectedWei && expectedWei > 0n) {
    if (receivedWei > expectedWei) {
      nextStatus = 'OVERPAID';
      overpaidWei = receivedWei - expectedWei;
    } else {
      nextStatus = 'CONFIRMED';
    }
  } else if (receivedWei > 0n) {
    // Short. Kept open until the deadline so a top-up completes the same intent
    // rather than being stranded against a closed one.
    nextStatus = expired ? 'UNDERPAID' : 'UNDERPAID';
  } else if (seenButUnconfirmed) {
    nextStatus = 'CONFIRMING';
  } else if (expired) {
    nextStatus = 'EXPIRED';
  } else {
    nextStatus = 'AWAITING';
  }

  const isSettled = nextStatus === 'CONFIRMED' || nextStatus === 'OVERPAID';
  // Whether this intent had already been settled before this pass. Used to send
  // the buyer's notification once, on the transition, rather than on every poll.
  const wasSettled = intent.confirmedAt !== null;

  await prisma.cryptoPaymentIntent.update({
    where: { id: intent.id },
    data: {
      status: nextStatus,
      receivedAmountWei: weiToString(receivedWei),
      confirmations,
      overpaidAmountWei: overpaidWei ? weiToString(overpaidWei) : null,
      confirmedAt: isSettled ? (intent.confirmedAt ?? new Date()) : intent.confirmedAt,
    },
  });
  const updated = await reloadIntent(intent.id);

  if (!isSettled) return toApiCryptoPayment(updated);

  /**
   * Settle the order.
   *
   * `markOrderPaid` is idempotent, so calling it again after a crash between the
   * status write above and here is safe — which is why the intent is written
   * first. The reverse order could deliver goods for an intent that never
   * recorded being settled.
   */
  const paid = await markOrderPaid({ kind: 'crypto', orderId: intent.orderId });

  /**
   * Tell the buyer, out of band.
   *
   * There is no webhook to reply into here, so the bot pushes the message. Best
   * effort on purpose: the keys are already recorded against the order and shown
   * on the orders screen, so a Telegram outage must not undo a payment that has
   * already settled on chain.
   *
   * Only on the transition. `wasSettled` is read from the row as it was BEFORE
   * this pass wrote to it, so a poller reconciling the same intent every 15
   * seconds does not re-send the message every 15 seconds.
   */
  if (paid && !wasSettled) {
    const { notifyOrderDelivered } = await import('../telegram/delivery.js');
    await notifyOrderDelivered(paid);
  }

  // Fulfilment could not complete (stock vanished, static payload missing). The
  // money is real, so the intent must not claim success.
  if (paid && paid.status === 'FAILED') {
    await prisma.cryptoPaymentIntent.update({
      where: { id: intent.id },
      data: { status: 'FAILED' },
    });
    return toApiCryptoPayment(await reloadIntent(intent.id));
  }

  return toApiCryptoPayment(updated);
}

/** Every intent that could still change, for the monitor's working set. */
export async function listOpenIntents(limit = 200) {
  return prisma.cryptoPaymentIntent.findMany({
    where: { status: { in: OPEN_STATUSES } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      status: true,
      expiresAt: true,
      walletId: true,
      wallet: {
        select: { id: true, address: true, lastScannedBlock: true },
      },
    },
  });
}

/**
 * Buyer-initiated abandonment.
 *
 * Refuses once anything has been seen on chain: cancelling an intent that has
 * money in flight would leave a confirmed transfer pointing at a closed intent.
 */
export async function cancelIntent(intentId: string): Promise<CryptoPayment | null> {
  const intent = await loadIntent({ id: intentId });
  if (!intent) return null;

  const status = cryptoPaymentStatusSchema.catch('AWAITING').parse(intent.status);
  if (status !== 'AWAITING') {
    throw new AppError(
      'ORDER_NOT_PAYABLE',
      'Этот платёж уже нельзя отменить: по нему есть активность в сети.',
    );
  }
  if (intent.transactions.length > 0) {
    throw new AppError(
      'ORDER_NOT_PAYABLE',
      'По этому платежу уже поступили средства.',
    );
  }

  await prisma.cryptoPaymentIntent.update({
    where: { id: intent.id },
    data: { status: 'CANCELLED' },
  });
  return toApiCryptoPayment(await reloadIntent(intent.id));
}

/**
 * Closes intents whose deadline passed with nothing confirmed.
 *
 * Their orders are deliberately left PENDING rather than cancelled: the address
 * stays watched, so a late transfer is still recorded and refundable instead of
 * silently lost.
 */
export async function expireStaleIntents(now = new Date()): Promise<number> {
  const stale = await prisma.cryptoPaymentIntent.findMany({
    where: {
      status: { in: ['AWAITING', 'CONFIRMING'] },
      expiresAt: { lt: now },
    },
    select: { id: true },
    take: 200,
  });

  let expired = 0;
  for (const { id } of stale) {
    // Through reconcile, not a bulk update: a transfer may have confirmed in the
    // same tick, and that payment must win over the clock.
    const result = await reconcileIntent(id);
    if (result?.status === 'EXPIRED') expired += 1;
  }
  return expired;
}

export { toApiCryptoPayment };
