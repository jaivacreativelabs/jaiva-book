/**
 * Moving, merging and splitting the groups seated at tables. Each works on open (draft) bills
 * only and keeps what was already sent to the kitchen, so no dish is cooked twice.
 *
 *  - Move:  a group and its bill go to another table with enough free seats.
 *  - Merge: a group's dishes are added to another group's bill (any table); it then closes.
 *  - Split: some dishes and guests leave a group as a new group at the same table.
 */
import type { ClientSession, Types } from 'mongoose';
import { LIMITS, type DraftDTO, type MergeGroupInput, type MoveGroupInput, type SplitGroupInput } from '@rb/shared';
import { runInTransaction } from '../config/transaction.js';
import type { AuthUser } from '../middleware/auth.js';
import type { BranchScope } from '../middleware/scope.js';
import { DraftModel, KitchenTicketModel, TableModel, type Draft, type Table } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { assertAdmin } from '../utils/roles.js';
import { toDraftDTO } from '../utils/serialize.js';
import { toObjectId } from '../utils/validate.js';
import { audit } from './audit.service.js';
import { assertActive, findDraft, nextGroupName, priceLines, staleVersion, tableLabelOf, totalsFor } from './bills.service.js';

type DraftLean = Draft & { _id: Types.ObjectId };
type TableLean = Table & { _id: Types.ObjectId };
type Qty = { menuItemId: Types.ObjectId; quantity: number; note?: string | null };

function assertTableGroup(draft: DraftLean) {
  if (draft.type !== 'TABLE' || !draft.tableId) throw badRequest('Only table bills can be moved, merged or split');
}

async function loadTable(scope: BranchScope, id: Types.ObjectId, session?: ClientSession): Promise<TableLean> {
  const table = await TableModel.findOne({ _id: id, branchId: scope.branch._id, isActive: true })
    .session(session ?? null)
    .lean<TableLean>();
  if (!table) throw notFound('Table');
  return table;
}

async function openGroups(tableId: Types.ObjectId, session?: ClientSession) {
  return DraftModel.find({ tableId, status: 'ACTIVE', type: 'TABLE' })
    .session(session ?? null)
    .select('groupName guestCount')
    .lean<{ _id: Types.ObjectId; groupName: string; guestCount: number }[]>();
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Adds quantities per dish, keeping the order dishes were first seen in (and the first kitchen note). */
function sumQty(...lists: Qty[][]): Qty[] {
  const out = new Map<string, Qty>();
  for (const list of lists) {
    for (const { menuItemId, quantity, note } of list) {
      const prev = out.get(String(menuItemId));
      const keptNote = prev?.note || note;
      out.set(String(menuItemId), { menuItemId, quantity: (prev?.quantity ?? 0) + quantity, ...(keptNote && { note: keptNote }) });
    }
  }
  return [...out.values()];
}

const stripCategory = <T extends { categoryName: string }>({ categoryName: _c, ...rest }: T) => rest;

// ---------------- Move ----------------

export async function moveGroup(actor: AuthUser, scope: BranchScope, id: string, input: MoveGroupInput): Promise<DraftDTO> {
  assertAdmin(actor);
  const targetId = toObjectId(input.tableId, 'table');
  return runInTransaction(async (session) => {
    const draft = await findDraft(scope, id, session);
    assertActive(draft);
    assertTableGroup(draft);
    if (draft.version !== input.version) throw await staleVersion(draft);
    if (draft.tableId!.equals(targetId)) throw badRequest('The group is already at this table');

    const target = await loadTable(scope, targetId, session);
    if (target.status === 'RESERVED') throw conflict(`${target.label} is reserved. Mark it available first.`, 'TABLE_RESERVED');
    const open = await openGroups(targetId, session);
    const free = target.seats - open.reduce((a, d) => a + d.guestCount, 0);
    if (draft.guestCount > free) {
      throw conflict(
        free > 0 ? `${target.label} has only ${free} free seat${free === 1 ? '' : 's'} for ${draft.guestCount} guests` : `${target.label} is full`,
        'SEATS_UNAVAILABLE',
        { free },
      );
    }
    // Keep the group's name unless the new table already has a group called that.
    const groupName = open.some((d) => sameName(d.groupName, draft.groupName)) ? nextGroupName(open.map((d) => d.groupName)) : draft.groupName;

    const claimed = await TableModel.updateOne({ _id: targetId, version: target.version }, { $inc: { version: 1 } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict('The table was just updated. Please try again.', 'TABLE_BUSY');
    const moved = await DraftModel.findOneAndUpdate(
      { _id: draft._id, version: input.version, status: 'ACTIVE' },
      { $set: { tableId: targetId, groupName, updatedBy: actor._id, updatedByName: actor.name }, $inc: { version: 1 } },
      { new: true, session },
    ).lean<DraftLean>();
    if (!moved) throw await staleVersion(await findDraft(scope, id, session));

    // Tickets still in the kitchen show where the food now goes.
    await KitchenTicketModel.updateMany({ draftId: draft._id }, { $set: { tableLabel: target.label, groupName } }, { session });
    const from = await tableLabelOf(draft);
    await audit(
      actor,
      {
        action: 'GROUP_MOVED',
        entityType: 'Draft',
        entityId: draft._id,
        restaurantId: scope.restaurant._id,
        branchId: scope.branch._id,
        summary: `Moved ${draft.groupName} (${draft.guestCount} guests) from ${from} to ${target.label}${groupName !== draft.groupName ? ` as ${groupName}` : ''}`,
      },
      session,
    );
    return toDraftDTO(moved, target.label);
  });
}

// ---------------- Merge ----------------

export async function mergeGroup(actor: AuthUser, scope: BranchScope, id: string, input: MergeGroupInput): Promise<DraftDTO> {
  assertAdmin(actor);
  return runInTransaction(async (session) => {
    const source = await findDraft(scope, id, session);
    assertActive(source);
    assertTableGroup(source);
    if (source.version !== input.version) throw await staleVersion(source);
    if (source._id.equals(input.intoDraftId)) throw badRequest('Choose another group to merge with');

    const target = await findDraft(scope, input.intoDraftId, session);
    if (target.status !== 'ACTIVE') throw conflict('The other group’s bill is already closed', 'BILL_CLOSED');
    assertTableGroup(target);

    const table = await loadTable(scope, target.tableId!, session);
    // Merging only joins the bills: at the same table the guests join the group; from another
    // table they are not moved, so no free seats are needed and their table is freed.
    const sameTable = source.tableId!.equals(target.tableId!);

    const items = sumQty(target.items, source.items);
    if (items.length > LIMITS.maxBillLines) throw badRequest('The merged bill would have too many dishes');
    const tooMany = items.find((i) => i.quantity > LIMITS.maxQuantity);
    if (tooMany) throw badRequest(`The merged bill would have more than ${LIMITS.maxQuantity} of one dish`);
    const lines = await priceLines(scope, items, session);
    const discount = target.discount?.type ? { type: target.discount.type, value: target.discount.value ?? 0 } : null;

    // Close the merged group first, so its dishes can never be on two open bills.
    const closed = await DraftModel.findOneAndUpdate(
      { _id: source._id, version: input.version, status: 'ACTIVE' },
      {
        $set: { status: 'DELETED', deletedAt: new Date(), deletedBy: actor._id, updatedBy: actor._id, updatedByName: actor.name },
        $inc: { version: 1 },
      },
      { new: true, session },
    ).lean<DraftLean>();
    if (!closed) throw await staleVersion(await findDraft(scope, id, session));

    const merged = await DraftModel.findOneAndUpdate(
      { _id: target._id, version: target.version, status: 'ACTIVE' },
      {
        $set: {
          items: lines.map(stripCategory),
          totals: totalsFor(scope, lines, discount),
          guestCount: sameTable ? target.guestCount + source.guestCount : target.guestCount,
          customerName: target.customerName || source.customerName || '',
          kitchenSent: sumQty(target.kitchenSent ?? [], source.kitchenSent ?? []),
          updatedBy: actor._id,
          updatedByName: actor.name,
        },
        $inc: { version: 1, kitchenRev: 1 },
      },
      { new: true, session },
    ).lean<DraftLean>();
    if (!merged) {
      // Without a MongoDB transaction, reopen the first group before giving up.
      if (!session) {
        await DraftModel.updateOne(
          { _id: source._id, status: 'DELETED', version: input.version + 1 },
          { $set: { status: 'ACTIVE', deletedAt: null, deletedBy: null }, $inc: { version: 1 } },
        );
      }
      throw conflict(`${target.groupName}’s bill was just changed. Please try again.`, 'TARGET_CHANGED');
    }

    // Food already in the kitchen now belongs to the merged bill.
    await KitchenTicketModel.updateMany({ draftId: source._id }, { $set: { draftId: target._id, tableLabel: table.label, groupName: target.groupName } }, { session });
    const fromLabel = await tableLabelOf(source);
    await audit(
      actor,
      {
        action: 'GROUPS_MERGED',
        entityType: 'Draft',
        entityId: target._id,
        restaurantId: scope.restaurant._id,
        branchId: scope.branch._id,
        summary: `Merged ${fromLabel} ${source.groupName} (${source.items.length} dish(es), ${source.guestCount} guests) into ${table.label} ${target.groupName}`,
        meta: { mergedDraftId: String(source._id), items: source.items.map((i) => ({ name: i.name, quantity: i.quantity })) },
      },
      session,
    );
    return toDraftDTO(merged, table.label);
  });
}

// ---------------- Split ----------------

export async function splitGroup(
  actor: AuthUser,
  scope: BranchScope,
  id: string,
  input: SplitGroupInput,
): Promise<{ source: DraftDTO; created: DraftDTO }> {
  assertAdmin(actor);
  try {
    return await runInTransaction(async (session) => {
      const source = await findDraft(scope, id, session);
      assertActive(source);
      assertTableGroup(source);
      if (source.version !== input.version) throw await staleVersion(source);
      if (input.guestCount >= source.guestCount) {
        throw badRequest(
          source.guestCount > 1 ? `Leave at least one guest in ${source.groupName}` : `${source.groupName} has only 1 guest – add a guest before splitting`,
        );
      }

      const onBill = new Map(source.items.map((i) => [String(i.menuItemId), i]));
      const moving = new Map<string, number>();
      for (const r of input.items) {
        const line = onBill.get(r.menuItemId);
        if (!line) throw badRequest('A dish to split off is not on this bill');
        if (r.quantity > line.quantity) throw badRequest(`${source.groupName} has only ${line.quantity} × ${line.name}`);
        moving.set(r.menuItemId, r.quantity);
      }
      const staying = source.items
        .map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity - (moving.get(String(i.menuItemId)) ?? 0), note: i.note }))
        .filter((i) => i.quantity > 0);
      if (!staying.length) throw badRequest(`Leave at least one dish on ${source.groupName}’s bill – use Move to send the whole group`);
      const leaving = source.items
        .filter((i) => moving.has(String(i.menuItemId)))
        .map((i) => ({ menuItemId: i.menuItemId, quantity: moving.get(String(i.menuItemId))!, note: i.note }));

      // What the kitchen already has goes with the dishes first, the rest stays.
      const sent = new Map((source.kitchenSent ?? []).map((s) => [String(s.menuItemId), s.quantity]));
      const newSent: Qty[] = [];
      const keptSent: Qty[] = [];
      for (const i of source.items) {
        const s = sent.get(String(i.menuItemId)) ?? 0;
        const toNew = Math.min(moving.get(String(i.menuItemId)) ?? 0, s);
        if (toNew > 0) newSent.push({ menuItemId: i.menuItemId, quantity: toNew });
        if (s - toNew > 0) keptSent.push({ menuItemId: i.menuItemId, quantity: s - toNew });
      }

      const open = await openGroups(source.tableId!, session);
      const wanted = input.groupName?.replace(/\s+/g, ' ').trim();
      if (wanted && open.some((d) => sameName(d.groupName, wanted))) throw conflict(`“${wanted}” is already at this table. Use another name.`, 'DUPLICATE');
      const groupName = wanted || nextGroupName(open.map((d) => d.groupName));

      const [keptLines, newLines] = await Promise.all([priceLines(scope, staying, session), priceLines(scope, leaving, session)]);
      const discount = source.discount?.type ? { type: source.discount.type, value: source.discount.value ?? 0 } : null;
      // A percentage discount applies to both bills; a flat one stays with the original group.
      const newDiscount = discount?.type === 'PERCENT' ? discount : null;

      const kept = await DraftModel.findOneAndUpdate(
        { _id: source._id, version: input.version, status: 'ACTIVE' },
        {
          $set: {
            items: keptLines.map(stripCategory),
            totals: totalsFor(scope, keptLines, discount),
            guestCount: source.guestCount - input.guestCount,
            kitchenSent: keptSent,
            updatedBy: actor._id,
            updatedByName: actor.name,
          },
          $inc: { version: 1, kitchenRev: 1 },
        },
        { new: true, session },
      ).lean<DraftLean>();
      if (!kept) throw await staleVersion(await findDraft(scope, id, session));

      const [created] = await DraftModel.create(
        [
          {
            restaurantId: scope.restaurant._id,
            branchId: scope.branch._id,
            type: 'TABLE',
            tableId: source.tableId,
            groupName,
            guestCount: input.guestCount,
            items: newLines.map(stripCategory),
            totals: totalsFor(scope, newLines, newDiscount),
            discount: newDiscount,
            kitchenSent: newSent,
            createdBy: actor._id,
            updatedBy: actor._id,
            updatedByName: actor.name,
          },
        ],
        { session },
      );
      const label = await tableLabelOf(source);
      await audit(
        actor,
        {
          action: 'GROUP_SPLIT',
          entityType: 'Draft',
          entityId: source._id,
          restaurantId: scope.restaurant._id,
          branchId: scope.branch._id,
          summary: `Split ${input.guestCount} guest(s) and ${leaving.length} dish(es) from ${label} ${source.groupName} into ${groupName}`,
          meta: { newDraftId: String(created._id), items: newLines.map((l) => ({ name: l.name, quantity: l.quantity })) },
        },
        session,
      );
      return { source: toDraftDTO(kept, label), created: toDraftDTO(created.toObject() as DraftLean, label) };
    });
  } catch (err) {
    // Someone named a group the same at the same moment (unique open-group name per table).
    if ((err as { code?: number }).code === 11000) throw conflict('That group name was just taken at this table. Try again.', 'DUPLICATE');
    throw err;
  }
}
