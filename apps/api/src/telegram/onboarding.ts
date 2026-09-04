import type { Context } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from '@grammyjs/types';
import { CLUB_TIER_PERCENT } from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import {
  forgetClubMembership,
  isClubChannelMember,
} from './membership.js';

/**
 * Bot-side club onboarding.
 *
 * `/start` and the "Я подписался!" button live here rather than in `routes/bot.ts`
 * so the payment handlers stay readable, and so the copy can be unit-tested
 * without spinning up grammY.
 *
 * "Я подписался!" is a **callback**, not a Mini App button: the check has to
 * happen in the chat, and a `web_app` button would leave before we can answer.
 * "Подписаться" is a URL button. Bot API cannot subscribe a user to a channel
 * and `answerCallbackQuery({ url })` only accepts `t.me/bot?start=` links, not
 * a channel — a URL button is the only thing that actually opens it.
 */

export const CLUB_CHECK_CALLBACK = 'club:check';

export const MEMBERSHIP_POLL_FIRST_DELAY_MS = 3_000;
export const MEMBERSHIP_POLL_INTERVAL_MS = 3_000;
export const MEMBERSHIP_POLL_WINDOW_MS = 15_000;

/** Offsets from the click at which the follow-up checks run: 3, 6, 9, 12, 15 s. */
export function membershipPollOffsetsMs(): number[] {
  const offsets: number[] = [];
  for (
    let t = MEMBERSHIP_POLL_FIRST_DELAY_MS;
    t <= MEMBERSHIP_POLL_FIRST_DELAY_MS + MEMBERSHIP_POLL_WINDOW_MS;
    t += MEMBERSHIP_POLL_INTERVAL_MS
  ) {
    offsets.push(t);
  }
  return offsets;
}

const CHANNEL_TITLE = 'OCHKISK';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function miniAppUrl(): string | null {
  const base = config.publicAppUrl || config.publicApiUrl;
  return base || null;
}

function shopButton(label = 'Открыть магазин'): InlineKeyboardButton | null {
  const url = miniAppUrl();
  if (!url) return null;
  return { text: label, web_app: { url } };
}

function subscribedCheckButton(): InlineKeyboardButton {
  return {
    text: 'Я подписался!',
    callback_data: CLUB_CHECK_CALLBACK,
    style: 'success',
  };
}

function subscribeUrlButton(): InlineKeyboardButton | null {
  if (!config.clubChannel.url) return null;
  return {
    text: 'Подписаться',
    url: config.clubChannel.url,
    style: 'success',
  };
}

function continueWithoutButton(): InlineKeyboardButton | null {
  const url = miniAppUrl();
  if (!url) return null;
  return {
    text: `Продолжить без скидки в ${CLUB_TIER_PERCENT}%`,
    web_app: { url },
  };
}

function keyboard(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}

export function notSubscribedHtml(channelUrl: string): string {
  const href = escapeHtml(channelUrl);
  const title = escapeHtml(CHANNEL_TITLE);
  return (
    `Ты не подписан на <a href="${href}">канал</a>, твоя клубная скидка в ` +
    `${CLUB_TIER_PERCENT}% не активна.\n\n` +
    `Подписаться:\n<a href="${href}">${title}</a>`
  );
}

export function congratulationsHtml(): string {
  return 'Поздравляю! Клубная скидка активна!';
}

export function returningMemberHtml(firstName: string): string {
  return (
    `С возвращением, ${escapeHtml(firstName)}!\n\n` +
    'Рад тебя видеть. Заходи — если появилось что-то новое, я напишу.'
  );
}

export function firstVisitHtml(firstName: string, channelUrl: string | null): string {
  const name = escapeHtml(firstName);
  if (!channelUrl) {
    return `Привет, ${name}! Я — Фин, и это мой магазин с цифровыми товарами.`;
  }
  return (
    `Привет, ${name}! Я — Фин, и это мой магазин с цифровыми товарами.\n\n` +
    `Подпишись на мой канал, для получения клубной скидки ${CLUB_TIER_PERCENT}% на все товары!`
  );
}

export function returningGuestHtml(firstName: string, channelUrl: string): string {
  return (
    `С возвращением, ${escapeHtml(firstName)}!\n\n` +
    notSubscribedHtml(channelUrl)
  );
}

function firstVisitKeyboard(): InlineKeyboardMarkup | undefined {
  const check = subscribedCheckButton();
  const skip = continueWithoutButton();
  const rows: InlineKeyboardButton[][] = [[check]];
  if (skip) rows.push([skip]);
  return keyboard(rows);
}

function notSubscribedKeyboard(): InlineKeyboardMarkup | undefined {
  const subscribe = subscribeUrlButton();
  const shop = shopButton();
  const rows: InlineKeyboardButton[][] = [];
  if (subscribe) rows.push([subscribe]);
  if (shop) rows.push([shop]);
  return rows.length > 0 ? keyboard(rows) : undefined;
}

function shopOnlyKeyboard(): InlineKeyboardMarkup | undefined {
  const shop = shopButton();
  return shop ? keyboard([[shop]]) : undefined;
}

const replyOpts = {
  parse_mode: 'HTML' as const,
  link_preview_options: { is_disabled: true },
};

interface PollHandle {
  cancelled: boolean;
}

const polls = new Map<string, PollHandle>();

function cancelPoll(telegramId: string): void {
  const existing = polls.get(telegramId);
  if (existing) existing.cancelled = true;
  polls.delete(telegramId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * After a failed "Я подписался!" click: wait 3 s, then re-check every 3 s
 * for 15 s. Stops on the first positive answer and edits the same message
 * so the chat does not fill with repeats. A new /start or a new click
 * cancels the previous poll — otherwise two loops would race to edit.
 */
function startMembershipPoll(
  ctx: Context,
  telegramId: string,
  chatId: number,
  messageId: number,
): void {
  cancelPoll(telegramId);
  const handle: PollHandle = { cancelled: false };
  polls.set(telegramId, handle);

  void (async () => {
    const offsets = membershipPollOffsetsMs();
    let elapsed = 0;
    for (const offset of offsets) {
      await sleep(offset - elapsed);
      elapsed = offset;
      if (handle.cancelled) return;

      forgetClubMembership(telegramId);
      const isMember = await isClubChannelMember(telegramId);
      if (!isMember) continue;

      cancelPoll(telegramId);
      try {
        await ctx.api.editMessageText(chatId, messageId, congratulationsHtml(), {
          ...replyOpts,
          reply_markup: shopOnlyKeyboard(),
        });
      } catch {
        // Message deleted or identical — not worth a second send.
      }
      return;
    }
    polls.delete(telegramId);
  })();
}

async function hasVisitedShop(telegramId: string): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  return row !== null;
}

async function replaceMessage(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup: InlineKeyboardMarkup | undefined,
): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, text, {
      ...replyOpts,
      reply_markup: replyMarkup,
    });
  } catch {
    await ctx.api.sendMessage(chatId, text, {
      ...replyOpts,
      reply_markup: replyMarkup,
    });
  }
}

export async function handleStart(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const telegramId = String(from.id);
  const firstName = from.first_name?.trim() || 'друг';
  cancelPoll(telegramId);
  forgetClubMembership(telegramId);

  const [returning, isMember] = await Promise.all([
    hasVisitedShop(telegramId),
    isClubChannelMember(telegramId),
  ]);

  const channelUrl = config.clubChannel.url || null;

  if (!channelUrl) {
    await ctx.reply(firstVisitHtml(firstName, null), {
      ...replyOpts,
      reply_markup: shopOnlyKeyboard(),
    });
    return;
  }

  if (isMember) {
    const text = returning
      ? returningMemberHtml(firstName)
      : `${firstVisitHtml(firstName, channelUrl)}\n\n${congratulationsHtml()}`;
    await ctx.reply(text, {
      ...replyOpts,
      reply_markup: shopOnlyKeyboard(),
    });
    return;
  }

  if (returning) {
    await ctx.reply(returningGuestHtml(firstName, channelUrl), {
      ...replyOpts,
      reply_markup: notSubscribedKeyboard(),
    });
    return;
  }

  await ctx.reply(firstVisitHtml(firstName, channelUrl), {
    ...replyOpts,
    reply_markup: firstVisitKeyboard(),
  });
}

export async function handleClubCheckCallback(ctx: Context): Promise<void> {
  const from = ctx.from;
  const message = ctx.callbackQuery?.message;
  if (!from || !message || !('message_id' in message)) {
    await ctx.answerCallbackQuery();
    return;
  }

  const telegramId = String(from.id);
  const chatId = message.chat.id;
  const messageId = message.message_id;

  await ctx.answerCallbackQuery({ text: 'Проверяю подписку…' });

  forgetClubMembership(telegramId);
  const isMember = await isClubChannelMember(telegramId);

  if (isMember) {
    cancelPoll(telegramId);
    await replaceMessage(
      ctx,
      chatId,
      messageId,
      congratulationsHtml(),
      shopOnlyKeyboard(),
    );
    return;
  }

  const channelUrl = config.clubChannel.url;
  if (!channelUrl) {
    await replaceMessage(
      ctx,
      chatId,
      messageId,
      'Канал пока не настроен — открой магазин без клубной скидки.',
      shopOnlyKeyboard(),
    );
    return;
  }

  await replaceMessage(
    ctx,
    chatId,
    messageId,
    notSubscribedHtml(channelUrl),
    notSubscribedKeyboard(),
  );
  startMembershipPoll(ctx, telegramId, chatId, messageId);
}

/** Test seam: in-flight polls would otherwise leak across cases. */
export function clearOnboardingPolls(): void {
  for (const handle of polls.values()) handle.cancelled = true;
  polls.clear();
}
