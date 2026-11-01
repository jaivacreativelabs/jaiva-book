/** Mongo documents → API DTOs (see shared/src/types.ts). */
import type { Types } from 'mongoose';
import { BILL_EDIT_WINDOW_MINUTES } from '@rb/shared';
import type {
  AuditLogDTO,
  BranchDTO,
  CategoryDTO,
  DraftDTO,
  MenuItemDTO,
  RecordStatus,
  RestaurantDTO,
  TransactionDTO,
  UserDTO,
} from '@rb/shared';
import type { AuthUser } from '../middleware/auth.js';
import type { BranchLean, RestaurantLean } from '../middleware/scope.js';
import type { AuditLog, Category, Draft, MenuItem, Transaction } from '../models/index.js';

type WithId<T> = T & { _id: Types.ObjectId; createdAt?: Date; updatedAt?: Date };

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const sameId = (a: Types.ObjectId | null | undefined, b: Types.ObjectId | null | undefined) =>
  a == null || b == null ? a == null && b == null : a.equals(b);

export function toUserDTO(u: AuthUser): UserDTO {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    restaurantIds: u.restaurantIds.map(String),
    branchIds: u.branchIds.map(String),
    lastLoginAt: iso(u.lastLoginAt),
    createdAt: iso(u.createdAt) ?? '',
  };
}

export function restaurantSettings(r: RestaurantLean): RestaurantDTO['settings'] {
  return {
    taxes: (r.settings?.taxes ?? []).map((t) => ({ name: t.name, rateBps: t.rateBps })),
    pricesIncludeTax: Boolean(r.settings?.pricesIncludeTax),
    receiptFooter: r.settings?.receiptFooter ?? '',
  };
}

export function toRestaurantDTO(r: RestaurantLean & { createdAt?: Date }, branchCount?: number): RestaurantDTO {
  return {
    id: String(r._id),
    name: r.name,
    phone: r.phone ?? '',
    email: r.email ?? '',
    address: r.address ?? '',
    gstin: r.gstin ?? '',
    logoUrl: r.logoUrl ?? null,
    status: r.status,
    settings: restaurantSettings(r),
    ...(branchCount !== undefined && { branchCount }),
    createdAt: iso(r.createdAt) ?? '',
  };
}

export function toBranchDTO(b: BranchLean & { createdAt?: Date }): BranchDTO {
  return {
    id: String(b._id),
    restaurantId: String(b.restaurantId),
    name: b.name,
    code: b.code,
    address: b.address ?? '',
    phone: b.phone ?? '',
    email: b.email ?? '',
    status: b.status,
    kitchenDisplay: b.kitchenDisplay ?? false,
    createdAt: iso(b.createdAt) ?? '',
  };
}

/**
 * A category as a branch sees it: the branch's own name, icon, on/off and position win. A branch's
 * own categories come after the shared ones until the branch reorders its list.
 */
export function effectiveCategory(c: WithId<Category>, branchId: Types.ObjectId | null) {
  const o = branchId ? c.branchOverrides?.find((x) => x.branchId.equals(branchId)) : undefined;
  const ownOffset = c.branchId && branchId ? 1000 : 0;
  return {
    name: o?.name ?? c.name,
    icon: o?.icon ?? c.icon ?? '',
    status: (o?.status ?? c.status) as RecordStatus,
    displayOrder: o?.displayOrder ?? ownOffset + (c.displayOrder ?? 0),
    deleted: Boolean(o?.deleted),
  };
}

export function toCategoryDTO(c: WithId<Category>, scopeBranchId: Types.ObjectId | null): CategoryDTO {
  const eff = effectiveCategory(c, scopeBranchId);
  const isShared = !c.branchId && scopeBranchId !== null;
  return {
    id: String(c._id),
    restaurantId: String(c.restaurantId),
    branchId: c.branchId ? String(c.branchId) : null,
    name: eff.name,
    icon: eff.icon,
    displayOrder: eff.displayOrder,
    status: eff.status,
    editable: sameId(c.branchId, scopeBranchId) || isShared,
    isShared,
  };
}

/** "Idly (Full, 2 pcs)" – what bills, receipts and the kitchen show. */
export const variantFullName = (dish: string, variant: string, qty = '') => `${dish} (${variant}${qty ? `, ${qty}` : ''})`;

/**
 * An item as seen from a branch (overrides applied). Pass a variant's dish so the variant follows
 * the branch's own name and category for it, and leaves the branch's menu with it.
 */
export function effectiveItem(item: WithId<MenuItem>, branchId: Types.ObjectId | null, dish?: WithId<MenuItem>) {
  const override = branchId ? item.branchOverrides?.find((o) => o.branchId.equals(branchId)) : undefined;
  const dishOverride = dish && branchId ? dish.branchOverrides?.find((o) => o.branchId.equals(branchId)) : undefined;
  const name = override?.name
    ?? (dishOverride?.name ? variantFullName(dishOverride.name, item.variantName ?? '', item.variantQty ?? '') : item.name);
  const categoryId = override?.categoryId ?? dishOverride?.categoryId ?? item.categoryId;
  const price = override?.price ?? item.price;
  const isAvailable = override?.isAvailable ?? item.isAvailable;
  const imageUrl = override?.imageUrl ?? item.imageUrl ?? null;
  // A branch's own GST % wins; null keeps the item's (or the restaurant's) taxes.
  const taxRateBps = override?.taxRateBps ?? item.taxRateBps ?? null;
  const taxable = override?.taxRateBps != null ? override.taxRateBps > 0 : item.taxable;
  const extraTaxes = (override?.extraTaxes ?? item.extraTaxes ?? []).map((t) => ({ name: t.name, rateBps: t.rateBps }));
  return {
    name,
    description: override?.description ?? item.description ?? '',
    categoryId,
    price,
    isAvailable,
    imageUrl,
    taxRateBps,
    taxable,
    extraTaxes,
    pinned: Boolean(override?.pinned),
    displayOrder: override?.displayOrder ?? item.displayOrder ?? 0,
    hidden: Boolean(override?.hidden || dishOverride?.hidden),
    hasOverride: override?.price != null || override?.isAvailable != null,
    imageOverridden: override?.imageUrl != null,
  };
}

export function toMenuItemDTO(item: WithId<MenuItem>, scopeBranchId: Types.ObjectId | null): MenuItemDTO {
  const eff = effectiveItem(item, scopeBranchId);
  const owned = sameId(item.branchId, scopeBranchId);
  return {
    id: String(item._id),
    restaurantId: String(item.restaurantId),
    branchId: item.branchId ? String(item.branchId) : null,
    categoryId: String(eff.categoryId),
    name: eff.name,
    description: eff.description,
    imageUrl: eff.imageUrl,
    imageOverridden: eff.imageOverridden,
    pinned: eff.pinned,
    displayOrder: eff.displayOrder,
    price: eff.price,
    basePrice: item.price,
    taxable: eff.taxable,
    taxRateBps: eff.taxRateBps,
    extraTaxes: eff.extraTaxes,
    isAvailable: eff.isAvailable,
    status: item.status,
    isShared: !item.branchId && scopeBranchId !== null,
    hasOverride: eff.hasOverride,
    // A branch manages a main-menu item too, for itself only (stored as its override).
    editable: owned || (!item.branchId && scopeBranchId !== null),
    parentId: item.parentId ? String(item.parentId) : null,
    variantName: item.variantName ?? '',
    variantQty: item.variantQty ?? '',
  };
}

export function toDraftDTO(d: WithId<Draft>, tableLabel = ''): DraftDTO {
  return {
    id: String(d._id),
    restaurantId: String(d.restaurantId),
    branchId: String(d.branchId),
    type: d.type,
    tableId: d.tableId ? String(d.tableId) : null,
    tableLabel,
    groupName: d.groupName ?? '',
    guestCount: d.guestCount ?? 0,
    groupTag: d.groupTag ?? '',
    customerName: d.customerName ?? '',
    items: (d.items ?? []).map((i) => ({
      menuItemId: String(i.menuItemId),
      name: i.name,
      imageUrl: i.imageUrl ?? null,
      unitPrice: i.unitPrice,
      taxable: i.taxable,
      taxRateBps: i.taxRateBps ?? null,
      extraTaxes: (i.extraTaxes ?? []).map((t) => ({ name: t.name ?? '', rateBps: t.rateBps ?? 0 })),
      quantity: i.quantity,
      unavailable: Boolean(i.unavailable),
      note: i.note ?? '',
    })),
    discount: d.discount?.type ? { type: d.discount.type, value: d.discount.value ?? 0 } : null,
    totals: {
      subtotal: d.totals?.subtotal ?? 0,
      discountAmount: d.totals?.discountAmount ?? 0,
      taxes: (d.totals?.taxes ?? []).map((t) => ({ name: t.name ?? '', rateBps: t.rateBps ?? 0, amount: t.amount ?? 0, ...(t.base != null && { base: t.base }) })),
      taxTotal: d.totals?.taxTotal ?? 0,
      grandTotal: d.totals?.grandTotal ?? 0,
    },
    status: d.status,
    version: d.version,
    transactionId: d.transactionId ? String(d.transactionId) : null,
    kitchenSent: (d.kitchenSent ?? []).map((s) => ({ menuItemId: String(s.menuItemId), quantity: s.quantity })),
    updatedAt: iso(d.updatedAt) ?? '',
    updatedByName: d.updatedByName ?? '',
  };
}

export function toTransactionDTO(t: WithId<Transaction>): TransactionDTO {
  const rs = t.restaurantSnapshot ?? {};
  const bs = t.branchSnapshot ?? {};
  return {
    id: String(t._id),
    billNumber: t.billNumber,
    restaurantId: String(t.restaurantId),
    branchId: String(t.branchId),
    tableId: t.tableId ? String(t.tableId) : null,
    tableLabel: t.tableLabel ?? '',
    type: t.type,
    orderType: t.orderType ?? (t.type === 'TABLE' ? 'DINE_IN' : 'TAKEAWAY'),
    manual: t.manual ?? false,
    groupName: t.groupName ?? '',
    guestCount: t.guestCount ?? 0,
    customerName: t.customerName ?? '',
    restaurantSnapshot: {
      name: rs.name ?? '',
      address: rs.address ?? '',
      phone: rs.phone ?? '',
      gstin: rs.gstin ?? '',
      receiptFooter: rs.receiptFooter ?? '',
      logoUrl: rs.logoUrl ?? '',
    },
    branchSnapshot: { name: bs.name ?? '', code: bs.code ?? '', address: bs.address ?? '', phone: bs.phone ?? '' },
    items: t.items.map((i) => ({
      menuItemId: String(i.menuItemId),
      name: i.name,
      categoryName: i.categoryName ?? '',
      imageUrl: i.imageUrl ?? null,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      taxable: i.taxable,
      taxRateBps: i.taxRateBps ?? null,
      extraTaxes: (i.extraTaxes ?? []).map((t) => ({ name: t.name ?? '', rateBps: t.rateBps ?? 0 })),
      lineTotal: i.lineTotal,
    })),
    itemCount: t.items.reduce((a, i) => a + i.quantity, 0),
    subtotal: t.subtotal,
    discount: t.discount?.type
      ? { type: t.discount.type, value: t.discount.value ?? 0, amount: t.discount.amount ?? 0 }
      : null,
    taxes: (t.taxes ?? []).map((x) => ({ name: x.name ?? '', rateBps: x.rateBps ?? 0, amount: x.amount ?? 0, ...(x.base != null && { base: x.base }) })),
    taxTotal: t.taxTotal,
    grandTotal: t.grandTotal,
    pricesIncludeTax: Boolean(t.pricesIncludeTax),
    paymentMethod: t.paymentMethod,
    payments: t.payments?.length ? t.payments.map((p) => ({ method: p.method, amount: p.amount })) : [{ method: t.paymentMethod, amount: t.grandTotal }],
    paymentStatus: t.paymentStatus,
    status: t.status,
    statusChange: t.statusChange?.at
      ? { at: iso(t.statusChange.at) ?? '', byName: t.statusChange.byName ?? '', reason: t.statusChange.reason ?? '' }
      : null,
    createdByName: t.createdByName ?? '',
    finalizedAt: iso(t.finalizedAt) ?? '',
    editCount: t.editCount ?? 0,
    editedAt: iso(t.editedAt),
    editedByName: t.editedByName ?? '',
    editableUntil: editableUntil(t),
  };
}

/** End of the edit window for a paid bill, or null when it can no longer be edited. */
export function editableUntil(t: Pick<Transaction, 'status' | 'finalizedAt' | 'manual'>, now = Date.now()): string | null {
  if (t.status !== 'COMPLETED' || !t.finalizedAt || t.manual) return null;
  const until = new Date(t.finalizedAt).getTime() + BILL_EDIT_WINDOW_MINUTES * 60_000;
  return until > now ? new Date(until).toISOString() : null;
}

export function toAuditLogDTO(a: WithId<AuditLog>): AuditLogDTO {
  return {
    id: String(a._id),
    actorName: a.actorName ?? '',
    actorRole: a.actorRole as AuditLogDTO['actorRole'],
    restaurantId: a.restaurantId ? String(a.restaurantId) : null,
    branchId: a.branchId ? String(a.branchId) : null,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    summary: a.summary ?? '',
    createdAt: iso(a.createdAt) ?? '',
  };
}
