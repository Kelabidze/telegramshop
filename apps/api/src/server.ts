import Fastify from 'fastify';
import { mkdir } from 'node:fs/promises';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { MEDIA_MAX_BYTES } from '@shop/shared';
import { UPLOADS_URL_PREFIX } from './services/media.js';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import { disconnectDb, prisma } from './db.js';
import { AppError } from './errors.js';
import { authPlugin } from './plugins/auth.js';
import { adminRoutes } from './routes/admin.js';
import { catalogRoutes } from './routes/catalog.js';
import { orderRoutes } from './routes/orders.js';
import { cryptoPaymentRoutes } from './routes/crypto-payments.js';
import { casheraRoutes, casheraWebhookRoutes } from './routes/cashera.js';
import { botRoutes } from './routes/bot.js';
import { userRoutes } from './routes/users.js';
import { isDerivationAvailable } from './crypto/addresses.js';
import { getMonitorState, startMonitor, stopMonitor } from './crypto/monitor.js';
import { getRpcClient } from './crypto/rpc.js';

/**
 * Crypto diagnostics for `/health`.
 *
 * Enough to answer "is the watcher alive and is it keeping up" without a metrics
 * stack: the scan cursor, RPC error counts, and how many payments are open.
 * `degraded` is a real signal rather than a constant — a watcher whose every RPC
 * call fails while `/health` reports "ok" is worse than no health check at all.
 *
 * No secrets: no xpub, no endpoint URLs (which can carry API keys in a path),
 * no addresses.
 */
async function cryptoHealth() {
  if (!config.crypto.enabled) {
    return { enabled: false as const, derivationReady: isDerivationAvailable() };
  }

  const monitor = getMonitorState();
  const rpc = getRpcClient().getStats();

  const [openIntents, lastCursor] = await Promise.all([
    prisma.cryptoPaymentIntent.count({
      where: { status: { in: ['AWAITING', 'CONFIRMING', 'UNDERPAID'] } },
    }),
    prisma.depositWallet.aggregate({ _max: { lastScannedBlock: true } }),
  ]);

  return {
    enabled: true as const,
    derivationReady: isDerivationAvailable(),
    monitorRunning: monitor.running,
    lastPassAt: monitor.lastPassAt,
    lastSuccessAt: monitor.lastSuccessAt,
    consecutiveFailures: monitor.consecutiveFailures,
    skippedTicks: monitor.skippedTicks,
    lastScannedBlock: lastCursor._max.lastScannedBlock?.toString() ?? null,
    headBlock: monitor.lastResult?.headBlock ?? null,
    finalizedBlock: monitor.lastResult?.finalizedBlock ?? null,
    usedFallbackFinality: monitor.lastResult?.usedFallbackFinality ?? false,
    openIntents,
    rpcCalls: rpc.calls,
    rpcFailures: rpc.failures,
    rpcFallbackUses: rpc.fallbackUses,
    // Three passes in a row is a pattern, not a blip.
    degraded: monitor.consecutiveFailures >= 3,
  };
}

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Never log credentials. The crypto entries are belt and braces: no code
      // path logs derivation material today, and this makes sure a future one
      // that carries it in a request or an error object still cannot.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-telegram-init-data"]',
          'req.headers["x-telegram-bot-api-secret-token"]',
          // Cashera authenticates its webhooks with these two headers. The secret
          // in particular must never reach a log line.
          'req.headers["x-api-key"]',
          'req.headers["x-secret"]',
          'xpub',
          'mnemonic',
          'privateKey',
          'seedPhrase',
          '*.xpub',
          '*.mnemonic',
          '*.privateKey',
        ],
        censor: '[redacted]',
      },
    },
    // Trust the tunnel/proxy so rate limiting sees real client IPs.
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  await app.register(cors, {
    origin(origin, cb) {
      // Same-origin/curl requests have no Origin header.
      if (!origin) return cb(null, true);
      if (config.corsOrigins.length === 0) {
        // Default posture: allow only Telegram-hosted origins plus localhost.
        const ok =
          /^https:\/\/([a-z0-9-]+\.)*telegram\.org$/.test(origin) ||
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        return cb(null, ok);
      }
      return cb(null, config.corsOrigins.includes(origin));
    },
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // The webhook is authenticated by a secret token and must not be throttled.
    allowList: (request) => request.url.startsWith('/telegram/webhook'),
  });

  // File uploads. The limit is the largest single accepted file plus a small
  // margin for the multipart envelope; `files: 1` means one upload per request,
  // so a single call cannot fill the quota in one go.
  await app.register(multipart, {
    limits: {
      fileSize: MEDIA_MAX_BYTES,
      files: 1,
      fields: 4,
    },
  });

  /**
   * Uploaded media.
   *
   * In production Caddy serves `/uploads/*` straight from disk and this route is
   * never reached. It exists so development works identically without Caddy —
   * the same `/uploads/...` URL resolves in both, and no code needs to know
   * which environment it is in.
   *
   * Wrapped in try/catch because this must never prevent the server from
   * starting. It already did once: with `UPLOADS_DIR` absent the path resolved
   * inside the release directory, which systemd mounts read-only, `mkdir` threw
   * EROFS, and the whole process died on boot — the shop was down because it
   * could not create a folder for banner images. Serving pictures is strictly
   * less important than serving the shop.
   */
  let uploadsReady = false;
  try {
    await mkdir(config.uploadsDir, { recursive: true });
    await app.register(fastifyStatic, {
      root: config.uploadsDir,
      prefix: `${UPLOADS_URL_PREFIX}/`,
      index: false,
      // Uploads are user-supplied bytes; never let the browser re-sniff the type.
      setHeaders(reply) {
        reply.setHeader('X-Content-Type-Options', 'nosniff');
        reply.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    uploadsReady = true;
  } catch (error) {
    // Loud, because uploads will fail for the same reason and the operator needs
    // to know why: almost always a missing or unwritable UPLOADS_DIR.
    app.log.error(
      {
        err: error instanceof Error ? error.message : String(error),
        uploadsDir: config.uploadsDir,
      },
      'Could not prepare the uploads directory; media uploads and serving are ' +
        'disabled. Set UPLOADS_DIR to a writable path outside the release.',
    );
  }

  await app.register(authPlugin);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      // Expected, client-facing failures: log at info level.
      //
      /**
       * A CasheraError also carries the gateway's real HTTP status and its short
       * reason, both of which the buyer-safe message deliberately hides. Logging
       * them is what lets an operator tell "the key was rejected (401)" from "the
       * method is not enabled for this merchant (422)", and within a 401, an empty
       * key from an unknown one — each needs a different fix and all four look
       * identical from the storefront.
       *
       * `gatewayMessage` is Cashera's own public error text, never our credential.
       */
      const gatewayStatus = (error as { httpStatus?: number | null }).httpStatus;
      const gatewayMessage = (error as { gatewayMessage?: string | null }).gatewayMessage;
      request.log.info(
        {
          code: error.code,
          reason: error.message,
          ...(gatewayStatus ? { gatewayStatus } : {}),
          ...(gatewayMessage ? { gatewayMessage } : {}),
        },
        'Request rejected',
      );
      return reply.code(error.statusCode).send(error.toPayload());
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: error.issues,
        },
      });
    }

    const fastifyError = error as {
      statusCode?: number;
      message?: string;
      validation?: unknown;
    };

    if (fastifyError.statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests.' },
      });
    }

    if (fastifyError.validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: fastifyError.message ?? 'Request validation failed.',
          details: fastifyError.validation,
        },
      });
    }

    // Unexpected: log the full error, return an opaque message.
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}.` } });
  });

  app.get('/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return {
      ok: true,
      env: config.env,
      payments: config.paymentProvider,
      botConfigured: config.telegram.hasBotToken,
      // Whether membership checks run at all. No secrets: the id itself is not
      // returned — knowing it is configured is enough to tell "feature off" from
      // "Telegram refused" when diagnosing a silent /api/me.
      clubChannelConfigured: config.clubChannel.enabled,
      // Reported so a broken uploads directory is visible here instead of only
      // as a failed upload later. `ok` stays true: the shop works without it.
      uploadsReady,
      devAuth: config.devAuthEnabled,
      crypto: await cryptoHealth(),
      /**
       * Card payments. Whether the rail is on, and the non-secret parts of how it
       * is configured — enough to tell "switched off" from "misconfigured" without
       * disclosing the key, the secret, or the base URL.
       */
      cashera: {
        enabled: config.cashera.enabled,
        paymentMethod: config.cashera.enabled
          ? config.cashera.paymentMethod
          : null,
        /**
         * The method the crypto rail asks for. `null` here means the common payment
         * form — Cashera presents every enabled method and the buyer chooses.
         * Non-secret, and the way to confirm after a deploy that the crypto rail is
         * wired to `crypto` rather than falling back to the card method.
         */
        cryptoPaymentMethod: config.cashera.enabled
          ? config.cashera.cryptoPaymentMethod
          : null,
        // A gateway cannot call back without this, so its absence is the most
        // likely reason a payment never settles.
        callbackConfigured: Boolean(config.publicApiUrl || config.publicAppUrl),
      },
    };
  });

  await app.register(catalogRoutes, { prefix: '/api' });
  await app.register(orderRoutes, { prefix: '/api' });
  await app.register(cryptoPaymentRoutes, { prefix: '/api' });
  await app.register(casheraRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
  // Management endpoints. Same `/api` prefix as the public ones: they are told
  // apart by their pre-handlers, not by the URL, so no path can be mistaken for
  // public just because it lacks an `/admin` segment.
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(botRoutes);
  // No `/api` prefix: the gateway's callback and the hosted-page return URLs are
  // not part of the Mini App contract and authenticate differently.
  await app.register(casheraWebhookRoutes);

  return app;
}

async function main() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    try {
      // Before closing the server: a pass mid-flight would otherwise keep
      // querying a database that is about to disconnect.
      stopMonitor();
      await app.close();
      await disconnectDb();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: config.host });
    if (config.devAuthEnabled) {
      app.log.warn(
        'ALLOW_DEV_AUTH is enabled: requests may authenticate without a Telegram signature. Development only.',
      );
    }
    // Membership is the silent half of the club rate: without this line a
    // missing CLUB_CHANNEL_ID looks exactly like a working feature that just
    // never finds any members. Log once at boot so the journal answers the
    // question before the first /api/me does.
    if (config.clubChannel.enabled) {
      app.log.info(
        {
          channelId: config.clubChannel.id,
          ttlSeconds: config.clubChannel.membershipTtlMs / 1000,
        },
        'Club channel membership checks enabled',
      );
    } else {
      app.log.warn(
        'Club channel is not configured (CLUB_CHANNEL_ID empty); everyone pays the standard price.',
      );
    }

    /**
     * The chain watcher runs inside this process.
     *
     * One systemd unit means one watcher, so there is no risk of two instances
     * scanning the same ranges — the reason a separate worker is not worth its
     * own unit yet. It is started only after `listen` succeeds: a process that
     * cannot serve should not be taking payments either.
     */
    startMonitor(app.log);
  } catch (error) {
    app.log.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

// Only auto-start when executed directly, so tests can import buildServer.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main();
}
