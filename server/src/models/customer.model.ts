/**
 * Customer.
 *
 * Customers have no login and no portal (spec section 1, rule 14) — this is a
 * record the Admin maintains, not an account.
 *
 * Mobile number is the identity. That is what makes section 13's repeat
 * complaint flow work: searching a number has to surface *all* of that
 * person's prior service history, and it cannot do that if the same person
 * exists three times over. Hence the unique index, and the normalization in
 * `normalizeMobile` that collapses `+91 98765-43210` and `9876543210` into one
 * value before it is ever stored.
 *
 * The address here is the customer's default. Every complaint snapshots its
 * own service address at creation, so correcting this record later can never
 * rewrite where a past visit actually happened (DECISIONS.md section 5, item 7).
 */
import { Schema, type Types } from 'mongoose';
import {
  activeFlagField,
  baseSchemaOptions,
  defineModel,
  mobileField,
  normalizeMobile,
  optionalText,
  pincodeField,
  requiredName,
} from './common/base.js';

export interface CustomerDoc {
  _id: Types.ObjectId;
  name: string;
  mobile: string;
  alternateMobile?: string;
  email?: string;

  /* Default service location. Snapshotted onto each complaint. */
  address: string;
  cityId: Types.ObjectId;
  state: string;
  pincode: string;

  notes?: string;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<CustomerDoc>(
  {
    name: requiredName(160),
    mobile: mobileField,
    alternateMobile: {
      type: String,
      required: false,
      trim: true,
      match: [/^[6-9]\d{9}$/, 'Alternate mobile must be 10 digits and start with 6-9'],
    },
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
    state: requiredName(120),
    pincode: pincodeField,

    notes: optionalText(2000),
    ...activeFlagField,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
  },
  baseSchemaOptions,
);

/**
 * Normalizes both numbers before validation, so the `match` patterns above
 * judge the stored form rather than whatever punctuation was typed.
 */
customerSchema.pre('validate', function normalizeMobileNumbers() {
  if (this.mobile) this.mobile = normalizeMobile(this.mobile);
  if (this.alternateMobile) {
    this.alternateMobile = normalizeMobile(this.alternateMobile);
  }
});

/* One customer per mobile number — the premise of repeat-complaint history. */
customerSchema.index({ mobile: 1 }, { unique: true });

/* Admin searches customers by name, and reports break down by city. */
customerSchema.index({ name: 1 });
customerSchema.index({ cityId: 1, isActive: 1 });

export const Customer = defineModel<CustomerDoc>('Customer', customerSchema);
