/**
 * Atomic sequence counters.
 *
 * Complaint numbers look like `CMP-2026-000001` (spec section 6.2) and must be
 * unique. The obvious implementation — count the year's complaints and add one
 * — is a race: two simultaneous creations read the same count and mint the
 * same number. Under a unique index one of them then fails; without one, two
 * complaints share an identifier.
 *
 * `findOneAndUpdate` with `$inc` and `upsert` is a single atomic operation on
 * one document, so concurrent callers are serialized by the server and each
 * receives a distinct value.
 */
import { Schema, type ClientSession } from 'mongoose';
import { baseSchemaOptions, defineModel } from './common/base.js';

export interface CounterDoc {
  /** Scope key, e.g. `complaint:2026`. */
  _id: string;
  seq: number;
  createdAt: Date;
  updatedAt: Date;
}

const counterSchema = new Schema<CounterDoc>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  baseSchemaOptions,
);

export const Counter = defineModel<CounterDoc>('Counter', counterSchema);

/**
 * Returns the next value for a scope, creating the counter on first use.
 *
 * Pass the ambient session so the number is minted inside the same
 * transaction as the document that uses it. If the surrounding transaction
 * aborts, the increment rolls back with it and the number is not burned.
 */
export async function nextSequence(
  scope: string,
  session: ClientSession | null = null,
): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { _id: scope },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  )
    .lean()
    .exec();

  if (!doc) {
    /* upsert + new should make this unreachable; failing loudly beats
       returning a duplicate number. */
    throw new Error(`counter '${scope}' could not be incremented`);
  }

  return doc.seq;
}
