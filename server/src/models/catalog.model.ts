/**
 * Product and ProductModel.
 *
 * The spec's entity list (section 18) names only `Product`, but the complaint
 * form (section 6.1), the navigation and the Phase 2 plan all treat Model as a
 * distinct thing — a complaint records both a product name and a model number.
 * Resolved as `Product has many ProductModel`; see DECISIONS.md section 4.4.
 *
 * Serial numbers deliberately do **not** get their own entity. Section 13 asks
 * for serial-number *history*, which is a query across complaints, not an
 * inventory of manufactured units the company does not have.
 */
import { Schema, type Types } from 'mongoose';
import {
  activeFlagField,
  baseSchemaOptions,
  defineModel,
  optionalText,
  requiredName,
} from './common/base.js';

/* ---- Product ----------------------------------------------------------- */

export interface ProductDoc {
  _id: Types.ObjectId;
  name: string;
  code: string;
  category?: string;
  /**
   * Default warranty length for the product line, in months.
   *
   * Advisory only. Section 12 is explicit that the warranty status chosen on
   * the complaint is authoritative — this value may prefill the form but must
   * never override what the Admin selected.
   */
  defaultWarrantyMonths?: number;
  notes?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<ProductDoc>(
  {
    name: requiredName(180),
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
      match: [/^[A-Z0-9_-]+$/, 'Product code may use letters, digits, hyphen and underscore'],
    },
    category: { type: String, required: false, trim: true, maxlength: 120 },
    defaultWarrantyMonths: { type: Number, required: false, min: 0, max: 600 },
    notes: optionalText(1000),
    ...activeFlagField,
  },
  baseSchemaOptions,
);

productSchema.index({ code: 1 }, { unique: true });
/* Product search is an autocomplete on the complaint form (section 6.1), so
   name needs to be indexed for prefix and text matching. */
productSchema.index({ name: 1 });
productSchema.index({ isActive: 1, name: 1 });

export const Product = defineModel<ProductDoc>('Product', productSchema);

/* ---- ProductModel ------------------------------------------------------ */

export interface ProductModelDoc {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  modelNumber: string;
  name?: string;
  defaultWarrantyMonths?: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productModelSchema = new Schema<ProductModelDoc>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    modelNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 60,
    },
    name: { type: String, required: false, trim: true, maxlength: 180 },
    defaultWarrantyMonths: { type: Number, required: false, min: 0, max: 600 },
    ...activeFlagField,
  },
  baseSchemaOptions,
);

/* A model number is unique within its product line, not globally — two
   product lines may legitimately reuse a number. */
productModelSchema.index({ productId: 1, modelNumber: 1 }, { unique: true });
/* Section 16 reports complaint volume by model, so this is a hot lookup. */
productModelSchema.index({ modelNumber: 1 });
productModelSchema.index({ productId: 1, isActive: 1 });

export const ProductModel = defineModel<ProductModelDoc>(
  'ProductModel',
  productModelSchema,
);
