import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { RECORD_STATUSES, ROLES } from '@rb/shared';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    passwordHash: { type: String, required: true, select: false },
    // `immutable`: a role can never be changed after the account exists.
    role: { type: String, enum: ROLES, required: true, immutable: true },
    restaurantIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Restaurant' }], default: [] },
    branchIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Branch' }], default: [] },
    // Kitchen logins: the branch's kitchen counter they work (null → every counter)
    kitchenStationId: { type: Schema.Types.ObjectId, default: null },
    status: { type: String, enum: RECORD_STATUSES, default: 'ACTIVE' },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    // Wrong passwords in a row (since loginFailsSince); too many lock sign-in until lockedUntil.
    // Kept here, not in memory, so every server instance counts the same attempts.
    loginFails: { type: Number, default: 0 },
    loginFailsSince: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    // One-tap demo sign-in from the login page, switched on per account by the Super Admin.
    // No password is involved: the server issues the session itself while this is enabled.
    demo: {
      enabled: { type: Boolean, default: false },
      label: { type: String, default: '', trim: true, maxlength: 40 },
    },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ branchIds: 1 });

export type User = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<User>;
export const UserModel = model('User', userSchema);
