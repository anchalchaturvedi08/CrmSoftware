/**
 * Response normalisation.
 *
 * ## The problem this solves
 *
 * `baseSchemaOptions.toJSON` maps `_id` to `id` and strips `__v`, so anything
 * serialised from a Mongoose *document* comes out clean. But `.lean()` skips
 * document hydration entirely for speed, and with it the transform — so list
 * endpoints were returning `_id` and leaking `__v` while create endpoints
 * returned `id`. Same resource, two shapes, depending on which query style the
 * handler happened to use.
 *
 * That is the kind of inconsistency a client discovers the hard way, and
 * fixing it per-query means every future `.lean()` is a chance to reintroduce
 * it. So it is fixed once, here: every JSON response is normalised on the way
 * out, whatever produced it.
 *
 * ## What it does
 *
 *  - `_id` becomes `id`, as a string
 *  - `__v` is dropped
 *  - ObjectIds become strings rather than `{ buffer: ... }`
 *  - Dates are left alone for JSON to render as ISO strings
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import mongoose from 'mongoose';

/** Values that must be converted rather than walked into. */
function isScalarLike(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof mongoose.Types.ObjectId ||
    Buffer.isBuffer(value)
  );
}

export function normalizeIds(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) return value.map(normalizeIds);

  if (typeof value === 'object') {
    const object = value as object;

    /* An ObjectId is an object, but walking into it produces internal buffer
       fields rather than the id anyone wants. Checked before `toJSON` below,
       since ObjectId, Date and Buffer all define one. */
    if (object instanceof mongoose.Types.ObjectId) return String(object);
    if (isScalarLike(object)) return object;

    /**
     * Let anything with its own serialisation run first.
     *
     * A Mongoose document is an object whose enumerable keys are internals
     * (`$__`, `_doc`, `$isNew`), not its fields. Walking it directly emits
     * that machinery instead of the record — and skips the schema's `toJSON`
     * transform, which is what applies `id` and strips `__v` in the first
     * place. Calling `toJSON` first and normalising the result gets both.
     */
    const maybeSerialisable = object as { toJSON?: () => unknown };
    if (typeof maybeSerialisable.toJSON === 'function') {
      return normalizeIds(maybeSerialisable.toJSON());
    }

    const out: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(object as Record<string, unknown>)) {
      /* The version key is an implementation detail of optimistic concurrency
         and has no business in a client payload. */
      if (key === '__v') continue;

      if (key === '_id') {
        out['id'] = nested === null || nested === undefined ? nested : String(nested);
        continue;
      }

      out[key] = normalizeIds(nested);
    }

    return out;
  }

  return value;
}

/**
 * Wraps `res.json` so every response is normalised.
 *
 * Mounted before the routers, so it covers handlers written later without
 * anyone having to remember it.
 */
export const normalizeResponse: RequestHandler = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  const original = res.json.bind(res);

  res.json = (body: unknown) => original(normalizeIds(body));

  next();
};
