/**
 * Territory and City.
 *
 * These exist to drive two things: the city/territory reporting breakdowns
 * (spec section 16) and the service-center recommendation in section 8, which
 * matches on city, pincode and territory.
 *
 * Neither is ever hard-deleted (section 17) — both carry an active flag.
 *
 * Cities are typed, not picked from a list an Admin maintains (DECISIONS.md
 * section 32): `modules/masters/geography.resolve.ts` finds or creates one
 * from a name and a state on every write that mentions a city. A territory is
 * now exactly one per state, created the same on-demand way. Both models keep
 * their original shape — nothing downstream that joins on a city or territory
 * id had to change — only how a row comes to exist is different.
 */
import { Schema, type Types } from 'mongoose';
import {
  activeFlagField,
  baseSchemaOptions,
  defineModel,
  optionalText,
  requiredName,
} from './common/base.js';

/* ---- Territory --------------------------------------------------------- */

export interface TerritoryDoc {
  _id: Types.ObjectId;
  name: string;
  code: string;
  notes?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const territorySchema = new Schema<TerritoryDoc>(
  {
    name: requiredName(120),
    /* A short human-usable handle for reports and filters. Upper-cased so
       'north' and 'NORTH' cannot become two territories. */
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 20,
      match: [/^[A-Z0-9_-]+$/, 'Territory code may use letters, digits, hyphen and underscore'],
    },
    notes: optionalText(500),
    ...activeFlagField,
  },
  baseSchemaOptions,
);

territorySchema.index({ code: 1 }, { unique: true });
territorySchema.index({ name: 1 });

export const Territory = defineModel<TerritoryDoc>('Territory', territorySchema);

/* ---- City -------------------------------------------------------------- */

export interface CityDoc {
  _id: Types.ObjectId;
  name: string;
  state: string;
  territoryId: Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const citySchema = new Schema<CityDoc>(
  {
    name: requiredName(120),
    state: requiredName(120),
    /* Not `refActive`: an existing city may legitimately sit in a territory
       that has been retired, and section 22 requires history to survive
       master-data changes. Assignment-time rules are enforced on the
       complaint, not here. */
    territoryId: { type: Schema.Types.ObjectId, ref: 'Territory', required: true },
    ...activeFlagField,
  },
  baseSchemaOptions,
);

/**
 * Two cities of the same name in different states are different places, so
 * uniqueness is on the pair rather than the name alone.
 *
 * The case-insensitive collation is what makes the find-or-create in
 * `geography.resolve.ts` race-safe: two requests typing "Pune" and "pune" for
 * a city that does not exist yet both look it up, find nothing, and both try
 * to create it. Without this, the plain index would let both inserts through
 * — different strings — producing two cities for one place. With it, the
 * second insert collides at the database and the loser re-reads what the
 * winner just created, rather than trusting application code alone to win a
 * race it cannot fully see.
 */
citySchema.index(
  { name: 1, state: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
);
citySchema.index({ territoryId: 1, isActive: 1 });

export const City = defineModel<CityDoc>('City', citySchema);
