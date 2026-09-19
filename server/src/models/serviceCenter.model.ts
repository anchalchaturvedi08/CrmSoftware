/**
 * Service Center.
 *
 * The coverage fields here feed the recommendation in section 8. That section
 * is emphatic on one point: the system may *suggest* centers by city, pincode
 * and territory, but *never* auto-assigns — the Admin always picks. So this
 * model carries only the data a suggestion is built from; the choice itself is
 * recorded on the complaint.
 *
 * The owner is not stored as a reference. It is the `User` with role
 * `SERVICE_CENTER_OWNER` and a matching `serviceCenterId`, which keeps one
 * source of truth rather than two that can disagree.
 */
import { Schema, type Types } from 'mongoose';
import {
  activeFlagField,
  baseSchemaOptions,
  defineModel,
  mobileField,
  optionalText,
  pincodeField,
  requiredName,
} from './common/base.js';

export interface ServiceCenterDoc {
  _id: Types.ObjectId;
  name: string;
  code: string;
  mobile: string;
  email?: string;

  /* Where the centre itself is. */
  address: string;
  cityId: Types.ObjectId;
  pincode: string;
  territoryId: Types.ObjectId;

  /**
   * Coverage, used only to rank recommendations (section 8). An empty
   * coverage list does not disqualify a centre — section 22 requires that when
   * nothing matches, every active centre is offered for manual selection.
   */
  servedCityIds: Types.ObjectId[];
  servedPincodes: string[];

  /**
   * Optional coordinates. Section 8 mentions latitude/longitude as a possible
   * future input to recommendation, and section 27 rules out GPS *tracking*
   * for the MVP. A fixed point for a building is not tracking, so the field is
   * here and unused rather than requiring a later migration.
   */
  location?: { lat: number; lng: number };

  notes?: string;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const serviceCenterSchema = new Schema<ServiceCenterDoc>(
  {
    name: requiredName(180),
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 30,
      match: [/^[A-Z0-9_-]+$/, 'Center code may use letters, digits, hyphen and underscore'],
    },
    mobile: mobileField,
    email: {
      type: String,
      required: false,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email address is not valid'],
    },

    address: { type: String, required: true, trim: true, maxlength: 500 },
    cityId: { type: Schema.Types.ObjectId, ref: 'City', required: true },
    pincode: pincodeField,
    territoryId: { type: Schema.Types.ObjectId, ref: 'Territory', required: true },

    servedCityIds: [{ type: Schema.Types.ObjectId, ref: 'City' }],
    servedPincodes: [
      {
        type: String,
        trim: true,
        match: [/^\d{6}$/, 'Served pincode must be 6 digits'],
      },
    ],

    location: {
      type: new Schema(
        {
          lat: { type: Number, required: true, min: -90, max: 90 },
          lng: { type: Number, required: true, min: -180, max: 180 },
        },
        { _id: false },
      ),
      required: false,
    },

    notes: optionalText(1000),
    ...activeFlagField,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
  },
  baseSchemaOptions,
);

serviceCenterSchema.index({ code: 1 }, { unique: true });

/* The recommendation query in section 8 filters on coverage and activity, so
   these are the indexes that keep complaint creation responsive. */
serviceCenterSchema.index({ isActive: 1, servedPincodes: 1 });
serviceCenterSchema.index({ isActive: 1, servedCityIds: 1 });
serviceCenterSchema.index({ isActive: 1, territoryId: 1 });
serviceCenterSchema.index({ name: 1 });

export const ServiceCenter = defineModel<ServiceCenterDoc>(
  'ServiceCenter',
  serviceCenterSchema,
);
