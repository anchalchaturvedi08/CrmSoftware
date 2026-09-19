/**
 * Happy Code tests.
 *
 * The Happy Code is the last gate before closure (spec section 22), so the
 * properties worth proving are: it round-trips, tampering is detected, wrong
 * guesses are capped, and the generator is not biased.
 */
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/env.js';
import {
  attemptsRemaining,
  decryptHappyCode,
  encryptHappyCode,
  generateHappyCode,
  issueHappyCode,
  regenerateHappyCode,
  verifyHappyCode,
} from '../../src/core/happyCode.js';
import { AppError } from '../../src/http/errors.js';

describe('generateHappyCode', () => {
  it('produces exactly six digits', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateHappyCode()).toMatch(/^\d{6}$/);
    }
  });

  it('keeps leading zeros rather than shortening the code', () => {
    /* `000042` must stay six characters. A code rendered as `42` would not
       match what the customer was sent. */
    const codes = Array.from({ length: 3000 }, () => generateHappyCode());
    expect(codes.every((c) => c.length === 6)).toBe(true);
  });

  it('is not obviously biased across the range', () => {
    /* Guards the choice of randomInt over randomBytes % 10^6, which would
       skew toward lower values and make some codes likelier to guess. */
    const samples = 6000;
    const buckets = new Array(10).fill(0) as number[];

    for (let i = 0; i < samples; i += 1) {
      const code = generateHappyCode();
      buckets[Number(code[0])] += 1;
    }

    /* Each leading digit should land near samples/10. Bounds are wide enough
       that a fair generator will not trip them. */
    const expected = samples / 10;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(expected * 0.7);
      expect(count).toBeLessThan(expected * 1.3);
    }
  });
});

describe('encryption round trip', () => {
  it('decrypts back to the original code', () => {
    const code = '042913';
    expect(decryptHappyCode(encryptHappyCode(code))).toBe(code);
  });

  it('uses a fresh IV, so the same code encrypts differently each time', () => {
    /* A reused IV in GCM is catastrophic — it leaks the keystream. */
    const first = encryptHappyCode('123456');
    const second = encryptHappyCode('123456');

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decryptHappyCode(first)).toBe('123456');
    expect(decryptHappyCode(second)).toBe('123456');
  });

  it('detects a tampered ciphertext instead of returning a wrong code', () => {
    /* This is why GCM was chosen over a plain cipher: authentication means a
       corrupted record fails loudly rather than yielding a plausible code
       that would then be compared against the customer's. */
    const secret = encryptHappyCode('123456');
    const tampered = {
      ...secret,
      ciphertext: Buffer.from('999999', 'utf8').toString('base64'),
    };

    expect(() => decryptHappyCode(tampered)).toThrow(AppError);
  });

  it('detects a tampered auth tag', () => {
    const secret = encryptHappyCode('123456');
    const tampered = { ...secret, authTag: Buffer.alloc(16).toString('base64') };

    expect(() => decryptHappyCode(tampered)).toThrow(AppError);
  });
});

describe('verifyHappyCode', () => {
  it('accepts the correct code and stamps the time', () => {
    const issued = issueHappyCode();
    const result = verifyHappyCode(issued.code, issued.secret, issued.meta);

    expect(result.ok).toBe(true);
    expect(result.meta.verifiedAt).toBeInstanceOf(Date);
  });

  it('rejects a wrong code and counts the attempt', () => {
    const issued = issueHappyCode();
    const wrong = issued.code === '000000' ? '111111' : '000000';

    const result = verifyHappyCode(wrong, issued.secret, issued.meta);

    expect(result.ok).toBe(false);
    expect(result.meta.attempts).toBe(1);
    expect(result.meta.verifiedAt).toBeUndefined();
  });

  it('tolerates surrounding whitespace in what Admin typed', () => {
    const issued = issueHappyCode();
    expect(verifyHappyCode(`  ${issued.code} `, issued.secret, issued.meta).ok).toBe(
      true,
    );
  });

  it('rejects a code of the wrong length without throwing', () => {
    /* timingSafeEqual throws on length mismatch, so length is checked first.
       Code length is fixed and public, so this leaks nothing. */
    const issued = issueHappyCode();
    expect(verifyHappyCode('123', issued.secret, issued.meta).ok).toBe(false);
    expect(verifyHappyCode('1234567890', issued.secret, issued.meta).ok).toBe(false);
  });

  it('locks the code once attempts are exhausted', () => {
    const issued = issueHappyCode();
    const wrong = issued.code === '000000' ? '111111' : '000000';

    let meta = issued.meta;
    for (let i = 0; i < config.HAPPY_CODE_MAX_ATTEMPTS; i += 1) {
      meta = verifyHappyCode(wrong, issued.secret, meta).meta;
    }

    expect(meta.lockedAt).toBeInstanceOf(Date);
    expect(attemptsRemaining(meta)).toBe(0);
  });

  it('refuses even the correct code once locked', () => {
    /* A million possibilities is walkable without a cap, so the lock must
       hold regardless of what is offered next. */
    const issued = issueHappyCode();
    const locked = { ...issued.meta, lockedAt: new Date() };

    expect(() => verifyHappyCode(issued.code, issued.secret, locked)).toThrow(
      /Too many incorrect attempts/,
    );
  });

  it('treats re-verifying an already verified code as a no-op', () => {
    const issued = issueHappyCode();
    const verifiedAt = new Date('2026-01-01T00:00:00Z');
    const already = { ...issued.meta, verifiedAt };

    const result = verifyHappyCode('000000', issued.secret, already);

    /* A wrong code offered after verification must not spend an attempt or
       undo the verification. */
    expect(result.ok).toBe(true);
    expect(result.meta.verifiedAt).toBe(verifiedAt);
    expect(result.meta.attempts).toBe(0);
  });

  it('counts down the attempts it reports as remaining', () => {
    const issued = issueHappyCode();
    const wrong = issued.code === '000000' ? '111111' : '000000';

    expect(attemptsRemaining(issued.meta)).toBe(config.HAPPY_CODE_MAX_ATTEMPTS);
    const after = verifyHappyCode(wrong, issued.secret, issued.meta).meta;
    expect(attemptsRemaining(after)).toBe(config.HAPPY_CODE_MAX_ATTEMPTS - 1);
  });
});

describe('regenerateHappyCode', () => {
  it('issues a new code, clears attempts and counts the regeneration', () => {
    const issued = issueHappyCode();
    const exhausted = { ...issued.meta, attempts: 4, lockedAt: new Date() };

    const fresh = regenerateHappyCode(exhausted);

    expect(fresh.meta.attempts).toBe(0);
    expect(fresh.meta.lockedAt).toBeUndefined();
    expect(fresh.meta.regenerationCount).toBe(1);
    expect(decryptHappyCode(fresh.secret)).toBe(fresh.code);
  });
});
