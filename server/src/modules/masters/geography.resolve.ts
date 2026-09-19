/**
 * Find-or-create city and territory (DECISIONS.md section 32).
 *
 * The client asked for two things that pull in opposite directions: cities
 * must be *typed*, not picked from a list the Admin has to build first, yet
 * complaint recommendations, reports and filters all need a stable city id to
 * key off. This file is the resolution: a form sends a city *name* plus a
 * *state*, and every write path that touches a city — a customer, a service
 * center's own city or its coverage list, a complaint's service address —
 * turns that pair into a real `City` document, creating one (and, if needed,
 * its state's `Territory`) the first time it is typed and reusing it on every
 * later mention.
 *
 * Nobody ever opens a "create city" screen: this *is* that screen, run by the
 * server on every write instead of by an Admin in advance.
 *
 * ## Matching
 *
 * A state must be one of `INDIAN_STATES` (`core/india.ts`); anything else is
 * refused, naming the offending field, exactly as DECISIONS.md section 32
 * requires everywhere a state is stored. A city name is matched
 * case-insensitively *within that state* — "Pune" and "pune" are the same
 * city, but "Hyderabad, Telangana" and "Hyderabad, Sindh" are not, because two
 * places can share a name.
 *
 * ## Concurrency
 *
 * Two requests typing the same new city at once must not create two. The
 * city's unique index (`name`+`state`) carries a case-insensitive collation
 * (`models/geography.model.ts`), so even two requests that typed different
 * capitalisation collide at the database rather than the application. Losing
 * that race is not an error here: the loser catches the duplicate-key error
 * and re-reads what the winner just created. The same pattern covers a
 * state's territory, keyed on its deterministic `code`.
 */
import mongoose, { type ClientSession } from 'mongoose';
import { canonicalState, cleanCityName, type IndianState } from '../../core/india.js';
import { escapeRegex } from '../../core/search.js';
import { badRequest, notFound } from '../../http/errors.js';
import {
  City,
  Territory,
  type CityDoc,
  type TerritoryDoc,
} from '../../models/index.js';

/** True for a MongoDB duplicate-key error — the losing side of a create race. */
function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof mongoose.mongo.MongoServerError && err.code === 11000;
}

/**
 * A short, deterministic, unique-enough handle for a state's territory.
 *
 * Derived rather than asked for, because nobody types a territory code
 * anymore — the territory exists only so every city and service center still
 * has one to point at (the schema requires it), never as something a person
 * chooses.
 */
function territoryCodeFor(state: string): string {
  const code = state
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
    .replace(/^_+|_+$/g, '');
  return code || 'STATE';
}

/** The one territory for a state, created the first time that state is used. */
async function findOrCreateTerritory(
  state: IndianState,
  session: ClientSession | undefined,
): Promise<TerritoryDoc> {
  const findExisting = () => {
    const query = Territory.findOne({ name: state });
    return (session ? query.session(session) : query).exec();
  };

  const existing = await findExisting();
  if (existing) return existing;

  const code = territoryCodeFor(state);

  try {
    const [created] = await Territory.create(
      [{ name: state, code }],
      session ? { session } : {},
    );
    return created!;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const retryQuery = Territory.findOne({ $or: [{ name: state }, { code }] });
      const retry = await (session ? retryQuery.session(session) : retryQuery).exec();
      if (retry) return retry;
    }
    throw err;
  }
}

/**
 * The official spelling of a state, or a refusal naming the field.
 *
 * Used both to resolve a city and to store a `state` value directly
 * (`Customer.state`, a complaint's `serviceAddress.state`) — the same
 * canonical value ends up in both places, so a customer's record and the city
 * it points at can never disagree about which state they are in.
 */
export function resolveState(value: string, field: string): IndianState {
  const state = canonicalState(value);
  if (!state) {
    throw badRequest(`'${value}' is not a state or union territory in India`, [
      { field, message: 'Not an Indian state or union territory' },
    ]);
  }
  return state;
}

/** Field names for the error messages `resolveCity`/`findOrCreateCity` raise. */
export interface CityFieldNames {
  cityIdField: string;
  cityNameField: string;
  stateField: string;
}

/**
 * Finds a state's city by name, creating it (and its territory, if needed)
 * the first time. Never returns two documents for one place: matching is
 * case-insensitive within the state, and a concurrent duplicate is resolved
 * by re-reading rather than by erroring.
 */
export async function findOrCreateCity(
  cityNameRaw: string,
  stateRaw: string,
  fields: CityFieldNames,
  session?: ClientSession,
): Promise<CityDoc> {
  const state = resolveState(stateRaw, fields.stateField);

  const name = cleanCityName(cityNameRaw);
  if (!name) {
    throw badRequest('City name is required', [
      { field: fields.cityNameField, message: 'City name is required' },
    ]);
  }

  const nameMatch = new RegExp(`^${escapeRegex(name)}$`, 'i');
  const findExisting = () => {
    const query = City.findOne({ state, name: nameMatch });
    return (session ? query.session(session) : query).exec();
  };

  const existing = await findExisting();
  if (existing) return existing;

  const territory = await findOrCreateTerritory(state, session);

  try {
    const [created] = await City.create(
      [{ name, state, territoryId: territory._id }],
      session ? { session } : {},
    );
    return created!;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const retry = await findExisting();
      if (retry) return retry;
    }
    throw err;
  }
}

/** What a caller has typed or picked for a city: exactly one of the two. */
export interface CityInput {
  cityId?: string | undefined;
  cityName?: string | undefined;
  state?: string | undefined;
}

/**
 * Resolves a city from either form a request may send: an existing
 * `cityId` (unchanged behaviour — every API that already accepted one keeps
 * working), or a typed `cityName` + `state` (find-or-create, above).
 */
export async function resolveCity(
  input: CityInput,
  fields: CityFieldNames,
  session?: ClientSession,
): Promise<CityDoc> {
  if (input.cityId) {
    const query = City.findById(input.cityId);
    const city = await (session ? query.session(session) : query).exec();
    if (!city) throw notFound('That city no longer exists');
    return city;
  }

  if (!input.cityName) {
    throw badRequest('A city is required', [
      { field: fields.cityNameField, message: 'Provide a city' },
    ]);
  }
  if (!input.state) {
    throw badRequest('State is required', [
      { field: fields.stateField, message: 'State is required' },
    ]);
  }

  return findOrCreateCity(input.cityName, input.state, fields, session);
}

/**
 * A read-only city lookup for the complaint-creation screen's centre
 * recommendation (section 8), which may only have a typed city name and state
 * rather than an id yet.
 *
 * Deliberately never creates: a recommendation query is a read, and a city
 * that does not exist yet simply has no recommendations keyed on it — section
 * 22's "offer every active centre" fallback still applies.  Invalid input
 * (an unrecognised state, a blank name) is treated the same as no match
 * rather than an error, since a filter that fails to narrow a picker is not
 * worth failing the whole request over.
 */
export async function findCityReadOnly(
  cityNameRaw: string,
  stateRaw: string,
): Promise<CityDoc | null> {
  const state = canonicalState(stateRaw);
  if (!state) return null;

  const name = cleanCityName(cityNameRaw);
  if (!name) return null;

  const nameMatch = new RegExp(`^${escapeRegex(name)}$`, 'i');
  return City.findOne({ state, name: nameMatch }).exec();
}
