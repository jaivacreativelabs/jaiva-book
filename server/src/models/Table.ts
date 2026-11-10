import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { TABLE_SHAPES, TABLE_STATUSES } from '@rb/shared';

const tableSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    label: { type: String, required: true, trim: true, maxlength: 10 },
    labelKey: { type: String, required: true },
    seats: { type: Number, required: true, min: 1, max: 30 },
    shape: { type: String, enum: TABLE_SHAPES, default: 'SQUARE' },
    floor: { type: String, default: 'Ground Floor', trim: true, maxlength: 40 },
    status: { type: String, enum: TABLE_STATUSES, default: 'AVAILABLE' },
    isActive: { type: Boolean, default: true },
    // The waiter looking after the guests now (set by the cashier or the first waiter to take an
    // order here); cleared when the last group leaves. Other waiters cannot take its orders.
    waiterId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    waiterName: { type: String, default: '' },
    // bumped whenever seats are claimed so concurrent group creation is serialised
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

tableSchema.index({ branchId: 1, labelKey: 1 }, { unique: true });
tableSchema.index({ branchId: 1, floor: 1 });

export type Table = InferSchemaType<typeof tableSchema>;
export type TableDoc = HydratedDocument<Table>;
export const TableModel = model('Table', tableSchema);
