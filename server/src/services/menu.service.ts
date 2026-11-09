/**
 * Menu management. Scope rules:
 *  - Restaurant scope (Super Admin, branch = null): manages the shared menu.
 *  - Branch scope: sees shared + branch-only entries. Branch-only entries are fully editable;
 *    a shared item can be changed and removed too, for that branch only (stored as its override).
 */
import type { Types } from 'mongoose';
import type { CategoryCreateInput, MenuItemCreateInput, MenuItemUpdateInput, RecordStatus, VariantsInput } from '@rb/shared';
import type { AuthUser } from '../middleware/auth.js';
import type { Scope } from '../middleware/scope.js';
import { CategoryModel, MenuItemModel, type Category, type MenuItem } from '../models/index.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { effectiveCategory, effectiveItem, toCategoryDTO, toMenuItemDTO, variantFullName } from '../utils/serialize.js';
import { escapeRegex, nameKey, toObjectId } from '../utils/validate.js';
import { audit } from './audit.service.js';
import { saveImage } from './storage.service.js';

type CategoryLean = Category & { _id: Types.ObjectId };
type MenuItemLean = MenuItem & { _id: Types.ObjectId };

const branchOf = (scope: Scope) => scope.branch?._id ?? null;

/** Filter for documents visible in the scope: shared ones plus the branch's own. */
function visibleFilter(scope: Scope) {
  const branchId = branchOf(scope);
  return { restaurantId: scope.restaurant._id, branchId: branchId ? { $in: [null, branchId] } : null };
}

/** Name clash rules: same scope, shared ↔ branch, and (for shared) any branch. */
function nameClashFilter(scope: Scope, key: string) {
  const branchId = branchOf(scope);
  return {
    restaurantId: scope.restaurant._id,
    nameKey: key,
    ...(branchId ? { branchId: { $in: [null, branchId] } } : {}),
  };
}

const owns = (scope: Scope, doc: { branchId?: Types.ObjectId | null }) => {
  const b = branchOf(scope);
  return b ? Boolean(doc.branchId?.equals(b)) : !doc.branchId;
};

function auditBase(scope: Scope) {
  return { restaurantId: scope.restaurant._id, branchId: branchOf(scope) };
}

// ---------------- Categories ----------------

export async function listCategories(scope: Scope, includeInactive: boolean) {
  const cats = await CategoryModel.find(visibleFilter(scope)).lean<CategoryLean[]>();
  const branchId = branchOf(scope);
  return cats
    .filter((c) => !effectiveCategory(c, branchId).deleted) // shared ones this branch deleted
    .map((c) => toCategoryDTO(c, branchId))
    .filter((c) => includeInactive || c.status === 'ACTIVE')
    .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
}

async function getVisibleCategory(scope: Scope, id: string) {
  const cat = await CategoryModel.findOne({ _id: toObjectId(id, 'category'), ...visibleFilter(scope) });
  if (!cat || effectiveCategory(cat.toObject() as CategoryLean, branchOf(scope)).deleted) throw notFound('Category');
  return cat;
}

/** Sets this branch's own name / icon / on-off / position for a category. */
function setCategoryOverride(
  cat: InstanceType<typeof CategoryModel>,
  branchId: Types.ObjectId,
  patch: { name?: string; icon?: string; status?: RecordStatus; displayOrder?: number; deleted?: boolean; taxRateBps?: number | null },
) {
  const existing = cat.branchOverrides.find((o) => o.branchId.equals(branchId));
  if (existing) existing.set(patch);
  else cat.branchOverrides.push({ branchId, name: null, icon: null, status: null, displayOrder: null, deleted: null, taxRateBps: null, ...patch });
}

/**
 * Deletes a category that has no dishes left. A branch's own one (or, for the Super Admin, a
 * main-menu one) is gone for good; a shared one deleted in a branch leaves that branch's menu only.
 */
export async function deleteCategory(actor: AuthUser, scope: Scope, id: string) {
  const cat = await getVisibleCategory(scope, id);
  const own = owns(scope, cat);
  const { name } = effectiveCategory(cat.toObject() as CategoryLean, branchOf(scope));
  const dishes = own
    ? // Anywhere: a branch may have moved a main-menu dish into it, or added its own dishes to it.
      await MenuItemModel.countDocuments({ status: 'ACTIVE', parentId: null, $or: [{ categoryId: cat._id }, { 'branchOverrides.categoryId': cat._id }] })
    : (await listItems(scope, {})).filter((i) => !i.parentId && i.categoryId === String(cat._id)).length;
  if (dishes) {
    throw conflict(
      `“${name}” still has ${dishes} dish${dishes === 1 ? '' : 'es'}. Move ${dishes === 1 ? 'it' : 'them'} to another category or remove ${dishes === 1 ? 'it' : 'them'} first.`,
      'CATEGORY_IN_USE',
    );
  }
  if (own) await CategoryModel.deleteOne({ _id: cat._id });
  else {
    setCategoryOverride(cat, branchOf(scope)!, { deleted: true });
    await cat.save();
  }
  await audit(actor, {
    ...auditBase(scope),
    action: 'CATEGORY_DELETED',
    entityType: 'Category',
    entityId: cat._id,
    summary: own ? `Deleted category "${name}"` : `Deleted shared category "${name}" from this branch's menu`,
  });
}

export async function createCategory(actor: AuthUser, scope: Scope, input: CategoryCreateInput) {
  const key = nameKey(input.name);
  // A shared category this branch deleted does not block the name.
  const clashes = await CategoryModel.find(nameClashFilter(scope, key)).lean<CategoryLean[]>();
  if (clashes.some((c) => !effectiveCategory(c, branchOf(scope)).deleted)) {
    throw conflict(`Category "${input.name}" already exists`, 'DUPLICATE');
  }
  const last = await CategoryModel.findOne({ restaurantId: scope.restaurant._id, branchId: branchOf(scope) })
    .sort({ displayOrder: -1 })
    .lean<CategoryLean>();
  const cat = await CategoryModel.create({
    restaurantId: scope.restaurant._id,
    branchId: branchOf(scope),
    name: input.name,
    nameKey: key,
    icon: input.icon ?? '',
    displayOrder: (last?.displayOrder ?? -1) + 1,
    taxRateBps: input.taxRateBps ?? null,
  });
  await audit(actor, {
    ...auditBase(scope),
    action: 'CATEGORY_CREATED',
    entityType: 'Category',
    entityId: cat._id,
    summary: `Created category "${cat.name}"`,
  });
  return toCategoryDTO(cat.toObject() as CategoryLean, branchOf(scope));
}

export async function updateCategory(actor: AuthUser, scope: Scope, id: string, input: Partial<CategoryCreateInput>) {
  const cat = await getVisibleCategory(scope, id);
  const branchId = branchOf(scope);
  const gstBefore = effectiveCategory(cat.toObject() as CategoryLean, branchId).taxRateBps;
  if (input.taxRateBps !== undefined) {
    if (owns(scope, cat)) cat.taxRateBps = input.taxRateBps;
    else setCategoryOverride(cat, branchId!, { taxRateBps: input.taxRateBps }); // this branch only
  }
  if (owns(scope, cat)) {
    if (input.name && nameKey(input.name) !== cat.nameKey) {
      const key = nameKey(input.name);
      if (await CategoryModel.exists({ ...nameClashFilter(scope, key), _id: { $ne: cat._id } })) {
        throw conflict(`Category "${input.name}" already exists`, 'DUPLICATE');
      }
      cat.name = input.name;
      cat.nameKey = key;
    }
    if (input.icon !== undefined) cat.icon = input.icon;
  } else {
    // A main-menu category renamed or given another icon in a branch: for that branch only.
    if (input.name) {
      const others = (await listCategories(scope, true)).filter((c) => c.id !== String(cat._id));
      if (others.some((c) => nameKey(c.name) === nameKey(input.name!))) throw conflict(`Category "${input.name}" already exists`, 'DUPLICATE');
    }
    setCategoryOverride(cat, branchId!, { ...(input.name && { name: input.name }), ...(input.icon !== undefined && { icon: input.icon }) });
  }
  await cat.save();
  await audit(actor, {
    ...auditBase(scope),
    action: 'CATEGORY_UPDATED',
    entityType: 'Category',
    entityId: cat._id,
    summary: `Updated category "${cat.name}"`,
  });
  // A new GST % for the category: every dish in it gets it, as if each one were edited (a dish
  // can be given its own afterwards). Clearing it leaves the dishes as they are.
  if (input.taxRateBps != null && input.taxRateBps !== gstBefore) {
    const dishes = (await listItems(scope, {})).filter((i) => !i.parentId && i.editable && i.categoryId === String(cat._id));
    for (const d of dishes) {
      if (d.taxRateBps !== input.taxRateBps) await updateItem(actor, scope, d.id, { taxRateBps: input.taxRateBps });
    }
  }
  return toCategoryDTO(cat.toObject() as CategoryLean, branchOf(scope));
}

export async function setCategoryStatus(actor: AuthUser, scope: Scope, id: string, status: RecordStatus) {
  const cat = await getVisibleCategory(scope, id);
  if (owns(scope, cat)) cat.status = status;
  else setCategoryOverride(cat, branchOf(scope)!, { status }); // this branch only
  await cat.save();
  await audit(actor, {
    ...auditBase(scope),
    action: status === 'ACTIVE' ? 'CATEGORY_ACTIVATED' : 'CATEGORY_DEACTIVATED',
    entityType: 'Category',
    entityId: cat._id,
    summary: `${status === 'ACTIVE' ? 'Activated' : 'Deactivated'} category "${cat.name}"`,
  });
  return toCategoryDTO(cat.toObject() as CategoryLean, branchOf(scope));
}

export async function reorderCategories(scope: Scope, ids: string[]) {
  const objectIds = ids.map((id) => toObjectId(id, 'category'));
  const branchId = branchOf(scope);
  if (!branchId) {
    const owned = await CategoryModel.countDocuments({ _id: { $in: objectIds }, restaurantId: scope.restaurant._id, branchId: null });
    if (owned !== objectIds.length) throw forbidden('Only categories of this menu can be reordered');
    await CategoryModel.bulkWrite(
      objectIds.map((_id, i) => ({ updateOne: { filter: { _id }, update: { $set: { displayOrder: i } } } })),
    );
    return listCategories(scope, true);
  }
  // A branch orders everything it sees (shared and its own) for itself only.
  const cats = await CategoryModel.find({ _id: { $in: objectIds }, ...visibleFilter(scope) });
  if (cats.length !== objectIds.length) throw forbidden('Only categories of this menu can be reordered');
  const position = new Map(objectIds.map((id, i) => [String(id), i]));
  for (const c of cats) {
    setCategoryOverride(c, branchId, { displayOrder: position.get(String(c._id))! });
    await c.save();
  }
  return listCategories(scope, true);
}

// ---------------- Items ----------------

export async function listItems(
  scope: Scope,
  query: { categoryId?: unknown; q?: unknown; includeArchived?: unknown },
) {
  const filter: Record<string, unknown> = { ...visibleFilter(scope) };
  if (query.includeArchived !== 'true') filter.status = 'ACTIVE';
  if (query.categoryId) filter.categoryId = toObjectId(query.categoryId, 'category');
  if (typeof query.q === 'string' && query.q.trim()) {
    filter.name = { $regex: escapeRegex(query.q.trim().slice(0, 50)), $options: 'i' };
  }
  const items = await MenuItemModel.find(filter).lean<MenuItemLean[]>();
  // Variants are taxed like their dish, including a branch's own GST for it.
  const dishes = new Map(items.map((i) => [String(i._id), i]));
  const missing = items.filter((i) => i.parentId && !dishes.has(String(i.parentId))).map((i) => i.parentId!);
  if (missing.length) {
    for (const d of await MenuItemModel.find({ _id: { $in: missing } }).lean<MenuItemLean[]>()) dishes.set(String(d._id), d);
  }
  // Pinned dishes first; Array.sort is stable, so the menu order is kept within each group.
  const branchId = branchOf(scope);
  const dishOf = (i: MenuItemLean) => (i.parentId ? dishes.get(String(i.parentId)) : undefined);
  return items
    .filter((i) => !effectiveItem(i, branchId, dishOf(i)).hidden) // main-menu dishes and variants this branch removed
    .map((i) => {
      const dto = toMenuItemDTO(i, branchId);
      const dish = dishOf(i);
      if (!dish) return dto;
      const { name, categoryId } = effectiveItem(i, branchId, dish);
      const { taxable, taxRateBps, extraTaxes } = effectiveItem(dish, branchId);
      return { ...dto, name, categoryId: String(categoryId), taxable, taxRateBps, extraTaxes };
    })
    // Pinned dishes first, then the menu's own order (the branch's, once it drags dishes around).
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
}

/**
 * Saves the order of the dishes (dragged into place on the Menu page). The main menu orders
 * its own dishes; a branch orders everything it sees, for itself only, like its categories.
 */
export async function reorderItems(scope: Scope, ids: string[]) {
  const objectIds = ids.map((id) => toObjectId(id, 'item'));
  const items = await MenuItemModel.find({ _id: { $in: objectIds }, parentId: null, ...visibleFilter(scope) })
    .select('branchId branchOverrides.branchId')
    .lean<Pick<MenuItemLean, '_id' | 'branchId' | 'branchOverrides'>[]>();
  if (items.length !== objectIds.length) throw forbidden('Only dishes of this menu can be reordered');
  const byId = new Map(items.map((i) => [String(i._id), i]));
  const branchId = branchOf(scope);
  const ops = objectIds.map((_id, displayOrder) => {
    const item = byId.get(String(_id))!;
    if (owns(scope, item)) return { updateOne: { filter: { _id }, update: { $set: { displayOrder } } } };
    // A main-menu dish: this branch's own position.
    return item.branchOverrides?.some((o) => o.branchId.equals(branchId!))
      ? { updateOne: { filter: { _id, 'branchOverrides.branchId': branchId }, update: { $set: { 'branchOverrides.$.displayOrder': displayOrder } } } }
      : { updateOne: { filter: { _id }, update: { $push: { branchOverrides: { branchId, displayOrder } } } } };
  });
  // Mongoose casts each update to the schema (the pushed override gets its defaults).
  await MenuItemModel.bulkWrite(ops as unknown as Parameters<typeof MenuItemModel.bulkWrite>[0]);
}

/** A new dish goes after everything this menu already shows. */
async function nextItemOrder(scope: Scope): Promise<number> {
  const items = await listItems(scope, {});
  return items.reduce((max, i) => Math.max(max, i.displayOrder), -1) + 1;
}

async function getVisibleItem(scope: Scope, id: string) {
  const item = await MenuItemModel.findOne({ _id: toObjectId(id, 'item'), ...visibleFilter(scope) });
  if (!item) throw notFound('Menu item');
  return item;
}

async function assertCategoryUsable(scope: Scope, categoryId: string) {
  const cat = await getVisibleCategory(scope, categoryId);
  if (effectiveCategory(cat.toObject() as CategoryLean, branchOf(scope)).status !== 'ACTIVE') {
    throw badRequest('This category is inactive', 'CATEGORY_INACTIVE');
  }
  // An item in the shared menu cannot point at a branch-only category.
  if (!branchOf(scope) && cat.branchId) throw badRequest('Choose a shared category');
  return cat;
}

/** Removed dishes and variants keep a unique key, so they never block a live name. */
const removedKey = (item: { name: string; _id: Types.ObjectId }) => `${nameKey(item.name)}#${String(item._id)}`;

async function assertItemNameFree(scope: Scope, name: string, exceptId?: Types.ObjectId) {
  const branchId = branchOf(scope);
  const clashes = await MenuItemModel.find({
    ...nameClashFilter(scope, nameKey(name)),
    ...(exceptId && { _id: { $ne: exceptId } }),
  }).lean<MenuItemLean[]>();
  for (const c of clashes) {
    if (c.status !== 'ACTIVE') {
      // Removed before removing freed the name: give it up now.
      await MenuItemModel.updateOne({ _id: c._id }, { $set: { nameKey: removedKey(c) } });
      if (!c.parentId) await syncVariantsWithDish(c);
      continue;
    }
    if (branchId && !owns(scope, c) && effectiveItem(c, branchId).hidden) continue; // removed from this branch's menu
    throw conflict(`An item named "${name}" already exists`, 'DUPLICATE');
  }
}

/** A main-menu dish renamed in a branch: no other dish this branch sees may have that name. */
async function assertBranchNameFree(scope: Scope, name: string, dishId: Types.ObjectId) {
  const others = (await listItems(scope, {})).filter((i) => i.id !== String(dishId) && i.parentId !== String(dishId));
  if (others.some((i) => nameKey(i.name) === nameKey(name))) throw conflict(`An item named "${name}" already exists`, 'DUPLICATE');
}

export async function createItem(actor: AuthUser, scope: Scope, input: MenuItemCreateInput) {
  const cat = await assertCategoryUsable(scope, input.categoryId);
  await assertItemNameFree(scope, input.name);
  // No GST given: the category's, if it has one.
  if (input.taxRateBps === undefined) {
    const gst = effectiveCategory(cat.toObject() as CategoryLean, branchOf(scope)).taxRateBps;
    if (gst != null) input = { ...input, taxRateBps: gst };
  }
  const item = await MenuItemModel.create({
    restaurantId: scope.restaurant._id,
    branchId: branchOf(scope),
    displayOrder: await nextItemOrder(scope),
    categoryId: toObjectId(input.categoryId),
    name: input.name,
    nameKey: nameKey(input.name),
    description: input.description ?? '',
    price: input.price,
    taxable: input.taxRateBps != null ? input.taxRateBps > 0 : (input.taxable ?? true),
    taxRateBps: input.taxRateBps ?? null,
    extraTaxes: input.extraTaxes ?? [],
    isAvailable: input.isAvailable ?? true,
  });
  await audit(actor, {
    ...auditBase(scope),
    action: 'MENU_ITEM_CREATED',
    entityType: 'MenuItem',
    entityId: item._id,
    summary: `Created item "${item.name}" at ${item.price} paise`,
  });
  return toMenuItemDTO(item.toObject() as MenuItemLean, branchOf(scope));
}

function setOverride(
  item: InstanceType<typeof MenuItemModel>,
  branchId: Types.ObjectId,
  patch: {
    price?: number;
    isAvailable?: boolean;
    imageUrl?: string;
    pinned?: boolean;
    hidden?: boolean;
    taxRateBps?: number | null;
    extraTaxes?: { name: string; rateBps: number }[];
    name?: string | null;
    description?: string | null;
    categoryId?: Types.ObjectId | null;
  },
) {
  const existing = item.branchOverrides.find((o) => o.branchId.equals(branchId));
  if (existing) {
    if (patch.name !== undefined) existing.name = patch.name;
    if (patch.description !== undefined) existing.description = patch.description;
    if (patch.categoryId !== undefined) existing.categoryId = patch.categoryId;
    if (patch.price !== undefined) existing.price = patch.price;
    if (patch.isAvailable !== undefined) existing.isAvailable = patch.isAvailable;
    if (patch.imageUrl !== undefined) existing.imageUrl = patch.imageUrl;
    if (patch.pinned !== undefined) existing.pinned = patch.pinned;
    if (patch.hidden !== undefined) existing.hidden = patch.hidden;
    if (patch.taxRateBps !== undefined) existing.taxRateBps = patch.taxRateBps;
    if (patch.extraTaxes !== undefined) existing.set('extraTaxes', patch.extraTaxes);
  } else {
    item.branchOverrides.push({
      branchId,
      price: patch.price ?? null,
      isAvailable: patch.isAvailable ?? null,
      imageUrl: patch.imageUrl ?? null,
      pinned: patch.pinned ?? null,
      hidden: patch.hidden ?? null,
      taxRateBps: patch.taxRateBps ?? null,
      ...(patch.extraTaxes && { extraTaxes: patch.extraTaxes }),
      name: patch.name ?? null,
      description: patch.description ?? null,
      categoryId: patch.categoryId ?? null,
    });
  }
}

/** Pins a dish to the top of this branch's menu and New Bill screen (any dish the branch sees). */
export async function setItemPinned(scope: Scope, id: string, pinned: boolean) {
  const branchId = branchOf(scope);
  if (!branchId) throw badRequest('Choose a restaurant to pin dishes');
  const item = await getVisibleItem(scope, id);
  setOverride(item, branchId, { pinned });
  await item.save();
  return toMenuItemDTO(item.toObject() as MenuItemLean, branchId);
}

export async function updateItem(actor: AuthUser, scope: Scope, id: string, input: MenuItemUpdateInput) {
  const item = await getVisibleItem(scope, id);
  const before = { name: item.name, price: item.price, isAvailable: item.isAvailable };
  const branchId = branchOf(scope);

  if (owns(scope, item)) {
    if (input.categoryId && !item.categoryId.equals(input.categoryId)) await assertCategoryUsable(scope, input.categoryId);
    if (input.name && nameKey(input.name) !== item.nameKey) {
      await assertItemNameFree(scope, input.name, item._id);
      item.nameKey = nameKey(input.name);
    }
    item.set({
      ...input,
      ...(input.categoryId && { categoryId: toObjectId(input.categoryId) }),
      // An own GST % decides whether the item is taxed at all.
      ...(input.taxRateBps != null && { taxable: input.taxRateBps > 0 }),
    });
  } else {
    // A main-menu item changed in a branch: for that branch only. A value equal to the main
    // menu's clears the branch's own one, so later main-menu changes show again.
    const { taxable: _derived, name, description, categoryId, ...patch } = input; // taxable follows the GST %
    const eff = effectiveItem(item.toObject() as MenuItemLean, branchId);
    if (name !== undefined && nameKey(name) !== nameKey(eff.name)) await assertBranchNameFree(scope, name, item._id);
    if (categoryId !== undefined && !eff.categoryId.equals(categoryId)) await assertCategoryUsable(scope, categoryId);
    setOverride(item, branchId!, {
      ...patch,
      ...(name !== undefined && { name: name === item.name ? null : name }),
      ...(description !== undefined && { description: description === item.description ? null : description }),
      ...(categoryId !== undefined && { categoryId: item.categoryId.equals(categoryId) ? null : toObjectId(categoryId) }),
    });
  }
  await item.save();
  if (owns(scope, item)) await syncVariantsWithDish(item.toObject() as MenuItemLean);
  await audit(actor, {
    ...auditBase(scope),
    action: owns(scope, item) ? 'MENU_ITEM_UPDATED' : 'MENU_ITEM_OVERRIDE_SET',
    entityType: 'MenuItem',
    entityId: item._id,
    summary: `Updated item "${item.name}"`,
    meta: { before, changes: input },
  });
  return toMenuItemDTO(item.toObject() as MenuItemLean, branchId);
}

export async function setItemAvailability(actor: AuthUser, scope: Scope, id: string, isAvailable: boolean) {
  return updateItem(actor, scope, id, { isAvailable });
}

/** Drops this branch's price/availability override; a branch photo is kept. */
export async function removeOverride(actor: AuthUser, scope: Scope, id: string) {
  const branchId = branchOf(scope);
  if (!branchId) throw badRequest('Overrides exist only for branches');
  const item = await getVisibleItem(scope, id);
  const existing = item.branchOverrides.find((o) => o.branchId.equals(branchId));
  // "Use main menu price" resets price and availability; the photo, pin, removal and taxes stay.
  if (existing?.imageUrl || existing?.pinned || existing?.hidden || existing?.taxRateBps != null || existing?.extraTaxes) {
    existing.price = null;
    existing.isAvailable = null;
  } else {
    item.set(
      'branchOverrides',
      item.branchOverrides.filter((o) => !o.branchId.equals(branchId)),
    );
  }
  await item.save();
  await audit(actor, {
    ...auditBase(scope),
    action: 'MENU_ITEM_OVERRIDE_REMOVED',
    entityType: 'MenuItem',
    entityId: item._id,
    summary: `Reset "${item.name}" to the shared price/availability`,
  });
  return toMenuItemDTO(item.toObject() as MenuItemLean, branchId);
}

/**
 * Sets the photo. For a shared item seen from a branch, the photo is stored as that branch's
 * override, so other branches keep the main-menu photo.
 */
export async function setItemImage(actor: AuthUser, scope: Scope, id: string, file: Express.Multer.File | undefined) {
  if (!file) throw badRequest('Choose an image file', 'NO_FILE');
  const item = await getVisibleItem(scope, id);
  const branchPhoto = !owns(scope, item);
  // Old files are kept: completed bills may still reference them in their snapshots.
  const url = await saveImage(file.buffer);
  if (branchPhoto) setOverride(item, branchOf(scope)!, { imageUrl: url });
  else item.imageUrl = url;
  await item.save();
  await audit(actor, {
    ...auditBase(scope),
    action: branchPhoto ? 'MENU_ITEM_BRANCH_IMAGE_SET' : 'MENU_ITEM_IMAGE_UPDATED',
    entityType: 'MenuItem',
    entityId: item._id,
    summary: `${branchPhoto ? 'Set branch photo of' : 'Updated image of'} "${item.name}"`,
  });
  return toMenuItemDTO(item.toObject() as MenuItemLean, branchOf(scope));
}

/** Removes the photo; for a shared item in a branch this restores the main-menu photo. */
export async function removeItemImage(actor: AuthUser, scope: Scope, id: string) {
  const item = await getVisibleItem(scope, id);
  const branchPhoto = !owns(scope, item);
  if (branchPhoto) {
    const branchId = branchOf(scope)!;
    const existing = item.branchOverrides.find((o) => o.branchId.equals(branchId));
    if (existing) existing.imageUrl = null;
  } else {
    item.imageUrl = null;
  }
  await item.save();
  await audit(actor, {
    ...auditBase(scope),
    action: branchPhoto ? 'MENU_ITEM_BRANCH_IMAGE_REMOVED' : 'MENU_ITEM_IMAGE_REMOVED',
    entityType: 'MenuItem',
    entityId: item._id,
    summary: `${branchPhoto ? 'Removed branch photo of' : 'Removed image of'} "${item.name}"`,
  });
  return toMenuItemDTO(item.toObject() as MenuItemLean, branchOf(scope));
}

export async function setItemArchived(actor: AuthUser, scope: Scope, id: string, archived: boolean) {
  const item = await getVisibleItem(scope, id);
  const own = owns(scope, item);
  // A main-menu item removed in a branch leaves that branch's menu only.
  if (own) {
    if (!archived && item.status !== 'ACTIVE') await assertItemNameFree(scope, item.name, item._id);
    item.status = archived ? 'ARCHIVED' : 'ACTIVE';
    // A removed dish gives its name up, so a new dish can be added under it.
    item.nameKey = archived ? removedKey(item) : nameKey(item.name);
  } else {
    if (!archived) await assertBranchNameFree(scope, effectiveItem(item.toObject() as MenuItemLean, branchOf(scope)).name, item._id);
    setOverride(item, branchOf(scope)!, { hidden: archived });
  }
  await item.save();
  if (own && !item.parentId) await syncVariantsWithDish(item.toObject() as MenuItemLean);
  await audit(actor, {
    ...auditBase(scope),
    action: archived ? 'MENU_ITEM_ARCHIVED' : 'MENU_ITEM_RESTORED',
    entityType: 'MenuItem',
    entityId: item._id,
    summary: `${archived ? 'Archived' : 'Restored'} item "${item.name}"`,
  });
  return toMenuItemDTO(item.toObject() as MenuItemLean, branchOf(scope));
}

// ---------------- Variants ----------------

/** Variants follow their dish's name, category and tax setting. */
async function syncVariantsWithDish(dish: MenuItemLean) {
  const variants = await MenuItemModel.find({ parentId: dish._id })
    .select('variantName variantQty status')
    .lean<{ _id: Types.ObjectId; variantName: string; variantQty?: string; status: string }[]>();
  if (!variants.length) return;
  try {
    await MenuItemModel.bulkWrite(
      variants.map((v) => {
        const name = variantFullName(dish.name, v.variantName, v.variantQty);
        // Removed variants keep a unique key so they never block a live name.
        const key = v.status === 'ACTIVE' && dish.status === 'ACTIVE' ? nameKey(name) : `${nameKey(name)}#${String(v._id)}`;
        return {
          updateOne: {
            filter: { _id: v._id },
            update: { $set: { name, nameKey: key, categoryId: dish.categoryId, taxable: dish.taxable, taxRateBps: dish.taxRateBps ?? null, extraTaxes: dish.extraTaxes ?? [] } },
          },
        };
      }),
    );
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('Another dish already has the name one of these variants would get. Rename it first.', 'DUPLICATE');
    throw err;
  }
}

/**
 * Saves the variants a menu sees for a dish. The main menu manages the shared variants. A branch
 * can change everything for itself only: its own variants are added, renamed and removed; a
 * main-menu variant gets a branch price, is hidden when removed, and is replaced by a branch copy
 * when its name or quantity changes. Other branches and the main menu are not affected.
 */
export async function setItemVariants(actor: AuthUser, scope: Scope, id: string, input: VariantsInput) {
  const dish = await getVisibleItem(scope, id);
  if (dish.parentId) throw badRequest('A variant cannot have variants of its own');
  const branchId = branchOf(scope);
  const existing = await MenuItemModel.find({ parentId: dish._id, ...visibleFilter(scope) });
  const byId = new Map(existing.map((v) => [String(v._id), v]));
  for (const row of input.variants) {
    if (row.id && !byId.has(row.id)) throw badRequest(`“${row.name}” is not a variant of ${dish.name}`);
  }
  const keep = new Set(input.variants.filter((r) => r.id).map((r) => r.id!));

  try {
    for (const v of existing) {
      if (v.status !== 'ACTIVE' || keep.has(String(v._id))) continue;
      if (owns(scope, v)) {
        v.status = 'ARCHIVED';
        // Frees the name, so a removed variant can be added again later.
        v.nameKey = `${v.nameKey}#${String(v._id)}`;
      } else {
        setOverride(v, branchId!, { hidden: true }); // removed from this branch's menu only
      }
      await v.save();
    }
    for (const row of input.variants) {
      let v = row.id ? byId.get(row.id)! : null;
      if (v && !owns(scope, v)) {
        if (row.name === v.variantName && (row.qty ?? '') === (v.variantQty ?? '')) {
          // Same main-menu variant: this branch's own price.
          setOverride(v, branchId!, { price: row.price, hidden: false, ...(row.isAvailable !== undefined && { isAvailable: row.isAvailable }) });
          await v.save();
          continue;
        }
        // Renamed here: hide the main-menu one in this branch and add the branch's own instead.
        setOverride(v, branchId!, { hidden: true });
        await v.save();
        v = null;
      }
      const name = variantFullName(dish.name, row.name, row.qty);
      const fields = { variantName: row.name, variantQty: row.qty ?? '', name, nameKey: nameKey(name), price: row.price, status: 'ACTIVE' as const };
      if (v) {
        v.set({ ...fields, ...(row.isAvailable !== undefined && { isAvailable: row.isAvailable }) });
        await v.save();
      } else {
        await MenuItemModel.create({
          ...fields,
          restaurantId: dish.restaurantId,
          branchId,
          categoryId: dish.categoryId,
          taxable: dish.taxable,
          taxRateBps: dish.taxRateBps ?? null,
          extraTaxes: dish.extraTaxes ?? [],
          isAvailable: row.isAvailable ?? true,
          parentId: dish._id,
        });
      }
    }
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('A dish with one of these names already exists. Use another variant name.', 'DUPLICATE');
    throw err;
  }
  // The dish shows its lowest price ("from ₹…") in lists and reports.
  if (owns(scope, dish) && input.variants.length) {
    dish.price = Math.min(...input.variants.map((r) => r.price));
    await dish.save();
  }

  await audit(actor, {
    ...auditBase(scope),
    action: 'MENU_ITEM_VARIANTS_SET',
    entityType: 'MenuItem',
    entityId: dish._id,
    summary: `Variants of "${dish.name}"${branchId ? ' (this branch)' : ''}: ${input.variants.map((r) => `${r.name} ${r.price} paise`).join(', ') || 'none'}`,
  });
  const variants = await MenuItemModel.find({ parentId: dish._id, status: 'ACTIVE', ...visibleFilter(scope) })
    .sort({ price: 1 })
    .lean<MenuItemLean[]>();
  return variants.filter((v) => !effectiveItem(v, branchId).hidden).map((v) => toMenuItemDTO(v, branchId));
}
