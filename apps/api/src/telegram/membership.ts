import { GrammyError } from 'grammy';
import { config } from '../config.js';
import { bot } from './bot.js';

/**
 * Club channel membership.
 *
 * Answers one question — "is this user in the channel?" — and caches the answer
 * in memory. Without a cache every `/api/me` and every checkout would hit the
 * Bot API, which is rate limited and slower than the database query next to it.
 *
 * In-memory on purpose: the answer is cheap to recompute, worthless after a
 * minute, and the API is a single process. Redis here would add a dependency
 * and a failure mode to cache something that expires before it is worth
 * persisting.
 */

/** Statuses that mean "currently in the channel". */
const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

/**
 * Descriptions Telegram returns for "this chat does not exist / we cannot see
 * it". Distinct from "user not found": the first is a misconfiguration (wrong
 * id, bot not in the channel), the second is the ordinary non-member answer.
 * Treating them the same is how a typo in CLUB_CHANNEL_ID silently disables
 * the whole club rate with no log line at all.
 */
const CHAT_MISCONFIGURED = /chat not found|CHAT_ID_INVALID|PEER_ID_INVALID|chat_id is empty/i;

/** Ordinary "this user is not in the chat" answers. */
const USER_NOT_IN_CHAT = /user not found|PARTICIPANT_ID_INVALID|USER_ID_INVALID|user_id_invalid/i;

interface CacheEntry {
  isMember: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Positive answers live for the configured TTL; negative ones expire sooner.
 *
 * Asymmetric on purpose: the costly mistake is caching "not a member" for
 * someone who just joined — they see the offer, subscribe, come back and are
 * still charged the standard price, which reads as the shop ignoring them.
 * Caching "member" slightly too long only ever favours the customer.
 */
const NEGATIVE_TTL_DIVISOR = 4;

/**
 * Misconfiguration warnings fire once per process, not per request.
 *
 * A wrong channel id would otherwise produce a warn on every `/api/me` and bury
 * everything else in the journal; firing once is enough to diagnose and cheap
 * enough that a later fix + restart re-surfaces it.
 */
let warnedMisconfiguredChat = false;
let warnedNotAdmin = false;
let warnedDisabled = false;

/** Minimal logger surface, so a Fastify request logger can be passed in. */
export interface MembershipLogger {
  warn(payload: Record<string, unknown>, message: string): void;
  info?(payload: Record<string, unknown>, message: string): void;
  debug?(payload: Record<string, unknown>, message: string): void;
}

/**
 * True when the user is in the club channel.
 *
 * **Never throws.** Membership only decides whether a price is reduced, so an
 * unreachable Bot API must fail closed — no club rate — rather than propagate:
 * throwing would take `/api/me` (and with it the whole app shell) down with
 * Telegram. Failing *open* was the other option and is worse: a single Telegram
 * hiccup would hand the reduced price to everyone.
 */
export async function isClubChannelMember(
  telegramId: string,
  log?: MembershipLogger,
): Promise<boolean> {
  if (!config.clubChannel.enabled) {
    // Once: otherwise every authenticated request would remind us the feature
    // is off, and the journal would hide real problems under that noise.
    if (!warnedDisabled) {
      warnedDisabled = true;
      log?.warn(
        {},
        'Club channel is not configured (CLUB_CHANNEL_ID empty); membership checks are skipped.',
      );
    }
    return false;
  }

  if (!bot) {
    // Token missing: same once-per-process rule. Production refuses to boot
    // without a token, so this path is for local catalog-only runs.
    if (!warnedDisabled) {
      warnedDisabled = true;
      log?.warn(
        {},
        'TELEGRAM_BOT_TOKEN is not set; club membership cannot be verified.',
      );
    }
    return false;
  }

  const cached = cache.get(telegramId);
  if (cached && cached.expiresAt > Date.now()) {
    log?.debug?.(
      { telegramId, isMember: cached.isMember, cached: true },
      'Club membership served from cache',
    );
    return cached.isMember;
  }

  let isMember = false;
  let cacheable = true;

  try {
    const member = await bot.api.getChatMember(
      config.clubChannel.id,
      Number(telegramId),
    );
    isMember = MEMBER_STATUSES.has(member.status);
    log?.debug?.(
      {
        telegramId,
        status: member.status,
        isMember,
        channelId: config.clubChannel.id,
      },
      'getChatMember succeeded',
    );
  } catch (error) {
    if (error instanceof GrammyError) {
      const description = error.description ?? '';

      if (USER_NOT_IN_CHAT.test(description)) {
        // Ordinary non-member. Expected, frequent, not worth a warn.
        isMember = false;
      } else if (CHAT_MISCONFIGURED.test(description)) {
        // Wrong CLUB_CHANNEL_ID, or the bot was never added to the channel.
        // Previously this was swallowed as "user not found" because every 400
        // looked the same — which is exactly how a typo disabled the feature
        // with zero log lines.
        isMember = false;
        if (!warnedMisconfiguredChat) {
          warnedMisconfiguredChat = true;
          log?.warn(
            {
              errorCode: error.error_code,
              description,
              channelId: config.clubChannel.id,
            },
            'getChatMember cannot see the club channel. Check CLUB_CHANNEL_ID ' +
              '(channels are usually -100…) and that the bot is a member of it.',
          );
        }
      } else if (error.error_code === 403) {
        // Bot is in the chat but not an administrator — getChatMember then
        // refuses for non-admins' own membership lookups on channels.
        isMember = false;
        if (!warnedNotAdmin) {
          warnedNotAdmin = true;
          log?.warn(
            {
              errorCode: error.error_code,
              description,
              channelId: config.clubChannel.id,
            },
            'Bot is not an administrator of the club channel; getChatMember is refused.',
          );
        }
      } else {
        // Anything else (rate limit, unexpected 400, …) — always visible.
        isMember = false;
        log?.warn(
          {
            errorCode: error.error_code,
            description,
            channelId: config.clubChannel.id,
            telegramId,
          },
          'getChatMember failed; treating the viewer as a non-member.',
        );
      }
    } else {
      // Network or timeout. Not cached: caching a transport failure would keep
      // a paying member on the standard price long after Telegram recovered.
      cacheable = false;
      log?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Could not reach Telegram to check channel membership.',
      );
    }
  }

  if (cacheable) {
    const ttl = config.clubChannel.membershipTtlMs;
    cache.set(telegramId, {
      isMember,
      expiresAt: Date.now() + (isMember ? ttl : ttl / NEGATIVE_TTL_DIVISOR),
    });
  }

  return isMember;
}

/**
 * Drops a cached answer.
 *
 * Called when the user states they just subscribed: re-checking immediately is
 * exactly what they are asking for, and waiting out the TTL would make the
 * "Я подписался!" button look broken.
 */
export function forgetClubMembership(telegramId: string): void {
  cache.delete(telegramId);
}

/** Test seam: the cache is process-wide and would leak between test cases. */
export function clearClubMembershipCache(): void {
  cache.clear();
  warnedMisconfiguredChat = false;
  warnedNotAdmin = false;
  warnedDisabled = false;
}
