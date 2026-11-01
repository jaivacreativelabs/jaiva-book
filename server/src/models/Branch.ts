import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { RECORD_STATUSES } from '@rb/shared';

const branchSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    nameKey: { type: String, required: true },
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 10 },
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    status: { type: String, enum: RECORD_STATUSES, default: 'ACTIVE' },
    // Orders are sent to a Kitchen Display board for this branch (Super Admin setting)
    kitchenDisplay: { type: Boolean, default: false },
    // Kitchen counters (Tiffin, Juice…), in order: each gets the dishes of its categories as its
    // own ticket; dishes of categories no counter lists go to the first. Empty → one kitchen.
    kitchenStations: {
      type: [
        new Schema({
          name: { type: String, required: true, trim: true, maxlength: 40 },
          categoryIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Category' }], default: [] },
        }),
      ],
      default: [],
    },
    // Open / Close Shop: while closed nothing can be billed. Closing emails the day's report.
    shopOpen: { type: Boolean, default: true },
    shopStateAt: { type: Date, default: null },
    // "YYYY-MM-DD" (APP_TIMEZONE) whose report went out for this branch – the evening backup
    // email skips a branch that already sent it on Close Shop.
    dailyReportSentFor: { type: String, default: '' },
  },
  { timestamps: true },
);

branchSchema.index({ restaurantId: 1, code: 1 }, { unique: true });
branchSchema.index({ restaurantId: 1, nameKey: 1 }, { unique: true });

export type Branch = InferSchemaType<typeof branchSchema>;
export type BranchDoc = HydratedDocument<Branch>;
export const BranchModel = model('Branch', branchSchema);
