/**
 * Registers or removes the Telegram webhook.
 *
 *   npm run bot:set-webhook                                    # dev, through tsx
 *   npm run bot:delete-webhook
 *   node --env-file=<api.env> dist/cli/webhook.js set          # production
 *
 * PUBLIC_API_URL must be the public HTTPS origin of the API (e.g. a cloudflared
 * tunnel URL). Telegram only accepts HTTPS webhooks.
 *
 * Lives under src/ so `tsc` emits a plain .js entry point: tsx is a
 * devDependency and never reaches the server.
 */
import { config } from '../config.js';
import { requireBot } from '../telegram/bot.js';

const action = process.argv[2];

async function main() {
  const bot = requireBot();
  await bot.init();

  if (action === 'delete') {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    console.log(`Webhook removed for @${bot.botInfo.username}.`);
    return;
  }

  if (action !== 'set') {
    console.error('Usage: webhook.js <set|delete>');
    process.exit(1);
  }

  if (!config.publicApiUrl) {
    console.error(
      'PUBLIC_API_URL is empty. Start a tunnel and set it, e.g.\n' +
        '  cloudflared tunnel --url http://localhost:8080',
    );
    process.exit(1);
  }
  if (!config.publicApiUrl.startsWith('https://')) {
    console.error(
      `PUBLIC_API_URL must start with https:// (got "${config.publicApiUrl}"). ` +
        'Telegram rejects plain HTTP webhooks.',
    );
    process.exit(1);
  }
  if (!config.telegram.webhookSecret) {
    console.error(
      'TELEGRAM_WEBHOOK_SECRET is empty. Generate one:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
    process.exit(1);
  }

  const url = `${config.publicApiUrl}/telegram/webhook`;

  await bot.api.setWebhook(url, {
    secret_token: config.telegram.webhookSecret,
    // Only the updates this shop needs.
    allowed_updates: ['message', 'pre_checkout_query', 'callback_query'],
    drop_pending_updates: true,
  });

  const info = await bot.api.getWebhookInfo();
  console.log(`Webhook set for @${bot.botInfo.username}:`);
  console.log(`  url:              ${info.url}`);
  console.log(`  pending updates:  ${info.pending_update_count}`);
  if (info.last_error_message) {
    console.log(`  last error:       ${info.last_error_message}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
