import { config } from '../config.js';
import { isDerivationAvailable } from '../crypto/addresses.js';
import { formatUsdtAmount } from '../crypto/amounts.js';
import { getRpcClient } from '../crypto/rpc.js';
import { TRANSFER_TOPIC, parseTransferLog } from '../crypto/usdt.js';

/**
 * Checks the on-chain payment configuration against the live network.
 *
 * Read-only, and it never touches key material beyond asking whether a watch-only
 * key parses. Run it after configuring a server, or when payments stop being
 * noticed, because it separates the three things that look identical from the
 * outside: bad configuration, an unreachable RPC, and a decoder that no longer
 * matches what the chain returns.
 *
 *   npm run crypto:check -w @shop/api
 */

function line(label: string, value: string): void {
  console.log(`${label.padEnd(26)} ${value}`);
}

async function main(): Promise<void> {
  let problems = 0;
  const fail = (message: string) => {
    problems += 1;
    console.log(`  ✗ ${message}`);
  };

  console.log('\n=== configuration ===');
  line('crypto payments', config.crypto.enabled ? 'enabled' : 'DISABLED');
  line('derivation key', isDerivationAvailable() ? 'ok (watch-only)' : 'MISSING/INVALID');
  line('derivation path', config.crypto.derivationBasePath);
  line('USDT contract', config.crypto.usdtContract);
  line('RPC endpoints', String(config.crypto.rpcUrls.length));
  line('scan window', `${config.crypto.scanWindowBlocks} blocks`);
  line('payment TTL', `${config.crypto.paymentTtlMs / 60_000} min`);
  line('monitor interval', `${config.crypto.monitorIntervalMs / 1_000}s`);
  line('USDT rate', `${config.rates.usdtRubMinorPerUnit / 100} RUB`);
  line('Star rate', `${config.rates.starRubMinorPerUnit / 100} RUB`);

  if (!config.crypto.enabled) {
    fail('CRYPTO_PAYMENTS_ENABLED is off, or CRYPTO_DEPOSIT_XPUB is empty.');
  }
  if (config.crypto.rpcUrls.length < 2) {
    fail('Only one RPC endpoint: there is nothing to fail over to.');
  }
  if (!config.crypto.treasuryAddress) {
    console.log('  · No treasury address set. Sweeping is a later phase, so this is expected for now.');
  }

  console.log('\n=== chain ===');
  const rpc = getRpcClient();

  let head: bigint;
  try {
    head = await rpc.getBlockNumber();
    line('head block', head.toString());
  } catch (error) {
    fail(`Cannot reach any RPC endpoint: ${(error as Error).message}`);
    console.log(`\n${problems} problem(s) found.`);
    process.exitCode = 1;
    return;
  }

  const finalized = await rpc.getFinalizedBlockNumber();
  if (finalized === null) {
    // Not fatal, but worth knowing: the fallback depth rule is a blunter
    // instrument, and payments will take longer to confirm.
    fail(
      'No endpoint answers the `finalized` tag. Falling back to a depth of ' +
        `${config.crypto.fallbackConfirmations} blocks, which is slower.`,
    );
  } else {
    line('finalized block', finalized.toString());
    line('finality lag', `${head - finalized} blocks`);
  }

  // Decode one block of real transfers: proves the topic, the ABI decoding and
  // the amount scale still match what BSC actually emits.
  console.log('\n=== decoder ===');
  try {
    const logs = await rpc.getLogs({
      address: config.crypto.usdtContract,
      fromBlock: head - 1n,
      toBlock: head - 1n,
      topics: [TRANSFER_TOPIC],
    });
    line('transfers in 1 block', String(logs.length));

    const parsed = logs.map(parseTransferLog).filter((p) => p !== null);
    line('decoded', String(parsed.length));

    const sample = parsed[0];
    if (sample) {
      line('sample amount', `${formatUsdtAmount(sample.amountWei)} USDT`);
      line('sample recipient', sample.to);
    } else if (logs.length > 0) {
      fail('Logs were returned but none decoded: the event ABI may have changed.');
    }
  } catch (error) {
    fail(`Could not read logs: ${(error as Error).message}`);
  }

  const stats = rpc.getStats();
  console.log('\n=== rpc ===');
  line('calls', String(stats.calls));
  line('failures', String(stats.failures));
  line('fallback used', String(stats.fallbackUses));

  console.log(
    problems === 0
      ? '\nAll checks passed.'
      : `\n${problems} problem(s) found.`,
  );
  if (problems > 0) process.exitCode = 1;
}

await main();
