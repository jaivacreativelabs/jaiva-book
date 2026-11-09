import type { Types } from 'mongoose';
import {
  KITCHEN_BOARD_STATUSES,
  kitchenPending,
  type KitchenStatus,
  type TableCreateInput,
  type TableDTO,
  type TableOccupancy,
  type TablesResponseDTO,
} from '@rb/shared';
import type { AuthUser } from '../middleware/auth.js';
import type { BranchScope } from '../middleware/scope.js';
import { DraftModel, KitchenTicketModel, TableModel, type Draft, type Table } from '../models/index.js';
import { conflict, notFound } from '../utils/errors.js';
import { assertAdmin } from '../utils/roles.js';
import { nameKey, toObjectId } from '../utils/validate.js';
import { audit } from './audit.service.js';

type TableLean = Table & { _id: Types.ObjectId };
type DraftLean = Draft & { _id: Types.ObjectId };
type BoardStatus = (typeof KITCHEN_BOARD_STATUSES)[number];

const sentQty = (rows: { menuItemId: Types.ObjectId; quantity: number }[]) => rows.map((r) => ({ menuItemId: String(r.menuItemId), quantity: r.quantity }));

/** Each group's food still in the kitchen, by the status that matters most to a waiter: Ready, then Preparing, then sent. */
const KITCHEN_RANK: Record<BoardStatus, number> = { NEW: 1, PREPARING: 2, READY: 3 };
type Kitchen = { status: Map<string, BoardStatus>; served: Map<string, Map<string, number>>; started: Map<string, Map<string, number>> };
const addTo = (byDraft: Map<string, Map<string, number>>, key: string, items: { menuItemId: Types.ObjectId; quantity: number }[]) => {
  if (!items.length) return;
  const dishes = byDraft.get(key) ?? new Map<string, number>();
  for (const i of items) dishes.set(String(i.menuItemId), (dishes.get(String(i.menuItemId)) ?? 0) + i.quantity);
  byDraft.set(key, dishes);
};
const asQty = (dishes?: Map<string, number>) => [...(dishes ?? [])].map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
/**
 * Per group: its kitchen status, the portions of each dish already served (or handed over), and
 * the portions the kitchen has started (a waiter can still change the rest).
 */
async function kitchenByDraft(drafts: DraftLean[]): Promise<Kitchen> {
  const out: Kitchen = { status: new Map(), served: new Map(), started: new Map() };
  if (!drafts.length) return out;
  const tickets = await KitchenTicketModel.find({ draftId: { $in: drafts.map((d) => d._id) }, status: { $in: [...KITCHEN_BOARD_STATUSES, 'SERVED'] } })
    .select('draftId status items.menuItemId items.quantity items.served')
    .lean<{ draftId: Types.ObjectId; status: KitchenStatus; items: { menuItemId: Types.ObjectId; quantity: number; served?: boolean }[] }[]>();
  for (const t of tickets) {
    const key = String(t.draftId);
    // Served: the whole ticket, or the dishes a waiter took early while the rest was still cooking.
    addTo(out.served, key, t.status === 'SERVED' ? t.items : t.items.filter((i) => i.served));
    if (t.status !== 'NEW') addTo(out.started, key, t.items);
    if (t.status === 'SERVED') continue;
    const status = t.status as BoardStatus;
    const prev = out.status.get(key);
    if (!prev || KITCHEN_RANK[status] > KITCHEN_RANK[prev]) out.status.set(key, status);
  }
  return out;
}

export function occupancyOf(table: Pick<Table, 'seats' | 'status'>, seatsUsed: number): TableOccupancy {
  if (table.status === 'RESERVED' && seatsUsed === 0) return 'RESERVED';
  if (seatsUsed >= table.seats) return 'FULL';
  return seatsUsed > 0 ? 'PARTIAL' : 'AVAILABLE';
}

export function toTableDTO(t: TableLean, drafts: DraftLean[], kitchen?: Kitchen): TableDTO {
  const groups = drafts
    .sort((a, b) => a.groupName.localeCompare(b.groupName, undefined, { numeric: true }))
    .map((d) => ({
      draftId: String(d._id),
      groupName: d.groupName,
      guestCount: d.guestCount,
      groupTag: d.groupTag ?? '',
      itemCount: d.items.reduce((a, i) => a + i.quantity, 0),
      lineCount: d.items.length,
      grandTotal: d.totals?.grandTotal ?? 0,
      previewItems: d.items.slice(0, 4).map((i) => ({ name: i.name, imageUrl: i.imageUrl ?? null })),
      version: d.version,
      kitchenPending: kitchenPending(sentQty(d.items), sentQty(d.kitchenSent ?? [])),
      kitchenStatus: kitchen?.status.get(String(d._id)) ?? null,
      kitchenServed: asQty(kitchen?.served.get(String(d._id))),
      kitchenStarted: asQty(kitchen?.started.get(String(d._id))),
    }));
  const seatsUsed = drafts.reduce((a, d) => a + d.guestCount, 0);
  return {
    id: String(t._id),
    branchId: String(t.branchId),
    label: t.label,
    seats: t.seats,
    shape: t.shape,
    floor: t.floor,
    status: t.status,
    seatsUsed,
    occupancy: occupancyOf(t, seatsUsed),
    groups,
  };
}

const floorOrder = (a: string, b: string) =>
  a === 'Ground Floor' ? -1 : b === 'Ground Floor' ? 1 : a.localeCompare(b, undefined, { numeric: true });

export async function listTables(scope: BranchScope, floor?: unknown): Promise<TablesResponseDTO> {
  const all = await TableModel.find({ branchId: scope.branch._id, isActive: true }).lean<TableLean[]>();
  const floors = [...new Set(all.map((t) => t.floor))].sort(floorOrder);
  const tables = typeof floor === 'string' && floor ? all.filter((t) => t.floor === floor) : all;
  const drafts = await DraftModel.find({
    branchId: scope.branch._id,
    type: 'TABLE',
    status: 'ACTIVE',
    tableId: { $in: tables.map((t) => t._id) },
  }).lean<DraftLean[]>();
  const byTable = new Map<string, DraftLean[]>();
  for (const d of drafts) {
    const key = String(d.tableId);
    byTable.set(key, [...(byTable.get(key) ?? []), d]);
  }
  const kitchen = scope.branch.kitchenDisplay ? await kitchenByDraft(drafts) : undefined;
  return {
    floors,
    tables: tables
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
      .map((t) => toTableDTO(t, byTable.get(String(t._id)) ?? [], kitchen)),
  };
}

export async function getTableDTO(scope: BranchScope, tableId: Types.ObjectId): Promise<TableDTO> {
  const table = await TableModel.findOne({ _id: tableId, branchId: scope.branch._id }).lean<TableLean>();
  if (!table) throw notFound('Table');
  const drafts = await DraftModel.find({ tableId, status: 'ACTIVE', type: 'TABLE' }).lean<DraftLean[]>();
  return toTableDTO(table, drafts, scope.branch.kitchenDisplay ? await kitchenByDraft(drafts) : undefined);
}

async function getTableOr404(scope: BranchScope, id: string) {
  const table = await TableModel.findOne({ _id: toObjectId(id, 'table'), branchId: scope.branch._id, isActive: true });
  if (!table) throw notFound('Table');
  return table;
}

export async function seatsInUse(tableId: Types.ObjectId, exceptDraftId?: Types.ObjectId): Promise<number> {
  const drafts = await DraftModel.find({
    tableId,
    status: 'ACTIVE',
    type: 'TABLE',
    ...(exceptDraftId && { _id: { $ne: exceptDraftId } }),
  })
    .select('guestCount')
    .lean<{ guestCount: number }[]>();
  return drafts.reduce((a, d) => a + d.guestCount, 0);
}

export async function createTable(actor: AuthUser, scope: BranchScope, input: TableCreateInput) {
  assertAdmin(actor);
  const labelKey = nameKey(input.label);
  if (await TableModel.exists({ branchId: scope.branch._id, labelKey })) {
    throw conflict(`Table ${input.label} already exists`, 'DUPLICATE');
  }
  const table = await TableModel.create({
    ...input,
    label: input.label.toUpperCase(),
    labelKey,
    restaurantId: scope.restaurant._id,
    branchId: scope.branch._id,
  });
  await audit(actor, {
    action: 'TABLE_CREATED',
    entityType: 'Table',
    entityId: table._id,
    restaurantId: scope.restaurant._id,
    branchId: scope.branch._id,
    summary: `Added table ${table.label} (${table.seats} seats, ${table.floor})`,
  });
  return toTableDTO(table.toObject() as TableLean, []);
}

export async function updateTable(actor: AuthUser, scope: BranchScope, id: string, input: Partial<TableCreateInput>) {
  assertAdmin(actor);
  const table = await getTableOr404(scope, id);
  if (input.label && nameKey(input.label) !== table.labelKey) {
    const labelKey = nameKey(input.label);
    if (await TableModel.exists({ branchId: scope.branch._id, labelKey, _id: { $ne: table._id } })) {
      throw conflict(`Table ${input.label} already exists`, 'DUPLICATE');
    }
    table.labelKey = labelKey;
    input = { ...input, label: input.label.toUpperCase() };
  }
  const used = await seatsInUse(table._id);
  if (input.seats !== undefined && input.seats < used) {
    throw conflict(`${used} seats are in use – seats cannot be reduced below that`, 'SEATS_IN_USE');
  }
  table.set(input);
  table.version += 1;
  await table.save();
  await audit(actor, {
    action: 'TABLE_UPDATED',
    entityType: 'Table',
    entityId: table._id,
    restaurantId: scope.restaurant._id,
    branchId: scope.branch._id,
    summary: `Updated table ${table.label}`,
    meta: { changes: input },
  });
  return getTableDTO(scope, table._id);
}

export async function deactivateTable(actor: AuthUser, scope: BranchScope, id: string) {
  assertAdmin(actor);
  const table = await getTableOr404(scope, id);
  if ((await seatsInUse(table._id)) > 0 || (await DraftModel.exists({ tableId: table._id, status: 'ACTIVE' }))) {
    throw conflict('This table has open bills. Finalise or delete them first.', 'TABLE_IN_USE');
  }
  table.isActive = false;
  // Free the label so a new table can reuse it.
  table.labelKey = `${table.labelKey}#removed#${table._id}`;
  await table.save();
  await audit(actor, {
    action: 'TABLE_REMOVED',
    entityType: 'Table',
    entityId: table._id,
    restaurantId: scope.restaurant._id,
    branchId: scope.branch._id,
    summary: `Removed table ${table.label}`,
  });
}
