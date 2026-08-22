import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  InitDataError,
  createSignedInitData,
  isInitDataValid,
  signInitData,
  verifyInitData,
} from './init-data.ts';

const BOT_TOKEN = '123456:TEST-TOKEN-do-not-use-in-production';
const USER = {
  id: 279058397,
  first_name: 'Vladislav',
  last_name: 'Kibenko',
  username: 'vdkfrost',
  language_code: 'ru',
  is_premium: true,
};

/** Fixed clock so auth_date based tests are deterministic. */
const AUTH_DATE = 1_700_000_000;
const now = () => (AUTH_DATE + 10) * 1000;

function validInitData(extra: Record<string, string | number | object> = {}) {
  return createSignedInitData(
    { auth_date: AUTH_DATE, query_id: 'AAHdF6IQAAAAAN0XohDhrOrc', user: USER, ...extra },
    BOT_TOKEN,
  );
}

/** Runs `fn` and returns the thrown InitDataError, failing if nothing throws. */
function expectInitDataError(fn: () => unknown): InitDataError {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof InitDataError,
      `Expected InitDataError, got ${String(error)}`,
    );
    return error;
  }
  assert.fail('Expected the call to throw, but it returned normally.');
}

describe('verifyInitData', () => {
  it('accepts correctly signed data and parses nested JSON', () => {
    const data = verifyInitData(validInitData(), { botToken: BOT_TOKEN, now });
    assert.equal(data.auth_date, AUTH_DATE);
    assert.equal(data.user?.id, USER.id);
    assert.equal(data.user?.username, 'vdkfrost');
    assert.equal(data.query_id, 'AAHdF6IQAAAAAN0XohDhrOrc');
  });

  it('includes the `signature` field in the checked payload', () => {
    // A launch containing `signature` must still verify. If an implementation
    // wrongly excludes it from the check string, this test fails.
    const raw = validInitData({ signature: 'abc123_signature-value' });
    const data = verifyInitData(raw, { botToken: BOT_TOKEN, now });
    assert.equal(data.signature, 'abc123_signature-value');
  });

  it('rejects a tampered user id', () => {
    const raw = validInitData();
    const params = new URLSearchParams(raw);
    params.set('user', JSON.stringify({ ...USER, id: 1 }));
    const err = expectInitDataError(() =>
      verifyInitData(params.toString(), { botToken: BOT_TOKEN, now }),
    );
    assert.equal(err.reason, 'BAD_SIGNATURE');
  });

  it('rejects data signed with a different bot token', () => {
    const raw = createSignedInitData({ auth_date: AUTH_DATE, user: USER }, 'other:token');
    const err = expectInitDataError(() =>
      verifyInitData(raw, { botToken: BOT_TOKEN, now }),
    );
    assert.equal(err.reason, 'BAD_SIGNATURE');
  });

  it('rejects an added extra field', () => {
    const params = new URLSearchParams(validInitData());
    params.set('is_admin', 'true');
    const err = expectInitDataError(() =>
      verifyInitData(params.toString(), { botToken: BOT_TOKEN, now }),
    );
    assert.equal(err.reason, 'BAD_SIGNATURE');
  });

  it('rejects empty input', () => {
    const err = expectInitDataError(() =>
      verifyInitData('', { botToken: BOT_TOKEN, now }),
    );
    assert.equal(err.reason, 'EMPTY');
  });

  it('rejects missing hash', () => {
    const params = new URLSearchParams(validInitData());
    params.delete('hash');
    const err = expectInitDataError(() =>
      verifyInitData(params.toString(), { botToken: BOT_TOKEN, now }),
    );
    assert.equal(err.reason, 'MISSING_HASH');
  });

  it('rejects expired data', () => {
    const raw = validInitData();
    const err = expectInitDataError(() =>
      verifyInitData(raw, {
        botToken: BOT_TOKEN,
        maxAgeSeconds: 60,
        now: () => (AUTH_DATE + 3600) * 1000,
      }),
    );
    assert.equal(err.reason, 'EXPIRED');
  });

  it('allows old data when the age check is disabled', () => {
    const raw = validInitData();
    const data = verifyInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 0,
      now: () => (AUTH_DATE + 10_000_000) * 1000,
    });
    assert.equal(data.user?.id, USER.id);
  });

  it('refuses to verify without a bot token', () => {
    const err = expectInitDataError(() =>
      verifyInitData(validInitData(), { botToken: '', now }),
    );
    assert.equal(err.reason, 'NO_BOT_TOKEN');
  });

  it('is order-independent because pairs are sorted', () => {
    const raw = validInitData();
    const params = [...new URLSearchParams(raw).entries()];
    const reversed = new URLSearchParams(params.reverse());
    const data = verifyInitData(reversed.toString(), { botToken: BOT_TOKEN, now });
    assert.equal(data.user?.id, USER.id);
  });

  it('handles values containing special characters', () => {
    const raw = createSignedInitData(
      {
        auth_date: AUTH_DATE,
        user: { ...USER, first_name: 'Ann & Bob=\n%20+', last_name: 'Ω 🚀' },
        start_param: 'a=b&c%3Dd',
      },
      BOT_TOKEN,
    );
    const data = verifyInitData(raw, { botToken: BOT_TOKEN, now });
    assert.equal(data.user?.first_name, 'Ann & Bob=\n%20+');
    assert.equal(data.user?.last_name, 'Ω 🚀');
    assert.equal(data.start_param, 'a=b&c%3Dd');
  });

  it('isInitDataValid mirrors verifyInitData without throwing', () => {
    assert.equal(isInitDataValid(validInitData(), { botToken: BOT_TOKEN, now }), true);
    assert.equal(isInitDataValid('hash=deadbeef', { botToken: BOT_TOKEN, now }), false);
  });

  it('signInitData matches the documented algorithm', () => {
    // Independently recompute using the spec's steps.
    const raw = validInitData();
    const params = new URLSearchParams(raw);
    const receivedHash = params.get('hash');
    params.delete('hash');
    const checkString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected = createHmac('sha256', secret).update(checkString).digest('hex');
    assert.equal(receivedHash, expected);
    assert.equal(signInitData(raw, BOT_TOKEN), expected);
  });
});
