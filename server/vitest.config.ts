import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Uploads go to a disposable directory, never `server/storage/`.
 *
 * This has to be set here rather than in a test file: `config/env.ts` parses
 * the environment when it is first imported, which happens before any test
 * body runs — so a `process.env` assignment inside a spec arrives too late and
 * the suite quietly writes real files into the project.
 */
const TEST_STORAGE = path.join(
  os.tmpdir(),
  `cooler-crm-test-storage${process.env['TEST_DB_NAME']?.replace('cooler_crm_test', '') ?? ''}`,
);

/**
 * The test database: `cooler_crm_test`, or `cooler_crm_test_<suffix>` from
 * TEST_DB_NAME so two runs at once do not wipe each other's collections.
 * Never the development database — `tests/setup.ts` checks the name again.
 */
function testDatabase(): string {
  const name = process.env['TEST_DB_NAME'] ?? 'cooler_crm_test';
  if (!/^cooler_crm_test(_[a-z0-9]+)?$/.test(name)) {
    throw new Error(`TEST_DB_NAME must be cooler_crm_test or cooler_crm_test_<suffix>, got "${name}"`);
  }
  return name;
}

export default defineConfig({
  test: {
    /**
     * Tests run against a **separate database** on the same replica set.
     *
     * `dotenv` does not override variables already present in `process.env`,
     * so setting MONGO_URI here wins over `server/.env` — the suite cannot
     * reach the development database, and `clearCollections` cannot wipe real
     * work. The replicaSet parameter is required: the transaction tests are
     * the point of the exercise.
     */
    env: {
      NODE_ENV: 'test',
      /* See testDatabase() for TEST_DB_NAME. */
      MONGO_URI: `mongodb://127.0.0.1:27018/${testDatabase()}?replicaSet=rs0`,
      LOG_LEVEL: 'silent',
      /**
       * The per-IP login ceiling is raised out of the way for most tests.
       *
       * Every request in a file comes from the same address through the same
       * in-memory store, so the production default of 20 is reached partway
       * through the auth suite — and then later tests fail on a 429 that has
       * nothing to do with what they are asserting. The limiter itself is
       * covered by `authRateLimit.test.ts`, which lowers the ceiling
       * deliberately. The per-account lockout, which is the control spec
       * section 19 actually asks for, is tested at its real setting.
       */
      LOGIN_RATE_MAX_REQUESTS: '100000',
      STORAGE_LOCAL_PATH: TEST_STORAGE,
    },
    globals: false,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    /* Model tests share one database, so parallel files would race on the
       collection wipe between tests. */
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
