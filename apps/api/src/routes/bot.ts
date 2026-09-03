import type { FastifyPluginAsync } from 'fastify';
import { webhookCallback } from 'grammy';
import {
  CLUB_RECHECK_PARAM,
  CLUB_TIER_PERCENT,
  formatMoney,
  currencySchema,
} from '@shop/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { bot } from '../telegram/bot.js';
import { findOrderByPayload, markOrderPaid } from '../services/orders.js';

/**
 * Telegram bot wiring.
 *
 * Payment flow for digital goods:
 *   1. Mini App calls POST /api/orders  -> order + invoice link
 *   2. Mini App calls WebApp.openInvoice(link)
 *   3. Telegram sends `pre_checkout_query` -> must be answered within 10s
 *   4. On success Telegram sends `message.successful_payment` -> deliver goods
 *
 * Telegram retries updates it considers unacknowledged, so every update is
 * recorded in `ProcessedUpdate` and skipped if already handled.
 */

/** Returns true when this update has not been processed before. */
async function claimUpdate(updateId: number): Promise<boolean> {
  try {
    await prisma.processedUpdate.create({
      data: { updateId: String(updateId) },
    });
    return true;
  } catch {
    // Unique constraint violation -> duplicate delivery.
    return false;
  }
}

/**
 * Where the web_app buttons point.
 *
 * The Mini App, not the API: `PUBLIC_API_URL` serves `/api`, and opening that as
 * a Mini App shows the user a JSON 404. Falls back to `PUBLIC_API_URL` only
 * because in the production setup Caddy serves both from one origin.
 *
 * The recheck marker is an ordinary query parameter. Telegram's `start_param`
 * would be the natural home for it, but it is populated only for direct
 * `t.me/bot/app?startapp=` links and the attachment menu — never for an inline
 * `web_app` button, which is what this keyboard uses. The Mini App reads it off
 * its own URL instead.
 */
function miniAppUrl(recheckMembership = false): string | null {
  const base = config.publicAppUrl || config.publicApiUrl;
  if (!base) return null;
  if (!recheckMembership) return base;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${CLUB_RECHECK_PARAM}=1`;
}

function registerHandlers(): void {
  if (!bot) return;

  bot.command('start', async (ctx) => {
    const firstName = ctx.from?.first_name ?? 'друг';
    const channelUrl = config.clubChannel.url;

    const text = channelUrl
      ? `Привет, ${firstName}! Я — Фин, и это мой магазин с цифровыми ` +
        `товарами.\n\nПодпишись на мой канал, для получения клубной скидки ` +
        `${CLUB_TIER_PERCENT}% на все товары!\n\n${channelUrl}`
      : `Привет, ${firstName}! Я — Фин, и это мой магазин с цифровыми товарами.`;

    // Two web_app buttons rather than one: whoever just subscribed needs the
    // membership re-checked on entry, and whoever did not must still be able to
    // shop. A single button would either never refresh the club status or force
    // everyone through the channel.
    const subscribedUrl = miniAppUrl(true);
    const plainUrl = miniAppUrl();

    if (!subscribedUrl || !plainUrl) {
      // No public origin configured: a keyboard whose buttons cannot work is
      // worse than no keyboard, because it looks broken rather than absent.
      await ctx.reply(text, { link_preview_options: { is_disabled: true } });
      return;
    }

    await ctx.reply(text, {
      // The channel link is in the text on purpose, but its preview card would
      // push the buttons off the first screen.
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: channelUrl
          ? [
              [{ text: 'Я подписался!', web_app: { url: subscribedUrl } }],
              [
                {
                  text: `Продолжить без скидки в ${CLUB_TIER_PERCENT}%`,
                  web_app: { url: plainUrl },
                },
              ],
            ]
          : // Without a channel there is nothing to subscribe to, so the choice
            // would be between two identical buttons.
            [[{ text: '🛍 Открыть магазин', web_app: { url: plainUrl } }]],
      },
    });
  });

  bot.command('orders', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const user = await prisma.user.findUnique({
      where: { telegramId },
      include: {
        orders: {
          where: { status: 'PAID' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { lines: true },
        },
      },
    });

    if (!user || user.orders.length === 0) {
      await ctx.reply('У вас пока нет оплаченных заказов.');
      return;
    }

    const lines = user.orders.map((order) => {
      const currency = currencySchema.catch('XTR').parse(order.currency);
      return `№${order.reference} — ${formatMoney(order.totalAmountMinor, currency)}`;
    });
    await ctx.reply(`Ваши заказы:\n${lines.join('\n')}`);
  });

  /**
   * Must be answered within 10 seconds or the payment fails.
   * This is the last chance to refuse before the user is charged.
   */
  bot.on('pre_checkout_query', async (ctx) => {
    const payload = ctx.preCheckoutQuery.invoice_payload;
    try {
      const order = await findOrderByPayload(payload);

      if (!order) {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Заказ не найден. Оформите его заново.',
        });
        return;
      }
      if (order.status === 'PAID') {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Этот заказ уже оплачен.',
        });
        return;
      }
      if (order.status !== 'PENDING') {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Заказ больше не активен.',
        });
        return;
      }
      if (order.totalAmountMinor !== ctx.preCheckoutQuery.total_amount) {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Сумма изменилась. Оформите заказ заново.',
        });
        return;
      }

      await ctx.answerPreCheckoutQuery(true);
    } catch {
      await ctx.answerPreCheckoutQuery(false, {
        error_message: 'Внутренняя ошибка. Попробуйте позже.',
      });
    }
  });

  /** Payment confirmed: deliver the goods. */
  bot.on('message:successful_payment', async (ctx) => {
    const payment = ctx.message.successful_payment;

    const order = await markOrderPaid({
      invoicePayload: payment.invoice_payload,
      telegramPaymentChargeId: payment.telegram_payment_charge_id ?? null,
      providerPaymentChargeId: payment.provider_payment_charge_id ?? null,
    });

    if (!order) {
      await ctx.reply(
        'Оплата получена, но заказ не найден. Напишите в поддержку — мы всё решим.',
      );
      return;
    }

    if (order.status === 'FAILED') {
      await ctx.reply(
        `Оплата получена (заказ №${order.reference}), но выдать товар автоматически не удалось. ` +
          'Мы уже разбираемся и свяжемся с вами.',
      );
      return;
    }

    const delivered = order.lines
      .filter((line) => line.deliveredPayload)
      .map((line) => `<b>${line.titleSnapshot}</b>\n<code>${line.deliveredPayload}</code>`)
      .join('\n\n');

    await ctx.reply(
      `✅ Оплата получена. Заказ №${order.reference}\n\n${delivered}`,
      { parse_mode: 'HTML' },
    );
  });

  /** Stars refunds. */
  bot.on('message:refunded_payment', async (ctx) => {
    const refund = ctx.message.refunded_payment;
    const order = await findOrderByPayload(refund.invoice_payload);
    if (!order) return;
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'REFUNDED' },
    });
    await ctx.reply(`Возврат по заказу №${order.reference} выполнен.`);
  });

  bot.catch((err) => {
    // grammY already logs; keep the process alive.
    console.error('Bot error:', err.message);
  });
}

registerHandlers();

export const botRoutes: FastifyPluginAsync = async (app) => {
  if (!bot) {
    app.log.warn(
      'TELEGRAM_BOT_TOKEN is not set: the /telegram/webhook route is disabled.',
    );
    return;
  }

  // `bot.init()` fetches getMe. A network failure must not block server start:
  // grammY retries transient errors, which would otherwise hang boot forever.
  // The webhook route works without botInfo, so this runs in the background and
  // never delays (or fails) plugin registration.
  const initTimeoutMs = 5_000;
  void (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), initTimeoutMs);
    try {
      // grammY types `signal` via its own `abort-controller` shim for old Node
      // versions. On Node >= 20 the native AbortSignal is structurally
      // identical, so the cast is safe and avoids pulling in the shim types.
      await bot.init(abort.signal as unknown as Parameters<typeof bot.init>[0]);
      app.log.info(
        { username: bot.botInfo.username },
        'Telegram bot initialised',
      );
    } catch (error) {
      app.log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        `Could not reach Telegram within ${initTimeoutMs}ms; the webhook route is still registered.`,
      );
    } finally {
      clearTimeout(timer);
    }
  })();

  const handle = webhookCallback(bot, 'fastify', {
    secretToken: config.telegram.webhookSecret || undefined,
  });

  app.post('/telegram/webhook', async (request, reply) => {
    const body = request.body as { update_id?: number } | undefined;
    const updateId = body?.update_id;

    // Deduplicate before handing the update to grammY.
    if (typeof updateId === 'number' && !(await claimUpdate(updateId))) {
      request.log.info({ updateId }, 'Duplicate Telegram update ignored');
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    return handle(request, reply);
  });
};
