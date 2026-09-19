/**
 * Database connection lifecycle.
 *
 * Deliberately fails to boot when transactions are unavailable. Spec §19
 * requires transactions for complaint closure, parts issue/usage,
 * reassignment and reopen — without them, stock could be decremented while
 * the surrounding write fails, silently corrupting inventory. A loud boot
 * error is far better than discovering that in production.
 */
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

mongoose.set('strictQuery', true);

/* MongoDB enforces no schema of its own, so an unknown field is a bug in our
   code, not data we should quietly persist. */
mongoose.set('strict', 'throw');

/** Asks the server whether it is a replica set member, which transactions require. */
async function assertTransactionSupport(): Promise<string> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no database handle after connect');

  const hello = (await db.admin().command({ hello: 1 })) as { setName?: string };

  if (!hello.setName) {
    throw new Error(
      'MongoDB is running standalone, so multi-document transactions are ' +
      'unavailable - but spec section 19 requires them for closure, parts usage, ' +
      'reassignment and reopen.\n\n' +
      'Start the project-local replica set with:  npm run db:start\n' +
      'Check its health with:                     npm run db:status\n\n' +
      'See DECISIONS.md section 2.',
    );
  }

  return hello.setName;
}

export async function connectDatabase(): Promise<void> {
  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'mongodb connection error');
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('mongodb disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('mongodb reconnected');
  });

  await mongoose.connect(config.MONGO_URI, {
    serverSelectionTimeoutMS: 10_000,
    /* Reads and writes should observe the same data a transaction would, so
       history queries never show a half-applied state change. */
    readPreference: 'primary',
  });

  const setName = await assertTransactionSupport();

  logger.info(
    { database: mongoose.connection.name, replicaSet: setName },
    'mongodb connected - transactions available',
  );
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close(false);
  logger.info('mongodb connection closed');
}
