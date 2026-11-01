import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DISCOUNT_TYPES, DRAFT_STATUSES, DRAFT_TYPES } from '@rb/shared';

const draftItemSchema = new Schema(
  {
    menuItemId: { type: Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    // name / price / image are refreshed from the menu on every save (display only)
    name: { type: String, required: true },
    imageUrl: { type: String, default: null },
    unitPrice: { type: Number, required: true },
    taxable: { type: Boolean, default: true },
    taxRateBps: { type: Number, default: null },
    extraTaxes: { type: [{ name: String, rateBps: Number, _id: false }], default: [] },
    quantity: { type: Number, required: true, min: 1 },
    unavailable: { type: Boolean, default: false },
    // For the kitchen ("no onion"); goes with the dish's next ticket
    note: { type: String, default: '' },
  },
  { _id: false },
);

const taxLineSchema = new Schema(
  { name: String, rateBps: Number, amount: Number, base: Number },
  { _id: false },
);

const draftSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    type: { type: String, enum: DRAFT_TYPES, required: true },
    tableId: { type: Schema.Types.ObjectId, ref: 'Table', default: null },
    groupName: { type: String, default: '' },
    guestCount: { type: Number, default: 0 },
    groupTag: { type: String, default: '' },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    customerName: { type: String, default: '' },
    items: { type: [draftItemSchema], default: [] },
    discount: {
      type: new Schema({ type: { type: String, enum: DISCOUNT_TYPES }, value: Number }, { _id: false }),
      default: null,
    },
    totals: {
      subtotal: { type: Number, default: 0 },
      discountAmount: { type: Number, default: 0 },
      taxes: { type: [taxLineSchema], default: [] },
      taxTotal: { type: Number, default: 0 },
      grandTotal: { type: Number, default: 0 },
    },
    status: { type: String, enum: DRAFT_STATUSES, default: 'ACTIVE' },
    version: { type: Number, default: 0 },
    // Quantities already sent to the kitchen; a new ticket carries only what was added since.
    // Kept apart from `version` so sending never conflicts with the bill being edited.
    kitchenSent: {
      type: [new Schema({ menuItemId: { type: Schema.Types.ObjectId, required: true }, quantity: { type: Number, required: true } }, { _id: false })],
      default: [],
    },
    kitchenRev: { type: Number, default: 0 },
    // Counter orders: the day's token, given with the first kitchen ticket and kept by later ones.
    kitchenToken: { type: Number, default: null },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedByName: { type: String, default: '' },
    finalizedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

draftSchema.index({ tableId: 1, status: 1 });
draftSchema.index({ branchId: 1, status: 1, type: 1 });
draftSchema.index(
  { tableId: 1, groupName: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE', type: 'TABLE' } },
);
draftSchema.index(
  { branchId: 1, ownerUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE', type: 'COUNTER' } },
);

export type Draft = InferSchemaType<typeof draftSchema>;
export type DraftDoc = HydratedDocument<Draft>;
export const DraftModel = model('Draft', draftSchema);
