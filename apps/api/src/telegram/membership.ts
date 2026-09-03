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

/** Minimal logger surface, so a Fastify request logger can be passed in. */
export interface MembershipLogger {
  warn(payload: Record<string, unknown>, message: string): void;
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
  if (!config.clubChannel.enabled || !bot) return false;

  const cached = cache.get(telegramId);
  if (cached && cached.expiresAt > Date.now()) return cached.isMember;

  let isMember = false;
  let cacheable = true;

  try {
    const member = await bot.api.getChatMember(
      config.clubChannel.id,
      Number(telegramId),
    );
    isMember = MEMBER_STATUSES.has(member.status);
  } catch (error) {
    if (error instanceof GrammyError) {
      // 400 "user not found" is the ordinary answer for somebody who never
      // joined. Anything else — bot is not an administrator of the channel,
      // wrong id — is a misconfiguration that silently disables the club rate,
      // so it must be visible in the logs rather than inferred from complaints.
      if (error.error_code !== 400) {
        log?.warn(
          { errorCode: error.error_code, description: error.description },
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
}
