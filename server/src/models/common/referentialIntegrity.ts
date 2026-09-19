/**
 * Referential integrity for MongoDB.
 *
 * This file exists because of a deliberate trade-off. The spec (section 18)
 * calls for a relational database with foreign keys; MERN was chosen instead,
 * and MongoDB enforces no referential integrity whatsoever. Nothing stops a
 * complaint from pointing at a service center that was never created, or at
 * one that has since been deactivated.
 *
 * So the application becomes the constraint. This plugin reads the `ref`
 * declarations already present on each schema and verifies, before every
 * write, that the targets actually exist.
 *
 * Two details matter more than the rest:
 *
 *  1. **Session awareness.** The existence check must run inside the caller's
 *     transaction. A check that queries outside the session cannot see
 *     documents the transaction has created but not yet committed, so a
 *     perfectly valid write would be rejected. Every query below therefore
 *     inherits the active session.
 *
 *  2. **Only what changed.** Re-validating every reference on every save would
 *     turn one write into a dozen reads. Only modified paths are checked.
 *
 * Marking a reference with `refActive: true` additionally requires the target
 * to be active, which is how section 8 ("complaints may not be assigned to a
 * deactivated service center") and section 9 ("jobs may not be assigned to a
 * deactivated technician") are enforced. Note it guards the *write*, not
 * existing history: deactivating a center never invalidates closed
 * complaints, per section 22.
 */
import mongoose, {
  type CallbackWithoutResultAndOptionalError,
  type ClientSession,
  type Schema,
} from 'mongoose';

/** A single reference declared on a schema. */
export interface RefSpec {
  /** Dotted schema path, e.g. `serviceCenterId`. */
  path: string;
  /** Target model name, from the path's `ref` option. */
  modelName: string;
  /** Whether the target must also be active at write time. */
  requireActive: boolean;
  /** True when the path holds an array of references. */
  isArray: boolean;
}

/**
 * Every reference in the system, by model name. Populated as schemas are
 * registered, and used by `npm run check:integrity` to sweep for orphans that
 * predate a validation rule or were introduced outside the application.
 */
export const refRegistry = new Map<string, RefSpec[]>();

interface RefPathOptions {
  ref?: unknown;
  refActive?: unknown;
}

/** Reads the `ref` declarations off a schema, including inside arrays. */
function collectRefs(schema: Schema): RefSpec[] {
  const refs: RefSpec[] = [];

  schema.eachPath((path, schemaType) => {
    /* An array of refs carries its `ref` on the caster, not the array path. */
    const caster = (schemaType as { caster?: { options?: RefPathOptions } }).caster;
    const isArray = Boolean(caster?.options?.ref);
    const options = (isArray ? caster?.options : schemaType.options) as
      | RefPathOptions
      | undefined;

    if (typeof options?.ref !== 'string') return;

    refs.push({
      path,
      modelName: options.ref,
      requireActive: options.refActive === true,
      isArray,
    });
  });

  return refs;
}

/** Normalizes a path value to the list of ids that need checking. */
function idsToCheck(value: unknown, isArray: boolean): mongoose.Types.ObjectId[] {
  if (value === null || value === undefined) return [];

  const raw = isArray ? (Array.isArray(value) ? value : []) : [value];
  return raw.filter(
    (id): id is mongoose.Types.ObjectId => id instanceof mongoose.Types.ObjectId,
  );
}

/**
 * Confirms every id exists in the target collection, and is active when the
 * reference demands it. Returns a human-readable reason, or null when fine.
 */
async function verifyTargets(
  spec: RefSpec,
  ids: mongoose.Types.ObjectId[],
  session: ClientSession | null,
): Promise<string | null> {
  if (ids.length === 0) return null;

  const model = mongoose.models[spec.modelName];
  if (!model) {
    /* A typo in a `ref` would otherwise disable the check silently, which is
       worse than failing the write. */
    return `references unknown model '${spec.modelName}'`;
  }

  const filter: mongoose.FilterQuery<unknown> = { _id: { $in: ids } };

  const found = await model
    .find(filter, { _id: 1, isActive: 1 })
    .session(session)
    .lean()
    .exec();

  if (found.length !== ids.length) {
    const foundIds = new Set(found.map((doc) => String(doc._id)));
    const missing = ids.filter((id) => !foundIds.has(String(id)));
    return `${spec.modelName} not found: ${missing.join(', ')}`;
  }

  if (spec.requireActive) {
    const inactive = found
      .filter((doc) => (doc as { isActive?: boolean }).isActive === false)
      .map((doc) => String(doc._id));

    if (inactive.length > 0) {
      return `${spec.modelName} is inactive and cannot be assigned: ${inactive.join(', ')}`;
    }
  }

  return null;
}

/**
 * Mongoose plugin. Applied to every model through the shared base options, so
 * a new `ref` is covered the moment it is declared.
 */
export function referentialIntegrityPlugin(schema: Schema): void {
  const refs = collectRefs(schema);
  if (refs.length === 0) return;

  /* Validate on document save. Errors are reported through `invalidate` so
     they arrive as a normal ValidationError and the HTTP layer turns them into
     per-field issues without special handling. */
  schema.pre('validate', async function refIntegrityOnValidate() {
    const session = this.$session() ?? null;

    const checks = refs
      .filter((spec) => this.isNew || this.isModified(spec.path))
      .map(async (spec) => {
        const ids = idsToCheck(this.get(spec.path), spec.isArray);
        const problem = await verifyTargets(spec, ids, session);
        if (problem) this.invalidate(spec.path, problem);
      });

    await Promise.all(checks);
  });

  /* Validate on query-based updates. `runValidators` does not cover refs, and
     update paths bypass document validation entirely. */
  for (const hook of ['findOneAndUpdate', 'updateOne', 'updateMany'] as const) {
    schema.pre(hook, async function refIntegrityOnUpdate(
      next: CallbackWithoutResultAndOptionalError,
    ) {
      const update = this.getUpdate();
      if (!update || Array.isArray(update)) return next();

      const session = this.getOptions().session ?? null;
      const assigned = {
        ...(update as Record<string, unknown>),
        ...((update as { $set?: Record<string, unknown> }).$set ?? {}),
        ...((update as { $setOnInsert?: Record<string, unknown> }).$setOnInsert ?? {}),
      };

      for (const spec of refs) {
        if (!(spec.path in assigned)) continue;

        const ids = idsToCheck(assigned[spec.path], spec.isArray);
        const problem = await verifyTargets(spec, ids, session);
        if (problem) {
          const error = new mongoose.Error.ValidationError();
          error.addError(
            spec.path,
            new mongoose.Error.ValidatorError({ path: spec.path, message: problem }),
          );
          return next(error);
        }
      }

      return next();
    });
  }
}

/** Registers a model's references for the integrity sweep. */
export function registerRefs(modelName: string, schema: Schema): void {
  refRegistry.set(modelName, collectRefs(schema));
}
