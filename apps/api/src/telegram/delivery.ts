import type { Order } from '@shop/shared';
import { prisma } from '../db.js';
import { bot } from '../telegram/bot.js';

/**
 * Telling the buyer their goods are ready.
 *
 * Extracted from the webhook handler because there are now two ways an order gets
 * paid, and only one of them has a grammY `Context` to reply into. A Stars payment
 * arrives as an update and can `ctx.reply`; an on-chain payment is noticed by the
 * monitor, with no incoming message to answer — it needs `bot.api.sendMessage` and
 * a chat id.
 *
 * The message text lives here so the two paths cannot drift into telling buyers
 * different things about the same event.
 */

/** The delivered secrets, formatted for a chat message. */
export function formatDeliveryMessage(order: Order): string {
  const delivered = order.lines
    .filter((line) => line.deliveredPayload)
    .map(
      (line) =>
        `<b>${escapeHtml(line.titleSnapshot)}</b>\n<code>${escapeHtml(
          line.deliveredPayload!,
        )}</code>`,
    )
    .join('\n\n');

  return `✅ Оплата получена. Заказ №${escapeHtml(order.reference)}\n\n${delivered}`;
}

export function formatFailedDeliveryMessage(order: Order): string {
  return (
    `Оплата получена (заказ №${escapeHtml(order.reference)}), но выдать товар ` +
    'автоматически не удалось. Мы уже разбираемся и свяжемся с вами.'
  );
}

/**
 * `parse_mode: 'HTML'` is used for the emphasis, so anything interpolated has to
 * be escaped. A product title is staff-controlled and a licence key is arbitrary
 * text: an unescaped `<` in either would break the message, and Telegram rejects
 * the whole send rather than degrading.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Sends the delivery notice for an order paid outside a webhook.
 *
 * Best effort by design: the goods are already recorded against the order and
 * visible on the orders screen, so a Telegram outage must not fail the payment
 * that has already settled on chain. Failures are reported to the caller to log,
 * never thrown.
 *
 * In a private chat the chat id equals the user's Telegram id, which is why no
 * chat id needs storing on the order.
 */
export async function notifyOrderDelivered(
  order: Order,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): Promise<boolean> {
  if (!bot) return false;

  const row = await prisma.order.findUnique({
    where: { id: order.id },
    select: { user: { select: { telegramId: true } } },
  });
  const chatId = row?.user.telegramId;
  if (!chatId) return false;

  const text =
    order.status === 'FAILED'
      ? formatFailedDeliveryMessage(order)
      : formatDeliveryMessage(order);

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    return true;
  } catch (error) {
    logger?.warn(
      {
        orderId: order.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'Could not send the delivery notification',
    );
    return false;
  }
}
