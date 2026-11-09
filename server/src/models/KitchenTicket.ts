import { model, Schema, type InferSchemaType } from 'mongoose';
import { DRAFT_TYPES, KITCHEN_STATUSES, ORDER_TYPES } from '@rb/shared';

/** An order sent to a branch kitchen (KOT), moved through NEW → PREPARING → READY → SERVED. */
const kitchenTicketSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    // Unique per branch (each counter's ticket of one send has its own, e.g. "…-0009.2")
    number: { type: String, required: true },
    // The KOT number staff see: one per send, shared by all the counters it went to ("…-0009").
    // Older tickets have none and show `number`.
    kot: { type: String, default: '' },
    draftId: { type: Schema.Types.ObjectId, ref: 'Draft', required: true },
    type: { type: String, enum: DRAFT_TYPES, required: true },
    tableLabel: { type: String, default: '' },
    groupName: { type: String, default: '' },
    // Older tickets have none: a counter order then counts as a parcel (see toKitchenTicketDTO).
    orderType: { type: String, enum: ORDER_TYPES, default: null },
    token: { type: Number, default: null },
    billNumber: { type: String, default: '' },
    items: {
      type: [
        new Schema(
          {
            menuItemId: { type: Schema.Types.ObjectId, required: true },
            name: { type: String, required: true },
            quantity: { type: Number, required: true, min: 1 },
            note: { type: String, default: '' },
            // The kitchen ticked it done (it shows on the waiter's Ready to Serve) / the waiter served it
            ready: { type: Boolean, default: false },
            served: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    status: { type: String, enum: KITCHEN_STATUSES, default: 'NEW' },
    priority: { type: Boolean, default: false },
    statusAt: { type: Date, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, default: '' },
    servedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    servedByName: { type: String, default: '' },
    // The kitchen counter it went to (null: the branch has one kitchen, or older tickets)
    stationId: { type: Schema.Types.ObjectId, default: null },
    stationName: { type: String, default: '' },
  },
  { timestamps: true },
);

kitchenTicketSchema.index({ branchId: 1, status: 1, createdAt: 1 });
kitchenTicketSchema.index({ branchId: 1, number: 1 }, { unique: true });
kitchenTicketSchema.index({ draftId: 1 });

export type KitchenTicket = InferSchemaType<typeof kitchenTicketSchema>;
export const KitchenTicketModel = model('KitchenTicket', kitchenTicketSchema);
