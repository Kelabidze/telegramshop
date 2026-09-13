import { config } from '../config.js';
import { bot } from '../telegram/bot.js';

/**
 * Diagnoses the club channel configuration against the live Bot API, read-only.
 *
 * Run on the server, where the real `api.env` is loaded:
 *   npm run club:check -w @shop/api
 *
 * It answers the one question `/health` cannot: `clubChannelConfigured: true`
 * only says CLUB_CHANNEL_ID is non-empty, not that it points at the channel
 * people are actually being invited to join. Three ways that goes wrong and all
 * of them look like a working feature from the outside:
 *
 *  - the id names a different chat than CLUB_CHANNEL_URL, so subscribers of the
 *    advertised channel never get the club rate;
 *  - the bot is not an administrator, so `getChatMember` is refused for everyone
 *    and the rate is unreachable;
 *  - the id is stale after a channel change, and `getChatMember` answers "chat
 *    not found" — which `membership.ts` deliberately treats as "not a member".
 *
 * `getChat` is the right probe: same authentication and same chat resolution as
 * the membership lookup, but it reads nothing about a user and changes nothing.
 * The bot token is never printed, and neither is anything derived from it.
 */

function line(label: string, value: string): void {
  console.log(`${label.padEnd(24)} ${value}`);
}

/** `@name` from a `https://t.me/name` link, or null when it is an invite hash. */
function usernameFromUrl(url: string): string | null {
  const match = /^https?:\/\/t\.me\/(?!\+|joinchat\/)([A-Za-z0-9_]{4,})\/?$/.exec(url.trim());
  return match?.[1] ? `@${match[1]}` : null;
}

async function main(): Promise<void> {
  let problems = 0;
  const fail = (message: string) => {
    problems += 1;
    console.log(`  ✗ ${message}`);
  };

  console.log('\n=== configuration ===');
  line('membership checks', config.clubChannel.enabled ? 'enabled' : 'DISABLED');
  line('CLUB_CHANNEL_ID', config.clubChannel.id || '(empty)');
  line('CLUB_CHANNEL_URL', config.clubChannel.url || '(empty)');
  line('membership TTL', `${config.clubChannel.membershipTtlMs / 1000}s`);
  line('bot token', config.telegram.hasBotToken ? 'present' : 'MISSING');

  if (!config.clubChannel.enabled) {
    fail('CLUB_CHANNEL_ID is empty: nobody can earn the club rate.');
    console.log(`\n${problems} problem(s) found.`);
    process.exitCode = 1;
    return;
  }

  if (!bot) {
    fail('TELEGRAM_BOT_TOKEN is not set: membership cannot be verified at all.');
    console.log(`\n${problems} problem(s) found.`);
    process.exitCode = 1;
    return;
  }

  console.log('\n=== live probe (getChat) ===');
  let chatUsername: string | null = null;
  try {
    const chat = await bot.api.getChat(config.clubChannel.id);
    line('resolved id', String(chat.id));
    line('type', chat.type);
    if ('title' in chat && chat.title) line('title', chat.title);
    if ('username' in chat && chat.username) {
      chatUsername = `@${chat.username}`;
      line('username', chatUsername);
    }
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    fail(`getChat failed: ${description}`);
    console.log('\n  Most likely CLUB_CHANNEL_ID is wrong or the bot was never');
    console.log('  added to the channel. membership.ts treats this as "not a');
    console.log('  member", so every buyer silently pays the standard price.');
    console.log(`\n${problems} problem(s) found.`);
    process.exitCode = 1;
    return;
  }

  /**
   * The pairing check. Both halves can be individually valid and still describe
   * two different chats — the failure that charges the standard price to people
   * who did exactly what the app asked of them.
   */
  console.log('\n=== id and link agree ===');
  const expected = usernameFromUrl(config.clubChannel.url);
  if (!expected) {
    console.log('  · CLUB_CHANNEL_URL is a private invite link, so it cannot be');
    console.log('    compared with the resolved username. Verify it by hand.');
  } else if (!chatUsername) {
    console.log('  · The chat has no public username (private channel), so the');
    console.log(`    link ${config.clubChannel.url} cannot be verified here.`);
  } else if (chatUsername.toLowerCase() !== expected.toLowerCase()) {
    fail(
      `CLUB_CHANNEL_URL points at ${expected} but CLUB_CHANNEL_ID resolves to ` +
        `${chatUsername}. Subscribers of the advertised channel get no club rate.`,
    );
  } else {
    line('match', `${chatUsername} ✓`);
  }

  /**
   * Administrator rights are not optional: on channels the Bot API refuses
   * `getChatMember` for a bot that is only a member, and that refusal is a 403
   * the membership module has to treat as "not a member".
   */
  console.log('\n=== bot rights ===');
  try {
    const me = await bot.api.getMe();
    const self = await bot.api.getChatMember(config.clubChannel.id, me.id);
    line('bot status', self.status);
    if (self.status !== 'administrator' && self.status !== 'creator') {
      fail(
        'The bot is not an administrator of the channel. getChatMember is then ' +
          'refused and no member can ever be recognised.',
      );
    }
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    fail(`Could not read the bot's own membership: ${description}`);
  }

  console.log(
    problems === 0
      ? '\nClub channel is configured correctly and membership checks can succeed.'
      : `\n${problems} problem(s) found.`,
  );
  if (problems > 0) process.exitCode = 1;
}

await main();
