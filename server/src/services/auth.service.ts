import bcrypt from 'bcryptjs';
import type { Types } from 'mongoose';
import type { BranchContextDTO, MeDTO } from '@rb/shared';
import { env } from '../config/env.js';
import type { AuthUser } from '../middleware/auth.js';
import type { BranchLean, RestaurantLean } from '../middleware/scope.js';
import { BranchModel, RestaurantModel, UserModel } from '../models/index.js';
import { AppError, unauthenticated } from '../utils/errors.js';
import { restaurantSettings, toUserDTO } from '../utils/serialize.js';

const BCRYPT_COST = 12;
// Compared against when the email is unknown so both paths take the same time.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_COST);

/** Wrong passwords allowed per account within LOCK_MS; then sign-in is locked for LOCK_MS. */
const LOCK_MS = 15 * 60 * 1000;

/** Counts a wrong password; the one that reaches the limit locks the account. */
async function recordFailedLogin(userId: Types.ObjectId) {
  const now = new Date();
  const recent = { $gt: ['$loginFailsSince', new Date(now.getTime() - LOCK_MS)] };
  await UserModel.updateOne({ _id: userId }, [
    {
      $set: {
        loginFails: { $cond: [recent, { $add: [{ $ifNull: ['$loginFails', 0] }, 1] }, 1] },
        loginFailsSince: { $cond: [recent, '$loginFailsSince', now] },
      },
    },
    { $set: { lockedUntil: { $cond: [{ $gte: ['$loginFails', env.LOGIN_RATE_LIMIT_MAX] }, new Date(now.getTime() + LOCK_MS), '$lockedUntil'] } } },
  ]);
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const user = await UserModel.findOne({ email })
    .select('+passwordHash')
    .lean<AuthUser & { passwordHash: string; lockedUntil?: Date | null }>();
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000));
    throw new AppError(429, 'ACCOUNT_LOCKED', `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
  if (!user || !ok) {
    if (user) await recordFailedLogin(user._id);
    throw unauthenticated('Invalid email or password');
  }
  if (user.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your account has been deactivated');
  await UserModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date(), loginFails: 0, loginFailsSince: null, lockedUntil: null } });
  const { passwordHash: _omit, lockedUntil: _lock, ...safe } = user;
  return safe;
}

export async function changePassword(user: AuthUser, currentPassword: string, newPassword: string): Promise<AuthUser> {
  const doc = await UserModel.findById(user._id).select('+passwordHash');
  if (!doc || !(await bcrypt.compare(currentPassword, doc.passwordHash))) {
    throw new AppError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
  }
  doc.passwordHash = await hashPassword(newPassword);
  doc.tokenVersion += 1;
  await doc.save();
  return doc.toObject() as unknown as AuthUser;
}

/** Branches a branch account (Restaurant Admin / Kitchen) may operate – active branch + active restaurant only. */
export async function accessibleBranches(user: AuthUser): Promise<BranchContextDTO[]> {
  if (user.role === 'SUPER_ADMIN' || user.branchIds.length === 0) return [];
  const branches = await BranchModel.find({
    _id: { $in: user.branchIds },
    restaurantId: { $in: user.restaurantIds },
    status: 'ACTIVE',
  })
    .sort({ name: 1 })
    .lean<BranchLean[]>();
  const restaurants = await RestaurantModel.find({
    _id: { $in: branches.map((b) => b.restaurantId) },
    status: 'ACTIVE',
  }).lean<RestaurantLean[]>();
  const byId = new Map(restaurants.map((r) => [String(r._id), r]));
  return branches
    .filter((b) => byId.has(String(b.restaurantId)))
    .map((b) => {
      const r = byId.get(String(b.restaurantId))!;
      return {
        id: String(b._id),
        name: b.name,
        code: b.code,
        kitchenDisplay: b.kitchenDisplay ?? false,
        kitchenStations: (b.kitchenStations ?? []).map((s) => ({ id: String(s._id), name: s.name })),
        shopOpen: b.shopOpen ?? true,
        restaurant: { id: String(r._id), name: r.name, logoUrl: r.logoUrl ?? null, settings: restaurantSettings(r) },
      };
    });
}

export async function me(user: AuthUser): Promise<MeDTO> {
  return { user: toUserDTO(user), branches: await accessibleBranches(user) };
}
