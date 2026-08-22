import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import { disconnectDb, prisma } from './db.js';
import { AppError } from './errors.js';
import { authPlugin } from './plugins/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { orderRoutes } from './routes/orders.js';
import { botRoutes } from './routes/bot.js';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Never log credentials.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-telegram-init-data"]',
          'req.headers["x-telegram-bot-api-secret-token"]',
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

  await app.register(authPlugin);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      // Expected, client-facing failures: log at info level.
      request.log.info(
        { code: error.code, reason: error.message },
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
      devAuth: config.devAuthEnabled,
    };
  });

  await app.register(catalogRoutes, { prefix: '/api' });
  await app.register(orderRoutes, { prefix: '/api' });
  await app.register(botRoutes);

  return app;
}

async function main() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    try {
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
