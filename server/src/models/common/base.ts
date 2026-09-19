/**
 * Shared schema conventions and the model factory.
 *
 * Every model is created through `defineModel` so that three things are
 * guaranteed rather than remembered:
 *
 *  - the referential-integrity plugin is applied (MongoDB has no foreign
 *    keys, so a reference nobody validates is a reference nobody enforces);
 *  - references are registered for the offline integrity sweep;
 *  - `_id` is presented to clients as `id`, and `__v` never leaves the server.
 */
import mongoose, { type Model, type Schema } from 'mongoose';
import {
  referentialIntegrityPlugin,
  registerRefs,
} from './referentialIntegrity.js';

/**
 * Options applied to every schema.
 *
 * `timestamps` is not optional anywhere: section 17 requires an actor and a
 * time for every recorded action, and section 19 requires consistent
 * server-side timestamps. Mongoose writes these, so a client clock can never
 * influence them.
 */
/* Intentionally not annotated as `SchemaOptions`: the un-parameterized form
   does not unify with `SchemaOptions<FlatRecord<T>>` at each call site, so the
   inferred literal type is what actually works across every model. */
export const baseSchemaOptions = {
  timestamps: true,
  /* Reject unknown fields rather than storing them. MongoDB would happily
     accept a typo'd key forever; we would rather hear about it.
     `as const` keeps this the literal 'throw' rather than widening to string,
     which Mongoose's options type will not accept. */
  strict: 'throw' as const,
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform(_doc: unknown, ret: Record<string, unknown>) {
      ret['id'] = String(ret['_id']);
      delete ret['_id'];
      return ret;
    },
  },
  toObject: { virtuals: true, versionKey: false },
};

/**
 * Marker for master-data collections.
 *
 * Section 17 forbids hard deletion of operational records, so masters carry an
 * active flag and are never removed. `refActive: true` on a reference to one
 * of these prevents new work being attached to a deactivated record, while
 * leaving historical rows untouched.
 */
export const activeFlagField = {
  isActive: { type: Boolean, required: true, default: true, index: true },
} as const;

/** A trimmed, required string — the shape most master-data names want. */
export function requiredName(maxlength = 160) {
  return { type: String, required: true, trim: true, maxlength } as const;
}

/** A trimmed, optional string. */
export function optionalText(maxlength = 2000) {
  return { type: String, required: false, trim: true, maxlength } as const;
}

/**
 * Indian mobile number, stored as ten digits with no punctuation or country
 * code. Normalizing on the way in is what makes section 13's repeat-complaint
 * lookup by mobile reliable — `+91 98765 43210` and `9876543210` have to be
 * the same customer, or the service history splits in two.
 */
export const mobileField = {
  type: String,
  required: true,
  trim: true,
  /* Indian mobile numbers begin 6-9. */
  match: [/^[6-9]\d{9}$/, 'Mobile number must be 10 digits and start with 6-9'],
} as const;

/** Strips punctuation, spaces and a leading +91 or 0 from a mobile number. */
export function normalizeMobile(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export const pincodeField = {
  type: String,
  required: true,
  trim: true,
  match: [/^\d{6}$/, 'Pincode must be 6 digits'],
} as const;

/**
 * Creates and registers a model with the shared conventions applied.
 *
 * Reuses an already-compiled model when one exists, so a watch-mode reload or
 * a test re-import does not throw `OverwriteModelError`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
   The `any` positions mirror Mongoose's own `model<T>()` overload exactly.
   Narrowing them to `Schema<TDoc>` stops the schema produced by
   `new Schema<TDoc>(...)` from unifying, because its Model generic is
   inferred separately. This is the signature Mongoose itself publishes. */
export function defineModel<TDoc>(
  name: string,
  schema: Schema<TDoc, any, any, any, any, any>,
): Model<TDoc> {
  const existing = mongoose.models[name] as Model<TDoc> | undefined;
  if (existing) return existing;

  schema.plugin(referentialIntegrityPlugin);
  registerRefs(name, schema as unknown as Schema);

  return mongoose.model<TDoc>(name, schema);
}
