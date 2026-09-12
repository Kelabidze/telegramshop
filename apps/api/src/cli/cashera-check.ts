import { config } from '../config.js';
import { CasheraError, getRates } from '../payments/cashera-client.js';

/**
 * Diagnoses the Cashera credential and connectivity WITHOUT creating a payment.
 *
 * Run on the server, where the real `api.env` is loaded:
 *   node dist/cli/cashera-check.js
 *
 * It answers the question a failed crypto checkout cannot: is the API key accepted
 * by Cashera? It reports only safe facts about the credentials — presence, prefix
 * and length — never their values, and it probes with the read-only `/rates`
 * endpoint, so it moves no money and opens no transaction.
 *
 * The 401 this exists to explain is produced by our own client (`describeStatus`),
 * translating a rejection from Cashera. A wrong or unknown key, and a key with
 * stray quotes or a trailing carriage return from a CRLF-edited env file, are
 * indistinguishable from the storefront; this separates them.
 */

function line(label: string, value: string): void {
  console.log(`${label.padEnd(26)} ${value}`);
}

/** Safe description of a credential: enough to spot a quoting/whitespace fault. */
function describeSecret(name: string, value: string): void {
  if (value.length === 0) {
    line(name, 'MISSING or empty');
    return;
  }
  // Prefix and length only. A Cashera key is `pk_…`; anything else — a leading
  // quote, an unexpected first character — points at an env-file problem.
  const prefix = value.slice(0, 3);
  const looksQuoted = value.startsWith('"') || value.startsWith("'");
  line(name, `${prefix}… len=${value.length}${looksQuoted ? ' (QUOTED — not stripped?)' : ''}`);
}

async function main(): Promise<void> {
  console.log('\n=== configuration ===');
  line('enabled', config.cashera.enabled ? 'yes' : 'NO — key or secret empty');
  line('base URL', config.cashera.baseUrl);
  line('card method', config.cashera.paymentMethod);
  line('crypto method', config.cashera.cryptoPaymentMethod ?? '(common form)');
  line('callback configured', config.publicApiUrl || config.publicAppUrl ? 'yes' : 'NO — payments cannot settle');

  console.log('\n=== credentials (safe view) ===');
  describeSecret('CASHERA_API_KEY', config.cashera.apiKey);
  describeSecret('CASHERA_API_SECRET', config.cashera.apiSecret);

  if (!config.cashera.enabled) {
    console.log('\nCannot probe: the rail is disabled. Set both credentials in api.env.');
    process.exitCode = 1;
    return;
  }

  /**
   * Probe with the read-only rates endpoint. It authenticates exactly like a create
   * but side-effect free, so a 200 proves the key works and a 401 proves it does not
   * — without risking a real transaction.
   */
  const probeMethod = config.cashera.cryptoPaymentMethod ?? config.cashera.paymentMethod;
  console.log(`\n=== live probe (GET /integration/rates, payment_method=${probeMethod}) ===`);
  try {
    const rate = await getRates(probeMethod);
    line('HTTP', '200 — key ACCEPTED');
    if (rate.merchant_rate) line('merchant_rate', `${rate.merchant_rate} USDT per RUB`);
    if (rate.provider_rate) line('provider_rate', rate.provider_rate);
    console.log('\nKey is valid and the merchant can transact. A crypto checkout will open.');
  } catch (error) {
    if (error instanceof CasheraError) {
      line('HTTP', String(error.httpStatus ?? 'transport'));
      switch (error.httpStatus) {
        case 401:
          console.log('\n✗ 401 from Cashera: the API key was rejected as missing, empty or unknown.');
          console.log('  Causes, in order of likelihood:');
          console.log('   - CASHERA_API_KEY is wrapped in quotes in /srv/shop/shared/api.env.');
          console.log('     systemd EnvironmentFile does not strip them, so the header goes out as');
          console.log('     X-Api-Key: "pk_…". The client now unquotes, but check the file anyway.');
          console.log('   - the key was rotated in the Cashera dashboard and api.env was not updated.');
          console.log('   - the key belongs to a different merchant/account.');
          console.log('   - the key was pasted from a test/sandbox credential set.');
          break;
        case 403:
          console.log('\n✗ 403: the merchant is disabled or cannot accept payments (not a key problem).');
          break;
        case 422:
          console.log(`\n✗ 422: the key is valid, but payment_method "${probeMethod}" is not enabled`);
          console.log('  for this merchant, or the rate parameters are not supported. Enable it in the');
          console.log('  Cashera dashboard under «Методы приёма». This is NOT an auth failure.');
          break;
        case 429:
          console.log('\n✗ 429: rate limited. Wait and retry.');
          break;
        default:
          console.log('\n✗ The gateway returned an error; see the status above.');
      }
      process.exitCode = 1;
      return;
    }
    console.log(`\n✗ Could not reach the gateway: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

await main();
