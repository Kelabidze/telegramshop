import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Credential normalisation from the environment.
 *
 * What these tests pin down: `CASHERA_API_KEY` and `CASHERA_API_SECRET` reach the
 * rest of the app trimmed and free of surrounding quotes, and a value that is only
 * whitespace counts as absent rather than making `/health` advertise a rail that
 * cannot work.
 *
 * To be clear about what this is NOT: it is not a fix for the production 401. That
 * was traced to the credential value itself, and systemd's `EnvironmentFile`
 * already discards surrounding quotes and trailing carriage returns, so on the
 * deployed path this transform changes nothing. The value is that every other way
 * these variables get read — `npm run dev` via Node's `--env-file`, a hand-written
 * override, a future loader with different quoting rules — gets the same clean
 * value instead of depending on which mechanism happened to load it.
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
