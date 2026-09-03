/**
 * Club channel membership: caching and failure behaviour.
 *
 * Runs against a stub Bot API served over loopback, so `getChatMember` is
 * exercised for real (grammY builds the request, parses the response) without
 * touching the network. Counting requests is the point: the cache is what keeps
 * `/api/me` off the Bot API on every call.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

const BOT_TOKEN = '424242:AAH-membership-test-token';
const CHANNEL_ID = '@club_channel_under_test';
const TTL_SECONDS = 60;

/**
 * Reply the stub returns for the next getChatMember call.
 *
 * `destroy` drops the connection instead of answering, which is the only honest
 * way to produce a transport failure: any HTTP response — even a 500 with
 * garbage in it — reaches grammY as an API-level error, which is a different
 * code path with different caching rules.
 */
type StubReply =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'destroy' };

let nextResponse: StubReply = {
  kind: 'json',
  status: 200,
  body: { ok: true, result: { status: 'member', user: { id: 1 } } },
};

let requestCount = 0;
let stub: Server;

let isClubChannelMember: typeof import('./membership.ts')['isClubChannelMember'];
let forgetClubMembership: typeof import('./membership.ts')['forgetClubMembership'];
let clearClubMembershipCache: typeof import('./membership.ts')['clearClubMembershipCache'];

function memberResponse(status: string): StubReply {
  return {
    kind: 'json',
    status: 200,
    body: { ok: true, result: { status, user: { id: 1 } } },
  };
}

before(async () => {
  stub = createServer((req, res) => {
    if (req.url?.includes('getChatMember')) requestCount += 1;
    if (nextResponse.kind === 'destroy') {
      res.socket?.destroy();
      return;
    }
    res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(nextResponse.body));
  });

  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  // config.ts reads env at import time, so the environment must be complete
  // before the module graph is loaded.
  process.env.NODE_ENV = 'development';
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_API_ROOT = `http://127.0.0.1:${port}`;
  process.env.CLUB_CHANNEL_ID = CHANNEL_ID;
  process.env.CLUB_CHANNEL_URL = 'https://t.me/club_channel_under_test';
  process.env.CLUB_MEMBERSHIP_TTL_SECONDS = String(TTL_SECONDS);

  ({
    isClubChannelMember,
    forgetClubMembership,
    clearClubMembershipCache,
  } = await import('./membership.ts'));
});

after(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

beforeEach(() => {
  clearClubMembershipCache();
  requestCount = 0;
});

describe('isClubChannelMember', () => {
  it('treats creator, administrator and member as subscribed', async () => {
    for (const status of ['creator', 'administrator', 'member']) {
      clearClubMembershipCache();
      nextResponse = memberResponse(status);
      assert.equal(
        await isClubChannelMember('1001'),
        true,
        `status "${status}" must count as a member`,
      );
    }
  });

  it('treats left, kicked and restricted as not subscribed', async () => {
    // `restricted` is the subtle one: the user is *known* to the channel but not
    // currently in it. Counting it as membership would hand the club rate to
    // someone who was banned.
    for (const status of ['left', 'kicked', 'restricted']) {
      clearClubMembershipCache();
      nextResponse = memberResponse(status);
      assert.equal(
        await isClubChannelMember('1002'),
        false,
        `status "${status}" must not count as a member`,
      );
    }
  });

  it('asks Telegram once and serves the rest from cache', async () => {
    nextResponse = memberResponse('member');

    assert.equal(await isClubChannelMember('2001'), true);
    assert.equal(requestCount, 1);

    for (let i = 0; i < 5; i += 1) {
      assert.equal(await isClubChannelMember('2001'), true);
    }
    assert.equal(
      requestCount,
      1,
      'a cached answer must not produce more Bot API calls',
    );
  });

  it('caches per user, not globally', async () => {
    nextResponse = memberResponse('member');
    assert.equal(await isClubChannelMember('3001'), true);

    nextResponse = memberResponse('left');
    assert.equal(
      await isClubChannelMember('3002'),
      false,
      "one user's answer must not leak into another's",
    );
    assert.equal(requestCount, 2);
  });

  it('re-checks immediately after the cache is dropped', async () => {
    // This is what the bot's "Я подписался!" button relies on: the negative
    // answer cached a second ago must not outlive the user's action.
    nextResponse = memberResponse('left');
    assert.equal(await isClubChannelMember('4001'), false);
    assert.equal(requestCount, 1);

    nextResponse = memberResponse('member');
    assert.equal(
      await isClubChannelMember('4001'),
      false,
      'still cached, so still the old answer',
    );
    assert.equal(requestCount, 1);

    forgetClubMembership('4001');
    assert.equal(await isClubChannelMember('4001'), true);
    assert.equal(requestCount, 2);
  });

  it('fails closed when Telegram returns an error', async () => {
    // 400 "user not found" is the ordinary answer for a non-member.
    nextResponse = {
      kind: 'json',
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: user not found' },
    };
    assert.equal(await isClubChannelMember('5001'), false);
  });

  it('fails closed when the bot is not an admin of the channel', async () => {
    // A misconfiguration, not a user state. It must not grant the club rate:
    // failing open would hand a reduced price to everybody the moment the bot
    // loses its channel rights.
    nextResponse = {
      kind: 'json',
      status: 403,
      body: {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot is not a member of the channel chat',
      },
    };
    assert.equal(await isClubChannelMember('5002'), false);
  });

  it('does not cache a transport failure', async () => {
    // A network blip must not pin a paying member to the standard price for the
    // whole TTL, so this answer is deliberately not cached.
    nextResponse = { kind: 'destroy' };
    assert.equal(await isClubChannelMember('6001'), false);
    const afterFailure = requestCount;

    nextResponse = memberResponse('member');
    assert.equal(
      await isClubChannelMember('6001'),
      true,
      'the club rate must come back as soon as Telegram does',
    );
    assert.ok(
      requestCount > afterFailure,
      'the failed lookup must be retried, not served from cache',
    );
  });

  it('still caches an API-level error, which is a real answer', async () => {
    // The contrast with the previous case: "user not found" is Telegram
    // *answering*, so caching it is correct — otherwise every request from every
    // non-member would hit the Bot API and burn the rate limit.
    nextResponse = {
      kind: 'json',
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: user not found' },
    };
    assert.equal(await isClubChannelMember('7001'), false);
    const afterFirst = requestCount;

    assert.equal(await isClubChannelMember('7001'), false);
    assert.equal(
      requestCount,
      afterFirst,
      'a negative answer must be cached too',
    );
  });
});
