/**
 * Test harness: one connection per file, a clean database per test.
 *
 * `syncIndexes` runs once up front rather than relying on Mongoose's
 * background index builds. Unique-constraint tests are otherwise flaky — the
 * insert can land before the index exists, and the test passes for the wrong
 * reason.
 */
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll } from 'vitest';
import '../src/models/index.js';
import { config } from '../src/config/env.js';

beforeAll(async () => {
  /* A misconfigured URI here would point the wipe below at real data. */
  if (!/cooler_crm_test/.test(config.MONGO_URI)) {
    throw new Error(
      `refusing to run tests against '${config.MONGO_URI}' — ` +
      'the database name must contain cooler_crm_test',
    );
  }

  await mongoose.connect(config.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });

  const hello = (await mongoose.connection.db!.admin().command({ hello: 1 })) as {
    setName?: string;
  };
  if (!hello.setName) {
    throw new Error(
      'test database is not a replica set, so transactions cannot be tested — ' +
      'run `npm run db:start`',
    );
  }

  /* Build every declared index before any test asserts on one. */
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.syncIndexes()),
  );
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({})),
  );
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
});
