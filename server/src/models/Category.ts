import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { RECORD_STATUSES } from '@rb/shared';

// A branch's own name, icon, on/off and position for a category (null → the category's own).
const categoryOverrideSchema = new Schema(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    name: { type: String, default: null, trim: true, maxlength: 50 },
    icon: { type: String, default: null },
    status: { type: String, enum: [...RECORD_STATUSES, null], default: null },
    displayOrder: { type: Number, default: null },
    // A shared category this branch deleted from its own menu (other branches keep it).
    deleted: { type: Boolean, default: null },
    // This branch's own GST % for a main-menu category (null → the category's).
    taxRateBps: { type: Number, default: null },
  },
  { _id: false },
);

const categorySchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    // null → shared by every branch of the restaurant
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
    name: { type: String, required: true, trim: true, maxlength: 50 },
    nameKey: { type: String, required: true },
    icon: { type: String, default: '' },
    displayOrder: { type: Number, default: 0 },
    status: { type: String, enum: RECORD_STATUSES, default: 'ACTIVE' },
    branchOverrides: { type: [categoryOverrideSchema], default: [] },
    // GST % (basis points) given to every dish in it when set or changed; new dishes start with
    // it. A dish can still have its own. null: not set.
    taxRateBps: { type: Number, default: null, min: 0, max: 10_000 },
  },
  { timestamps: true },
);

categorySchema.index({ restaurantId: 1, branchId: 1, nameKey: 1 }, { unique: true });

export type Category = InferSchemaType<typeof categorySchema>;
export type CategoryDoc = HydratedDocument<Category>;
export const CategoryModel = model('Category', categorySchema);
