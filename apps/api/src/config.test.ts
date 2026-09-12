import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Credential normalisation from the environment.
 *
 * Two distinct faults, both invisible from the storefront:
 *
 *  - Surrounding quotes on the key. systemd's `EnvironmentFile` is not a dotenv
 *    parser, so `KEY="pk_…"` keeps its quotes and the header goes out literally,
 *    which Cashera rejects as an unknown key (401). `/health` still says enabled,
 *    because it only checks for non-empty, so the buyer just sees the rail fail.
 *
 *  - A trailing `\r` from a CRLF-edited file on the secret. This one does not
 *    affect the key — Node trims whitespace from header values before sending — but
 *    the secret is compared byte-for-byte against Cashera's `X-Secret`, so webhook
 *    authentication would fail while everything looked configured.
 *
 * Normalisation repairs both and is a no-op for a clean credential.
 */

// config.ts reads process.env at import, so the environment is set first and the
// module is imported dynamically per case with a cache-busting query.
async function loadConfig(env: Record<string, string>) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const mod = await import(`./config.ts?t=${Math.random()}`);
    return mod.config;
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const BASE = {
  NODE_ENV: 'development',
  TELEGRAM_BOT_TOKEN: '424242:AAH-config-test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'file:./prisma/dev.db',
};

describe('Cashera credential normalisation', () => {
  it('strips surrounding double quotes', async () => {
    const config = await loadConfig({
      ...BASE,
      CASHERA_API_KEY: '"pk_live_abc123"',
      CASHERA_API_SECRET: '"sk_live_xyz789"',
    });
    assert.equal(config.cashera.apiKey, 'pk_live_abc123');
    assert.equal(config.cashera.apiSecret, 'sk_live_xyz789');
    assert.equal(config.cashera.enabled, true);
  });

  it('strips surrounding single quotes', async () => {
    const config = await loadConfig({
      ...BASE,
      CASHERA_API_KEY: "'pk_live_abc123'",
      CASHERA_API_SECRET: "'sk_live_xyz789'",
    });
    assert.equal(config.cashera.apiKey, 'pk_live_abc123');
    assert.equal(config.cashera.apiSecret, 'sk_live_xyz789');
  });

  it('strips a trailing carriage return from a CRLF-edited env file', async () => {
    const config = await loadConfig({
      ...BASE,
      CASHERA_API_KEY: 'pk_live_abc123\r',
      CASHERA_API_SECRET: 'sk_live_xyz789\r',
    });
    assert.equal(config.cashera.apiKey, 'pk_live_abc123');
    assert.equal(config.cashera.apiSecret, 'sk_live_xyz789');
  });

  it('strips surrounding whitespace and quotes together', async () => {
    const config = await loadConfig({
      ...BASE,
      CASHERA_API_KEY: '  "pk_live_abc123"  \r',
      CASHERA_API_SECRET: ' "sk_live_xyz789" ',
    });
    assert.equal(config.cashera.apiKey, 'pk_live_abc123');
    assert.equal(config.cashera.apiSecret, 'sk_live_xyz789');
  });

  it('leaves a clean credential untouched', async () => {
    const config = await loadConfig({
      ...BASE,
      CASHERA_API_KEY: 'pk_live_abc123',
      CASHERA_API_SECRET: 'sk_live_xyz789',
    });
    assert.equal(config.cashera.apiKey, 'pk_live_abc123');
    assert.equal(config.cashera.apiSecret, 'sk_live_xyz789');
    assert.equal(config.cashera.enabled, true);
  });

  it('treats a whitespace-only credential as absent', async () => {
    // Before normalisation this counted as enabled, so the rail advertised itself
    // and then failed on every call. An empty key must mean the rail is off.
    const config = await loadConfig({
      ...BASE,
      CASHERA_API_KEY: '   ',
      CASHERA_API_SECRET: 'sk_live_xyz789',
    });
    assert.equal(config.cashera.apiKey, '');
    assert.equal(config.cashera.enabled, false);
  });

  it('does not strip a lone quote character inside the value', async () => {
    // Only one *matching* surrounding pair is removed. A value that happens to end
    // in a quote but does not start with one must be preserved as-is.
    const config = await loadConfig({
      ...BASE,
      CASHERA_API_KEY: "pk_live_ab'c",
      CASHERA_API_SECRET: 'sk_live_xyz789',
    });
    assert.equal(config.cashera.apiKey, "pk_live_ab'c");
  });
});
