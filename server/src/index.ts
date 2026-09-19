/**
 * Server entry point: boot, then shut down cleanly.
 *
 * Graceful shutdown matters more than usual here. Spec §19 wraps closure,
 * parts usage and reassignment in transactions; killing the process mid-flight
 * without draining connections risks leaving a transaction to abort on its own
 * and losing the surrounding audit write (spec §17).
 */
import type { Server } from 'node:http';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './db/connect.js';
import { createApp } from './app.js';

let server: Server | undefined;
let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  /* Stop accepting new requests, let in-flight ones finish, then release the
     database — in that order, so nothing is cut off mid-transaction. */
  const forceExit = setTimeout(() => {
    logger.error('shutdown took longer than 10s - forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      logger.info('http server closed');
    }
    await disconnectDatabase();
    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, timezone: config.APP_TIMEZONE },
      'cooler-crm api listening',
    );
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

/* An unhandled rejection or uncaught exception leaves the process in an
   unknown state; log it fully and restart rather than serving from it. */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
