/** Super Admin operations: restaurants, branches and Restaurant Admin accounts. */
import type { Types } from 'mongoose';
import {
  STAFF_ROLES,
  type BranchCreateInput,
  type RecordStatus,
  type RestaurantCreateInput,
  type RestaurantUpdateInput,
  type RestaurantSettingsInput,
  type KitchenStationsInput,
  type UserCreateInput,
  type UserUpdateInput,
} from '@rb/shared';
import { runInTransaction } from '../config/transaction.js';
import type { AuthUser } from '../middleware/auth.js';
import type { BranchLean, RestaurantLean } from '../middleware/scope.js';
import {
  BranchModel,
  CategoryModel,
  CounterModel,
  DraftModel,
  ExpenseModel,
  KitchenTicketModel,
  MenuImageModel,
  MenuItemModel,
  RestaurantModel,
  TableModel,
  TransactionModel,
  UserModel,
} from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { toBranchDTO, toRestaurantDTO, toUserDTO } from '../utils/serialize.js';
import { nameKey, toObjectId } from '../utils/validate.js';
import { audit } from './audit.service.js';
import { hashPassword } from './auth.service.js';
import { MENU_IMAGE_DIR, saveImage } from './storage.service.js';

// ---------------- Restaurants ----------------

export async function listRestaurants(status?: string) {
  const filter = status === 'ACTIVE' || status === 'INACTIVE' ? { status } : {};
  const restaurants = await RestaurantModel.find(filter).sort({ name: 1 }).lean<RestaurantLean[]>();
  const counts = await BranchModel.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $group: { _id: '$restaurantId', n: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  return restaurants.map((r) => toRestaurantDTO(r, byId.get(String(r._id)) ?? 0));
}

async function getRestaurantOr404(id: string) {
  const r = await RestaurantModel.findById(toObjectId(id, 'restaurant'));
  if (!r) throw notFound('Restaurant');
  return r;
}

async function assertRestaurantNameFree(name: string, exceptId?: Types.ObjectId) {
  const clash = await RestaurantModel.exists({ nameKey: nameKey(name), ...(exceptId && { _id: { $ne: exceptId } }) });
  if (clash) throw conflict('A restaurant with this name already exists', 'DUPLICATE');
}

/** "Keda Kari Virundhu" → "KKV": the bill code of a new restaurant (MAIN when the name has no letters). */
export function initialsCode(name: string): string {
  const code = name
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, '')[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 10);
  return code || 'MAIN';
}

/**
 * Creates a restaurant together with the one branch everything in it belongs to (its tables,
 * bills, admins). The app shows no branches: that branch has the restaurant's name and contact
 * details, and its code (the bill prefix) is given or taken from the name's initials.
 */
export async function createRestaurant(actor: AuthUser, input: RestaurantCreateInput) {
  await assertRestaurantNameFree(input.name);
  const { billCode, ...fields } = input;
  const code = billCode || initialsCode(input.name);
  const { restaurant, branch } = await runInTransaction(async (session) => {
    const [r] = await RestaurantModel.create([{ ...fields, nameKey: nameKey(input.name) }], { session });
    const [b] = await BranchModel.create(
      [
        {
          restaurantId: r._id,
          name: r.name,
          nameKey: nameKey(r.name),
          code,
          address: input.address ?? '',
          phone: input.phone ?? '',
          email: input.email ?? '',
        },
      ],
      { session },
    );
    await audit(
      actor,
      {
        action: 'RESTAURANT_CREATED',
        entityType: 'Restaurant',
        entityId: r._id,
        restaurantId: r._id,
        branchId: b._id,
        summary: `Created restaurant "${r.name}" (bills ${code}0001…)`,
      },
      session,
    );
    return { restaurant: r, branch: b };
  });
  return { ...toRestaurantDTO(restaurant.toObject() as RestaurantLean, 1), mainBranchId: String(branch._id) };
}

export async function getRestaurantDetail(id: string) {
  const r = await getRestaurantOr404(id);
  const branches = await BranchModel.find({ restaurantId: r._id }).sort({ name: 1 }).lean<BranchLean[]>();
  const admins = await UserModel.find({ role: { $in: STAFF_ROLES }, restaurantIds: r._id })
    .sort({ name: 1 })
    .lean<AuthUser[]>();
  return {
    restaurant: toRestaurantDTO(r.toObject() as RestaurantLean, branches.length),
    branches: branches.map(toBranchDTO),
    admins: admins.map(toUserDTO),
  };
}

export async function updateRestaurant(actor: AuthUser, id: string, input: RestaurantUpdateInput) {
  const r = await getRestaurantOr404(id);
  if (input.name && nameKey(input.name) !== r.nameKey) {
    await assertRestaurantNameFree(input.name, r._id);
    r.nameKey = nameKey(input.name);
  }
  r.set(input);
  await r.save();
  // A restaurant with one branch is that branch: keep its name and contact details (printed on
  // bills) the same as the restaurant's.
  const branches = await BranchModel.find({ restaurantId: r._id }).select('_id').lean();
  if (branches.length === 1) {
    const keep: Record<string, string> = {};
    if (input.name !== undefined) Object.assign(keep, { name: r.name, nameKey: r.nameKey });
    for (const k of ['address', 'phone', 'email'] as const) if (input[k] !== undefined) keep[k] = input[k] ?? '';
    if (Object.keys(keep).length) await BranchModel.updateOne({ _id: branches[0]._id }, { $set: keep });
  }
  await audit(actor, {
    action: 'RESTAURANT_UPDATED',
    entityType: 'Restaurant',
    entityId: r._id,
    restaurantId: r._id,
    summary: `Updated restaurant "${r.name}"`,
    meta: { fields: Object.keys(input) },
  });
  return toRestaurantDTO(r.toObject() as RestaurantLean);
}

/** Sets (file) or removes (null) the restaurant's logo. Old files stay: past bills point at them. */
export async function setRestaurantLogo(actor: AuthUser, id: string, file: Express.Multer.File | null | undefined) {
  if (file === undefined) throw badRequest('Choose an image file', 'NO_FILE');
  const r = await getRestaurantOr404(id);
  r.logoUrl = file ? await saveImage(file.buffer) : null;
  await r.save();
  await audit(actor, {
    action: file ? 'RESTAURANT_LOGO_SET' : 'RESTAURANT_LOGO_REMOVED',
    entityType: 'Restaurant',
    entityId: r._id,
    restaurantId: r._id,
    summary: `${file ? 'Set' : 'Removed'} the logo of "${r.name}"`,
  });
  return toRestaurantDTO(r.toObject() as RestaurantLean);
}

export async function setRestaurantStatus(actor: AuthUser, id: string, status: RecordStatus) {
  const r = await getRestaurantOr404(id);
  r.status = status;
  await r.save();
  await audit(actor, {
    action: status === 'ACTIVE' ? 'RESTAURANT_ACTIVATED' : 'RESTAURANT_DEACTIVATED',
    entityType: 'Restaurant',
    entityId: r._id,
    restaurantId: r._id,
    summary: `${status === 'ACTIVE' ? 'Activated' : 'Deactivated'} restaurant "${r.name}"`,
  });
  return toRestaurantDTO(r.toObject() as RestaurantLean);
}

/**
 * Deletes a restaurant for good with everything in it: branches, menu, tables, open and past
 * bills, expenses, kitchen tickets, its photos and its Restaurant Admin / Kitchen logins. The
 * audit log keeps a record of the deletion. The restaurant itself goes last, so a delete that
 * stops halfway can simply be run again.
 */
export async function deleteRestaurant(actor: AuthUser, id: string) {
  const r = await getRestaurantOr404(id);
  const restaurantId = r._id;
  const branches = await BranchModel.find({ restaurantId }).select('_id').lean<{ _id: Types.ObjectId }[]>();
  const items = await MenuItemModel.find({ restaurantId }).select('imageUrl branchOverrides.imageUrl').lean<
    { imageUrl?: string | null; branchOverrides?: { imageUrl?: string | null }[] }[]
  >();
  const prefix = `/uploads/${MENU_IMAGE_DIR}/`;
  const photos = [r.logoUrl, ...items.flatMap((i) => [i.imageUrl, ...(i.branchOverrides ?? []).map((o) => o.imageUrl)])]
    .filter((u): u is string => Boolean(u?.startsWith(prefix)))
    .map((u) => u.slice(prefix.length));
  // Bill and kitchen-ticket numbers are counted per branch.
  const counterKeys = new RegExp(`^(bill|kot):(${branches.map((b) => String(b._id)).join('|') || '-'}):`);

  const byRestaurant = { restaurantId };
  const [bills, staff] = await Promise.all([
    // Bills refuse deletes through the model (a guard against slips); this one is deliberate.
    TransactionModel.collection.deleteMany(byRestaurant),
    UserModel.deleteMany({ role: { $in: STAFF_ROLES }, restaurantIds: restaurantId }),
    DraftModel.deleteMany(byRestaurant),
    ExpenseModel.deleteMany(byRestaurant),
    KitchenTicketModel.deleteMany(byRestaurant),
    TableModel.deleteMany(byRestaurant),
    MenuItemModel.deleteMany(byRestaurant),
    CategoryModel.deleteMany(byRestaurant),
    CounterModel.deleteMany({ _id: counterKeys }),
    photos.length ? MenuImageModel.deleteMany({ _id: { $in: photos } }) : null,
  ]);
  await BranchModel.deleteMany(byRestaurant);
  await RestaurantModel.deleteOne({ _id: restaurantId });
  await audit(actor, {
    action: 'RESTAURANT_DELETED',
    entityType: 'Restaurant',
    entityId: restaurantId,
    summary: `Deleted restaurant "${r.name}" with ${branches.length} branch(es), ${bills.deletedCount} bill(s) and ${staff.deletedCount} login(s)`,
  });
  return { id: String(restaurantId) };
}

/**
 * Deletes one location of a restaurant that has several, for good: its bills, open bills, tables,
 * kitchen tickets, expenses, its own dishes and categories and its prices/photos for shared ones,
 * and the logins that only worked there. A restaurant's last location goes with the restaurant.
 */
export async function deleteBranch(actor: AuthUser, id: string) {
  const b = await BranchModel.findById(toObjectId(id, 'branch')).lean<BranchLean>();
  if (!b) throw notFound('Location');
  const branchId = b._id;
  if ((await BranchModel.countDocuments({ restaurantId: b.restaurantId })) < 2) {
    throw conflict('This is the restaurant’s only location – delete the restaurant instead', 'LAST_LOCATION');
  }
  const r = await RestaurantModel.findById(b.restaurantId).select('name').lean<{ name: string }>();
  const own = await MenuItemModel.find({ branchId }).select('_id imageUrl').lean<{ _id: Types.ObjectId; imageUrl?: string | null }[]>();
  const overridden = await MenuItemModel.find({ 'branchOverrides.branchId': branchId }).select('branchOverrides').lean<
    { branchOverrides: { branchId: Types.ObjectId; imageUrl?: string | null }[] }[]
  >();
  const prefix = `/uploads/${MENU_IMAGE_DIR}/`;
  const photos = [...own.map((i) => i.imageUrl), ...overridden.flatMap((i) => i.branchOverrides.filter((o) => o.branchId.equals(branchId)).map((o) => o.imageUrl))]
    .filter((u): u is string => Boolean(u?.startsWith(prefix)))
    .map((u) => u.slice(prefix.length));
  const byBranch = { branchId };
  const [bills, staff] = await Promise.all([
    // Bills refuse deletes through the model (a guard against slips); this one is deliberate.
    TransactionModel.collection.deleteMany(byBranch),
    // Logins of this location only; others just lose it.
    UserModel.deleteMany({ role: { $in: STAFF_ROLES }, branchIds: { $size: 1, $all: [branchId] } }),
    DraftModel.deleteMany(byBranch),
    ExpenseModel.deleteMany(byBranch),
    KitchenTicketModel.deleteMany(byBranch),
    TableModel.deleteMany(byBranch),
    MenuItemModel.deleteMany({ $or: [byBranch, { parentId: { $in: own.map((i) => i._id) } }] }),
    CategoryModel.deleteMany(byBranch),
    CounterModel.deleteMany({ _id: new RegExp(`^(bill|kot):${String(branchId)}:`) }),
    photos.length ? MenuImageModel.deleteMany({ _id: { $in: photos } }) : null,
  ]);
  await Promise.all([
    UserModel.updateMany({ branchIds: branchId }, { $pull: { branchIds: branchId } }),
    MenuItemModel.updateMany({ 'branchOverrides.branchId': branchId }, { $pull: { branchOverrides: { branchId } } }),
    CategoryModel.updateMany({ 'branchOverrides.branchId': branchId }, { $pull: { branchOverrides: { branchId } } }),
  ]);
  await BranchModel.deleteOne({ _id: branchId });
  await audit(actor, {
    action: 'BRANCH_DELETED',
    entityType: 'Branch',
    entityId: branchId,
    restaurantId: b.restaurantId,
    summary: `Deleted location "${b.name}" of "${r?.name ?? ''}" with ${bills.deletedCount} bill(s) and ${staff.deletedCount} login(s)`,
  });
  return { id: String(branchId) };
}

export async function updateRestaurantSettings(actor: AuthUser, id: string, input: RestaurantSettingsInput) {
  const r = await getRestaurantOr404(id);
  const before = r.toObject().settings;
  r.settings = input as typeof r.settings;
  await r.save();
  await audit(actor, {
    action: 'RESTAURANT_SETTINGS_UPDATED',
    entityType: 'Restaurant',
    entityId: r._id,
    restaurantId: r._id,
    summary: `Updated tax/receipt settings of "${r.name}"`,
    meta: { before, after: input },
  });
  return toRestaurantDTO(r.toObject() as RestaurantLean);
}

// ---------------- Branches ----------------

export async function listBranches(restaurantId?: unknown) {
  const filter = restaurantId ? { restaurantId: toObjectId(restaurantId, 'restaurant') } : {};
  const branches = await BranchModel.find(filter).sort({ name: 1 }).lean<BranchLean[]>();
  return branches.map(toBranchDTO);
}

async function assertBranchUnique(restaurantId: Types.ObjectId, name?: string, code?: string, exceptId?: Types.ObjectId) {
  const except = exceptId ? { _id: { $ne: exceptId } } : {};
  if (code && (await BranchModel.exists({ restaurantId, code, ...except }))) {
    throw conflict(`Bill code "${code}" is already used in this restaurant`, 'DUPLICATE');
  }
  if (name && (await BranchModel.exists({ restaurantId, nameKey: nameKey(name), ...except }))) {
    throw conflict(`A location named "${name}" already exists in this restaurant`, 'DUPLICATE');
  }
}

export async function createBranch(actor: AuthUser, input: BranchCreateInput) {
  const restaurant = await getRestaurantOr404(input.restaurantId);
  await assertBranchUnique(restaurant._id, input.name, input.code);
  const b = await BranchModel.create({ ...input, restaurantId: restaurant._id, nameKey: nameKey(input.name) });
  await audit(actor, {
    action: 'BRANCH_CREATED',
    entityType: 'Branch',
    entityId: b._id,
    restaurantId: restaurant._id,
    branchId: b._id,
    summary: `Created branch "${b.name}" (${b.code}) in "${restaurant.name}"`,
  });
  return toBranchDTO(b.toObject() as BranchLean);
}

async function getBranchOr404(id: string) {
  const b = await BranchModel.findById(toObjectId(id, 'branch'));
  if (!b) throw notFound('Branch');
  return b;
}

export async function updateBranch(actor: AuthUser, id: string, input: Partial<Omit<BranchCreateInput, 'restaurantId'>>) {
  const b = await getBranchOr404(id);
  await assertBranchUnique(
    b.restaurantId,
    input.name && nameKey(input.name) !== b.nameKey ? input.name : undefined,
    input.code && input.code !== b.code ? input.code : undefined,
    b._id,
  );
  b.set(input);
  if (input.name) b.nameKey = nameKey(input.name);
  await b.save();
  await audit(actor, {
    action: 'BRANCH_UPDATED',
    entityType: 'Branch',
    entityId: b._id,
    restaurantId: b.restaurantId,
    branchId: b._id,
    summary:
      Object.keys(input).length === 1 && input.kitchenDisplay !== undefined
        ? `Kitchen Display ${input.kitchenDisplay ? 'on' : 'off'} for branch "${b.name}"`
        : `Updated branch "${b.name}"`,
    meta: { fields: Object.keys(input) },
  });
  return toBranchDTO(b.toObject() as BranchLean);
}

/**
 * Replaces a branch's kitchen counters. A category belongs to one counter at most; a counter a
 * Kitchen login works cannot be removed until that login is moved.
 */
export async function setKitchenStations(actor: AuthUser, id: string, input: KitchenStationsInput) {
  const b = await getBranchOr404(id);
  const keys = input.stations.map((s) => nameKey(s.name));
  const dupName = input.stations.find((_, i) => keys.indexOf(keys[i]) !== i);
  if (dupName) throw conflict(`There are two counters named "${dupName.name}"`, 'DUPLICATE');

  const seen = new Set<string>();
  for (const s of input.stations) {
    for (const c of s.categoryIds) {
      if (seen.has(c)) throw badRequest('A category can go to one counter only', 'DUPLICATE_CATEGORY');
      seen.add(c);
    }
  }
  const catIds = [...seen].map((c) => toObjectId(c, 'category'));
  const found = await CategoryModel.countDocuments({ _id: { $in: catIds }, restaurantId: b.restaurantId, branchId: { $in: [null, b._id] } });
  if (found !== catIds.length) throw badRequest('One or more categories are not on this menu', 'INVALID_CATEGORY');

  const current = new Set(b.kitchenStations.map((s) => String(s._id)));
  const unknown = input.stations.find((s) => s.id && !current.has(s.id));
  if (unknown) throw badRequest(`Counter "${unknown.name}" no longer exists – reload and try again`, 'INVALID_STATION');
  const kept = new Set(input.stations.flatMap((s) => (s.id ? [s.id] : [])));
  const removed = [...current].filter((s) => !kept.has(s)).map((s) => toObjectId(s));
  const inUse = removed.length ? await UserModel.findOne({ kitchenStationId: { $in: removed } }).select('name').lean<{ name: string }>() : null;
  if (inUse) throw conflict(`The Kitchen login "${inUse.name}" works a counter you removed – move it to another counter first`, 'STATION_IN_USE');

  const before = b.kitchenStations.map((s) => s.name);
  b.set(
    'kitchenStations',
    input.stations.map((s) => ({ ...(s.id && { _id: toObjectId(s.id) }), name: s.name, categoryIds: s.categoryIds.map((c) => toObjectId(c)) })),
  );
  await b.save();
  await audit(actor, {
    action: 'BRANCH_UPDATED',
    entityType: 'Branch',
    entityId: b._id,
    restaurantId: b.restaurantId,
    branchId: b._id,
    summary: input.stations.length ? `Kitchen counters of "${b.name}": ${input.stations.map((s) => s.name).join(', ')}` : `Kitchen counters removed for "${b.name}"`,
    meta: { before, after: input.stations.map((s) => s.name) },
  });
  return toBranchDTO(b.toObject() as BranchLean);
}

export async function setBranchStatus(actor: AuthUser, id: string, status: RecordStatus) {
  const b = await getBranchOr404(id);
  b.status = status;
  await b.save();
  await audit(actor, {
    action: status === 'ACTIVE' ? 'BRANCH_ACTIVATED' : 'BRANCH_DEACTIVATED',
    entityType: 'Branch',
    entityId: b._id,
    restaurantId: b.restaurantId,
    branchId: b._id,
    summary: `${status === 'ACTIVE' ? 'Activated' : 'Deactivated'} branch "${b.name}"`,
  });
  return toBranchDTO(b.toObject() as BranchLean);
}

// ---------------- Restaurant Admin accounts ----------------

/** Validates branch ids and derives the restaurant ids from them (never trusted from the client). */
async function resolveAssignments(branchIds: string[]) {
  const ids = [...new Set(branchIds)].map((id) => toObjectId(id, 'branch'));
  const branches = await BranchModel.find({ _id: { $in: ids } }).lean<BranchLean[]>();
  if (branches.length !== ids.length) throw badRequest('One or more branches do not exist', 'INVALID_BRANCH');
  const restaurantIds = [...new Map(branches.map((b) => [String(b.restaurantId), b.restaurantId])).values()];
  return { branchIds: branches.map((b) => b._id), restaurantIds };
}

async function getRestaurantAdminOr404(id: string) {
  // Super Admin accounts are deliberately invisible to these endpoints.
  const u = await UserModel.findOne({ _id: toObjectId(id, 'user'), role: { $in: STAFF_ROLES } });
  if (!u) throw notFound('Restaurant Admin');
  return u;
}

/** Audit wording per account type. */
const accountKind = (role: string) =>
  role === 'KITCHEN'
    ? { action: 'KITCHEN_LOGIN', label: 'Kitchen login' }
    : role === 'WAITER'
      ? { action: 'WAITER_LOGIN', label: 'Waiter login' }
      : { action: 'RESTAURANT_ADMIN', label: 'Restaurant Admin' };

export async function listRestaurantAdmins(query: { restaurantId?: unknown; status?: unknown }) {
  const filter: Record<string, unknown> = { role: { $in: STAFF_ROLES } };
  if (query.restaurantId) filter.restaurantIds = toObjectId(query.restaurantId, 'restaurant');
  if (query.status === 'ACTIVE' || query.status === 'INACTIVE') filter.status = query.status;
  const users = await UserModel.find(filter).sort({ name: 1 }).lean<AuthUser[]>();
  return users.map(toUserDTO);
}

/** A Kitchen login's counter: one of its branch's counters, or null for every counter. */
async function kitchenStationFor(role: string, branchId: Types.ObjectId, stationId: string | null | undefined) {
  if (!stationId) return null;
  if (role !== 'KITCHEN') throw badRequest('Only Kitchen logins work a kitchen counter', 'INVALID_STATION');
  const id = toObjectId(stationId, 'counter');
  if (!(await BranchModel.exists({ _id: branchId, 'kitchenStations._id': id }))) throw badRequest('This counter is not in the chosen restaurant', 'INVALID_STATION');
  return id;
}

export async function createRestaurantAdmin(actor: AuthUser, input: UserCreateInput) {
  if (await UserModel.exists({ email: input.email })) throw conflict('This email is already in use', 'DUPLICATE');
  const assignments = await resolveAssignments(input.branchIds);
  const user = await UserModel.create({
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    ...assignments,
    kitchenStationId: await kitchenStationFor(input.role, assignments.branchIds[0], input.kitchenStationId),
  });
  await audit(actor, {
    action: `${accountKind(input.role).action}_CREATED`,
    entityType: 'User',
    entityId: user._id,
    restaurantId: assignments.restaurantIds[0] ?? null,
    summary: `Created ${accountKind(input.role).label} ${user.email}`,
    meta: { branchIds: assignments.branchIds.map(String) },
  });
  return toUserDTO(user.toObject() as unknown as AuthUser);
}

export async function updateRestaurantAdmin(actor: AuthUser, id: string, input: UserUpdateInput) {
  const user = await getRestaurantAdminOr404(id);
  const before = user.branchIds.map(String);
  if (input.name) user.name = input.name;
  if (input.branchIds) {
    const a = await resolveAssignments(input.branchIds);
    user.branchIds = a.branchIds as typeof user.branchIds;
    user.restaurantIds = a.restaurantIds as typeof user.restaurantIds;
  }
  if (input.kitchenStationId !== undefined) {
    user.kitchenStationId = await kitchenStationFor(user.role, user.branchIds[0], input.kitchenStationId);
  } else if (input.branchIds && user.kitchenStationId) {
    // Moving to another restaurant drops a counter that is not there.
    if (!(await BranchModel.exists({ _id: user.branchIds[0], 'kitchenStations._id': user.kitchenStationId }))) user.kitchenStationId = null;
  }
  await user.save();
  await audit(actor, {
    action: `${accountKind(user.role).action}_${input.branchIds ? 'REASSIGNED' : 'UPDATED'}`,
    entityType: 'User',
    entityId: user._id,
    summary: `Updated ${accountKind(user.role).label} ${user.email}`,
    meta: { before, after: user.branchIds.map(String) },
  });
  return toUserDTO(user.toObject() as unknown as AuthUser);
}

export async function setRestaurantAdminStatus(actor: AuthUser, id: string, status: RecordStatus) {
  const user = await getRestaurantAdminOr404(id);
  user.status = status;
  if (status === 'INACTIVE') user.tokenVersion += 1; // sign out everywhere
  await user.save();
  await audit(actor, {
    action: `${accountKind(user.role).action}_${status === 'ACTIVE' ? 'ACTIVATED' : 'DEACTIVATED'}`,
    entityType: 'User',
    entityId: user._id,
    summary: `${status === 'ACTIVE' ? 'Activated' : 'Deactivated'} ${accountKind(user.role).label} ${user.email}`,
  });
  return toUserDTO(user.toObject() as unknown as AuthUser);
}

export async function resetRestaurantAdminPassword(actor: AuthUser, id: string, password: string) {
  const user = await getRestaurantAdminOr404(id);
  user.passwordHash = await hashPassword(password);
  user.tokenVersion += 1;
  user.set({ loginFails: 0, loginFailsSince: null, lockedUntil: null }); // a new password lifts a lock
  await user.save();
  await audit(actor, {
    action: `${accountKind(user.role).action}_PASSWORD_RESET`,
    entityType: 'User',
    entityId: user._id,
    summary: `Reset password of ${user.email}`,
  });
  return toUserDTO(user.toObject() as unknown as AuthUser);
}
