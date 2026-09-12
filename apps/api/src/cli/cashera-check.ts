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
 * translating a rejection from Cashera. From the storefront a wrong key and an
 * unrecognised one look identical; this separates them.
 *
 * Run it as `npm run cashera:check`. That is deliberately the compiled `dist/`
 * entry, not `tsx`: tsx is a devDependency and production is installed without
 * dev dependencies, so a `tsx` script cannot run there at all. The two
 * `--env-file-if-exists` paths cover both hosts — the shared server file wins on
 * production, the local `.env` on a developer machine, and a missing one is
 * skipped silently.
 *
 * One failure needs naming because it has produced a wrong diagnosis before: an
 * edge in front of the API (Cloudflare) can answer 403 with an HTML challenge
 * page. That is not Cashera and says nothing about the key, so the probe reports
 * the distinction rather than concluding "merchant disabled".
 */

function line(label: string, value: string): void {
  console.log(`${label.padEnd(26)} ${value}`);
}

/**
 * Safe description of a credential: prefix and length only, never the value.
 *
 * The expected prefix comes from Cashera's own documentation — the API key is the
 * public `pk_…`, the secret is `sk_…`. Checking it is what makes this tool able to
 * catch the most common cause of a 401 without reading the credential aloud: the two
 * variables swapped in `api.env`, which looks perfectly configured and fails on
 * every request.
 */
function describeSecret(name: string, value: string, expectedPrefix: string): boolean {
  if (value.length === 0) {
    line(name, 'MISSING or empty');
    return false;
  }
  const prefix = value.slice(0, 3);
  const problems: string[] = [];
  if (prefix !== expectedPrefix) problems.push(`expected ${expectedPrefix}…`);
  if (value.startsWith('"') || value.startsWith("'")) problems.push('still QUOTED');
  line(name, `${prefix}… len=${value.length}${problems.length ? ` (${problems.join(', ')})` : ''}`);
  return problems.length === 0;
}

async function main(): Promise<void> {
  console.log('\n=== configuration ===');
  line('enabled', config.cashera.enabled ? 'yes' : 'NO — key or secret empty');
  line('base URL', config.cashera.baseUrl);
  line('card method', config.cashera.paymentMethod);
  line('crypto method', config.cashera.cryptoPaymentMethod ?? '(common form)');
  line('callback configured', config.publicApiUrl || config.publicAppUrl ? 'yes' : 'NO — payments cannot settle');

  console.log('\n=== credentials (safe view) ===');
  const keyLooksRight = describeSecret('CASHERA_API_KEY', config.cashera.apiKey, 'pk_');
  const secretLooksRight = describeSecret('CASHERA_API_SECRET', config.cashera.apiSecret, 'sk_');

  if (!config.cashera.enabled) {
    console.log('\nCannot probe: the rail is disabled. Set both credentials in api.env.');
    process.exitCode = 1;
    return;
  }

  /**
   * A prefix check catches the swap that otherwise looks perfectly configured and
   * fails on every call: the two variables reversed in api.env. Cashera's docs are
   * explicit that the key is `pk_…` and the secret `sk_…`.
   */
  if (!keyLooksRight || !secretLooksRight) {
    console.log(
      '\n! Credential prefix mismatch (key should start pk_, secret sk_). ' +
        'If they are swapped in api.env, every request is rejected as an unknown key.',
    );
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
      /**
       * Cashera's own reason. It is what separates two failures that share a status:
       * a 401 reading "X-Api-Key header is required." means the key never left us,
       * while "Invalid API key." means it did and was not recognised. Both were
       * confirmed against the live gateway.
       */
      if (error.gatewayMessage) line('gateway said', error.gatewayMessage);

      switch (error.httpStatus) {
        case 401:
          /**
           * A 401 only means something when Cashera actually answered. An edge
           * challenge page arrives as HTML, parses into no message, and then a 401
           * says nothing about the key — guessing here is what sent this diagnosis
           * in the wrong direction once already.
           */
          if (!error.gatewayMessage) {
            console.log('\n✗ 401 with no Cashera message: an edge in front of the API');
            console.log('  returned a challenge page instead of Cashera. The request never');
            console.log('  reached the API, so this run says NOTHING about the key.');
            break;
          }
          console.log('\n✗ 401 from Cashera: the API key was rejected.');
          // The gateway's own wording decides which of these it is. Confirmed live:
          // an absent/empty key and an unrecognised one return different messages
          // under the same status.
          if (error.gatewayMessage.includes('required')) {
            console.log('  The key arrived empty. CASHERA_API_KEY is unset or blank in');
            console.log('  /srv/shop/shared/api.env, so check the variable name and that');
            console.log('  the file is actually loaded by the unit.');
          } else {
            console.log('  The key arrived but Cashera does not recognise it. In order of likelihood:');
            console.log('   - CASHERA_API_KEY and CASHERA_API_SECRET are swapped in api.env.');
            console.log('     The prefix check above catches this (key is pk_, secret is sk_).');
            console.log('   - api.env contains the variable TWICE. The documented setup appends with');
            console.log('     `tee -a`, so a second block overrides the first — a stale placeholder');
            console.log('     appended after the real key silently wins. Compare len= above with the');
            console.log('     dashboard value.');
            console.log('   - the key was rotated in the dashboard and api.env was not updated.');
            console.log('   - the key belongs to a different merchant or a test/sandbox account.');
          }
          console.log('  Quoting and CRLF are NOT the cause: systemd discards surrounding');
          console.log('  quotes and trailing carriage returns from EnvironmentFile values,');
          console.log('  and Node trims header values before sending.');
          break;
        case 403:
          /**
           * A 403 has two entirely different meanings here, and telling them apart is
           * the whole point of carrying `gatewayMessage`.
           *
           * Cashera's own 403 arrives as JSON and means the merchant is disabled. An
           * edge in front of the API (Cloudflare) answers 403 with an HTML challenge
           * page, which never parses into a message — and that says nothing about the
           * key or the merchant, only that the request never reached Cashera.
           *
           * Confirmed live: an identical HTML 403 was returned for a valid key, a
           * deliberately wrong key, and no key at all, so no inference about any of
           * them is possible. Claiming "merchant disabled" in that case would send an
           * operator to fix a setting that is not broken.
           */
          if (error.gatewayMessage) {
            console.log('\n✗ 403 from Cashera: the merchant is disabled or cannot accept payments.');
            console.log('  This is not a key problem — the key was recognised. Check the account');
            console.log('  status in the Cashera dashboard.');
          } else {
            console.log('\n✗ 403 with no Cashera message: an edge in front of the API (Cloudflare)');
            console.log('  returned a challenge page instead of Cashera. The request never reached');
            console.log('  the API, so this run says NOTHING about the key or the merchant.');
            console.log('  Repeated probing can trigger this; wait and retry once, or check');
            console.log('  whether this host is allowed to reach api.cashera.cash.');
          }
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
