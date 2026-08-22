import { Bot } from 'grammy';
import { config } from '../config.js';

/**
 * Single bot instance shared by the HTTP webhook handler and outgoing calls.
 * `null` when no token is configured, so the API can still boot for
 * catalog-only local development.
 */
export const bot = config.telegram.hasBotToken
  ? new Bot(config.telegram.botToken, {
      ...(config.telegram.apiRoot
        ? { client: { apiRoot: config.telegram.apiRoot } }
        : {}),
    })
  : null;

export function requireBot(): Bot {
  if (!bot) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }
  return bot;
}
