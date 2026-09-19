/**
 * Tests for complaint-number sequencing (spec section 6.2).
 *
 * The naive implementation — count this year's complaints, add one — is a
 * race. Two simultaneous creations read the same count and mint the same
 * number. These tests exist to prove the atomic `$inc` does not have that
 * flaw, because a duplicate complaint number is the kind of bug that is
 * invisible in testing and unfixable in production.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { Counter, nextSequence } from '../../src/models/index.js';

describe('nextSequence', () => {
  it('starts at 1 and increments', async () => {
    expect(await nextSequence('complaint:2026')).toBe(1);
    expect(await nextSequence('complaint:2026')).toBe(2);
    expect(await nextSequence('complaint:2026')).toBe(3);
  });

  it('keeps separate scopes independent', async () => {
    /* Numbering restarts each year: CMP-2026-000001 then CMP-2027-000001. */
    expect(await nextSequence('complaint:2026')).toBe(1);
    expect(await nextSequence('complaint:2027')).toBe(1);
    expect(await nextSequence('complaint:2026')).toBe(2);
  });

  it('never issues the same number twice under concurrency', async () => {
    /* The actual race. Fifty simultaneous callers must receive fifty distinct
       values — anything less means two complaints could share an identifier. */
    const concurrent = 50;
    const results = await Promise.all(
      Array.from({ length: concurrent }, () => nextSequence('complaint:2026')),
    );

    expect(new Set(results).size).toBe(concurrent);
    expect(Math.min(...results)).toBe(1);
    expect(Math.max(...results)).toBe(concurrent);
  });

  it('rolls the increment back when its transaction aborts', async () => {
    /* A burned number would leave a permanent gap in the sequence. Minting
       inside the caller's transaction means an aborted complaint creation
       releases the number too. */
    await nextSequence('complaint:2026');

    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => {
        const taken = await nextSequence('complaint:2026', session);
        expect(taken).toBe(2);
        throw new Error('simulated failure after minting the number');
      }),
    ).rejects.toThrow(/simulated failure/);
    await session.endSession();

    const counter = await Counter.findById('complaint:2026').lean().exec();
    expect(counter?.seq).toBe(1);

    /* And the released number is handed out again rather than skipped. */
    expect(await nextSequence('complaint:2026')).toBe(2);
  });
});
