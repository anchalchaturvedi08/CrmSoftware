/**
 * Password hashing tests.
 *
 * scrypt replaced Argon2 for environment reasons (DECISIONS.md section 7.1),
 * which makes it worth proving the replacement actually behaves: a salt per
 * hash, a self-describing format that supports raising the cost later, and a
 * verify that does not accept near-misses.
 */
import { describe, expect, it } from 'vitest';
import {
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../src/core/password.js';

describe('hashPassword / verifyPassword', () => {
  it('verifies the correct password', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-batterz', hash)).toBe(false);
  });

  it('rejects a password that is a prefix of the real one', async () => {
    /* A byte-by-byte comparison with an early return could accept this. */
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct', hash)).toBe(false);
  });

  it('salts each hash, so identical passwords hash differently', async () => {
    const [first, second] = await Promise.all([
      hashPassword('same-password-here'),
      hashPassword('same-password-here'),
    ]);

    /* Without a per-hash salt, two users with the same password would share a
       hash — and cracking one would crack both. */
    expect(first).not.toBe(second);
    expect(await verifyPassword('same-password-here', first)).toBe(true);
    expect(await verifyPassword('same-password-here', second)).toBe(true);
  });

  it('stores its parameters so they can be raised later', async () => {
    const hash = await hashPassword('correct-horse-battery');
    const [algorithm, N, r, p, keylen, salt, digest] = hash.split('$');

    expect(algorithm).toBe('scrypt');
    expect(Number(N)).toBe(32_768);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(Number(keylen)).toBe(64);
    expect(salt).toBeTruthy();
    expect(digest).toBeTruthy();
  });

  it('treats a unicode password consistently regardless of composition', async () => {
    /* Same characters, different normalization forms. A password typed on one
       keyboard must verify on another. */
    const composed = 'René-passphrase';
    const decomposed = 'René-passphrase';

    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$1$8$1$64$aa$bb']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with current parameters', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(needsRehash(hash)).toBe(false);
  });

  it('is true for a hash made with weaker parameters', () => {
    /* N=1024 is far below current. On next successful login this user's hash
       should be re-derived at the stronger setting. */
    const weak = 'scrypt$1024$8$1$64$c2FsdA$aGFzaA';
    expect(needsRehash(weak)).toBe(true);
  });

  it('is true for anything unparseable, so it gets replaced', () => {
    expect(needsRehash('garbage')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});

describe('dummyVerify', () => {
  it('costs roughly what a real verification costs', async () => {
    /* Guards the no-enumeration property: if a missing account returned much
       faster than a wrong password, response time alone would reveal which
       mobile numbers are registered. Bounds are loose on purpose — this is a
       shared CI machine, not a benchmark rig. */
    const hash = await hashPassword('correct-horse-battery');

    const realStart = performance.now();
    await verifyPassword('wrong-password-here', hash);
    const realMs = performance.now() - realStart;

    const dummyStart = performance.now();
    await dummyVerify();
    const dummyMs = performance.now() - dummyStart;

    const ratio = dummyMs / realMs;
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(4);
  });
});
