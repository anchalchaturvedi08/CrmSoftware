/**
 * Production secret validation (`productionSecretIssues`, `redactCredentials`
 * in `src/config/env.ts`).
 *
 * `loadConfig` only calls these when `NODE_ENV === 'production'`, and the
 * whole test suite boots with `NODE_ENV=test` (see `vitest.config.ts`) — so
 * the only way to exercise the rule at all is to call the exported, pure
 * function directly rather than booting a second process. It never touches
 * the database, so it lives with the other module tests rather than needing
 * its own fixture world.
 */
import { describe, expect, it } from 'vitest';
import { productionSecretIssues, redactCredentials } from '../../src/config/env.js';

/** A pair of secrets that pass every rule, to mutate one field at a time. */
function goodSecrets() {
  return {
    JWT_ACCESS_SECRET: 'kQ7z2pLxN9wVe4rT8yUiO1aS3dF6gH0j',
    JWT_REFRESH_SECRET: 'mB5cX8vZ1nQ4wE7rT2yU9iO6aS0dF3gH',
    HAPPY_CODE_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
  };
}

describe('productionSecretIssues', () => {
  it('accepts a set of distinct, high-entropy secrets', () => {
    expect(productionSecretIssues(goodSecrets())).toEqual([]);
  });

  it('flags the exact .env.example placeholders', () => {
    const issues = productionSecretIssues({
      ...goodSecrets(),
      JWT_ACCESS_SECRET: 'replace-me-with-48-random-bytes-base64url',
      JWT_REFRESH_SECRET: 'replace-me-with-a-different-48-random-bytes',
      HAPPY_CODE_KEY: 'replace-me-with-64-hex-characters',
    });

    expect(issues).toHaveLength(3);
    expect(issues.every((issue) => issue.includes('placeholder'))).toBe(true);
  });

  it('flags a "replace me" stand-in regardless of case or the optional hyphen', () => {
    const issues = productionSecretIssues({
      ...goodSecrets(),
      JWT_ACCESS_SECRET: 'REPLACEME-1234567890123456789012345',
      JWT_REFRESH_SECRET: 'REPLACE-ME-123456789012345678901234',
    });

    expect(issues).toEqual([
      'JWT_ACCESS_SECRET: still the placeholder from .env.example',
      'JWT_REFRESH_SECRET: still the placeholder from .env.example',
    ]);
  });

  it('flags a typed stand-in with too few distinct characters', () => {
    const issues = productionSecretIssues({
      ...goodSecrets(),
      JWT_ACCESS_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(issues).toEqual([
      'JWT_ACCESS_SECRET: uses too few different characters to be a random secret',
    ]);
  });

  it('flags a short pattern typed on repeat, even with enough distinct characters', () => {
    const issues = productionSecretIssues({
      ...goodSecrets(),
      HAPPY_CODE_KEY: '0123456789abcdef'.repeat(4),
    });

    expect(issues).toEqual([
      'HAPPY_CODE_KEY: is one short pattern repeated, not a random secret',
    ]);
  });

  it('flags the access and refresh secrets being the same value', () => {
    const shared = goodSecrets().JWT_ACCESS_SECRET;
    const issues = productionSecretIssues({
      ...goodSecrets(),
      JWT_ACCESS_SECRET: shared,
      JWT_REFRESH_SECRET: shared,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        'JWT_REFRESH_SECRET: must be different from JWT_ACCESS_SECRET',
      ]),
    );
  });

  it('never includes a secret value in its messages', () => {
    const secrets = {
      JWT_ACCESS_SECRET: 'replace-me-with-48-random-bytes-base64url',
      JWT_REFRESH_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      HAPPY_CODE_KEY: '0123456789abcdef'.repeat(4),
    };

    const issues = productionSecretIssues(secrets);
    const text = issues.join('\n');

    for (const value of Object.values(secrets)) {
      expect(text).not.toContain(value);
    }
  });

  it('reports every independently-broken secret, not just the first', () => {
    const issues = productionSecretIssues({
      JWT_ACCESS_SECRET: 'replace-me-with-48-random-bytes-base64url',
      JWT_REFRESH_SECRET: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      HAPPY_CODE_KEY: goodSecrets().HAPPY_CODE_KEY,
    });

    expect(issues).toHaveLength(2);
  });
});

describe('redactCredentials', () => {
  it('masks the user:password in a Mongo connection string', () => {
    const uri = 'mongodb://appuser:s3cr3t-pw@127.0.0.1:27018/cooler_crm?replicaSet=rs0';
    expect(redactCredentials(uri)).toBe(
      'mongodb://***:***@127.0.0.1:27018/cooler_crm?replicaSet=rs0',
    );
  });

  it('leaves a credential-free URI unchanged', () => {
    const uri = 'mongodb://127.0.0.1:27018/cooler_crm?replicaSet=rs0';
    expect(redactCredentials(uri)).toBe(uri);
  });

  it('leaves plain text with no connection string unchanged', () => {
    expect(redactCredentials('seed failed: server selection timed out')).toBe(
      'seed failed: server selection timed out',
    );
  });

  it('masks credentials that themselves contain an @ or a slash', () => {
    const uri = 'mongodb://user%40corp:pa%2Fss@127.0.0.1:27018/cooler_crm';
    expect(redactCredentials(uri)).toBe('mongodb://***:***@127.0.0.1:27018/cooler_crm');
  });
});
