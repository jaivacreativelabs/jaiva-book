/**
 * Draft (open) bills and their finalisation into immutable transactions.
 *
 * Integrity rules:
 *  - Prices, names and totals are always taken from the server-side menu; the client only
 *    sends item ids and quantities.
 *  - Every write carries the version the client last saw (optimistic concurrency); a stale
 *    version returns 409 with the current draft instead of overwriting someone else's change.
 *  - Finalisation is idempotent: one transaction per draft (unique sourceDraftId) and per
 *    idempotency key; it runs in a MongoDB transaction when available.
 */
import { Types, type ClientSession } from 'mongoose';
import {
  calculateBill,
  formatBillNumber,
  MANUAL_SALE_ITEM_ID,
  MANUAL_SALE_NAME,
  type DraftDTO,
  type DraftUpdateInput,
  type FinalizeInput,
  type ManualSaleInput,
  type TransactionDTO,
} from '@rb/shared';
import { runInTransaction } from '../config/transaction.js';
import type { AuthUser } from '../middleware/auth.js';
import type { BranchScope } from '../middleware/scope.js';
import {
  CategoryModel,
  DraftModel,
  MenuItemModel,
  nextSequence,
  TableModel,
  TransactionModel,
  type Category,
  type Draft,
  type MenuItem,
  type Table,
  type Transaction,
} from '../models/index.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { assertAdmin } from '../utils/roles.js';
import { effectiveCategory, effectiveItem, restaurantSettings, toDraftDTO, toTransactionDTO } from '../utils/serialize.js';
import { resolvePayments } from '../utils/payments.js';
import { toObjectId } from '../utils/validate.js';
import { audit } from './audit.service.js';
import { cancelUnstarted, editUnstarted, linkBill, sendToKitchen, unstartedQty, unstartedTickets } from './kitchen.service.js';
import { claimTable, releaseTableIfFree, seatsInUse } from './tables.service.js';

type DraftLean = Draft & { _id: Types.ObjectId; updatedAt?: Date };
type TableLean = Table & { _id: Types.ObjectId };
type TransactionLean = Transaction & { _id: Types.ObjectId };

interface PricedLine {
  menuItemId: Types.ObjectId;
  name: string;
  imageUrl: string | null;
  unitPrice: number;
  taxable: boolean;
  taxRateBps: number | null;
  extraTaxes: { name: string; rateBps: number }[];
  quantity: number;
  unavailable: boolean;
  note: string;
  categoryName: string;
}

/** Looks up each requested item in the branch's effective menu (its kitchen note is kept as given). */
export async function priceLines(
  scope: BranchScope,
  requested: { menuItemId: Types.ObjectId | string; quantity: number; note?: string | null }[],
  session?: ClientSession,
): Promise<PricedLine[]> {
  if (requested.length === 0) return [];
  const ids = requested.map((r) => toObjectId(String(r.menuItemId), 'item'));
  const items = await MenuItemModel.find({
    _id: { $in: ids },
    restaurantId: scope.restaurant._id,
    branchId: { $in: [null, scope.branch._id] },
  })
    .session(session ?? null)
    .lean<(MenuItem & { _id: Types.ObjectId })[]>();
  // Variants take their photo and availability from their dish; a dish that has variants is
  // ordered by variant, so it counts as unavailable itself.
  const parentIds = items.filter((i) => i.parentId).map((i) => i.parentId!);
  const [parents, withVariants] = await Promise.all([
    parentIds.length
      ? MenuItemModel.find({ _id: { $in: parentIds } }).session(session ?? null).lean<(MenuItem & { _id: Types.ObjectId })[]>()
      : [],
    // Only variants this branch sees count: another branch's own ones and main-menu ones this
    // branch removed do not apply here.
    MenuItemModel.find({ parentId: { $in: ids }, status: 'ACTIVE', branchId: { $in: [null, scope.branch._id] } })
      .select('parentId branchOverrides')
      .session(session ?? null)
      .lean<(MenuItem & { _id: Types.ObjectId })[]>(),
  ]);
  const parentById = new Map(parents.map((p) => [String(p._id), p]));
  // A branch may give a main-menu dish its own name and category (its variants follow it).
  const effById = new Map(items.map((i) => [String(i._id), effectiveItem(i, scope.branch._id, i.parentId ? parentById.get(String(i.parentId)) : undefined)]));
  const cats = await CategoryModel.find({ _id: { $in: [...effById.values()].map((e) => e.categoryId) } })
    .session(session ?? null)
    .lean<(Category & { _id: Types.ObjectId })[]>();
  const hasVariants = new Set(withVariants.filter((v) => !effectiveItem(v, scope.branch._id).hidden).map((v) => String(v.parentId)));
  const itemById = new Map(items.map((i) => [String(i._id), i]));
  const catById = new Map(cats.map((c) => [String(c._id), c]));

  return requested.map((r) => {
    const item = itemById.get(String(r.menuItemId));
    if (!item) throw badRequest('An item on this bill is not on this restaurant’s menu', 'ITEM_NOT_FOUND');
    const eff = effById.get(String(item._id))!;
    const cat = catById.get(String(eff.categoryId));
    const catEff = cat ? effectiveCategory(cat, scope.branch._id) : undefined; // the branch's own on/off and name
    const parent = item.parentId ? parentById.get(String(item.parentId)) : undefined;
    const parentEff = parent ? effectiveItem(parent, scope.branch._id) : undefined;
    const parentOk = !item.parentId || Boolean(parent && parent.status === 'ACTIVE' && parentEff!.isAvailable);
    const available = item.status === 'ACTIVE' && eff.isAvailable && !eff.hidden && catEff?.status === 'ACTIVE' && parentOk && !hasVariants.has(String(item._id));
    return {
      menuItemId: item._id,
      name: eff.name,
      imageUrl: eff.imageUrl ?? parentEff?.imageUrl ?? null,
      unitPrice: eff.price,
      // GST follows the dish (and this branch's own GST for it, if set).
      taxable: (parentEff ?? eff).taxable,
      taxRateBps: (parentEff ?? eff).taxRateBps,
      extraTaxes: (parentEff ?? eff).extraTaxes,
      quantity: r.quantity,
      unavailable: !available,
      note: r.note ?? '',
      categoryName: catEff?.name ?? '',
    };
  });
}

export function totalsFor(scope: BranchScope, lines: PricedLine[], discount: DraftUpdateInput['discount'] | null | undefined) {
  const t = calculateBill(lines, restaurantSettings(scope.restaurant), discount ?? null);
  return {
    subtotal: t.subtotal,
    discountAmount: t.discountAmount,
    taxes: t.taxes,
    taxTotal: t.taxTotal,
    grandTotal: t.grandTotal,
  };
}

export async function tableLabelOf(draft: Pick<Draft, 'tableId'>): Promise<string> {
  if (!draft.tableId) return '';
  const t = await TableModel.findById(draft.tableId).select('label').lean<{ label: string }>();
  return t?.label ?? '';
}

async function toDTO(draft: DraftLean): Promise<DraftDTO> {
  return toDraftDTO(draft, await tableLabelOf(draft));
}

export async function findDraft(scope: BranchScope, id: string, session?: ClientSession) {
  const draft = await DraftModel.findOne({ _id: toObjectId(id, 'bill'), branchId: scope.branch._id })
    .session(session ?? null)
    .lean<DraftLean>();
  if (!draft) throw notFound('Bill');
  return draft;
}

export async function staleVersion(draft: DraftLean): Promise<AppError> {
  return conflict(
    `This bill was changed by ${draft.updatedByName || 'another user'}. The latest version has been loaded.`,
    'CONFLICT',
    { current: await toDTO(draft) },
  );
}

export function assertActive(draft: DraftLean) {
  if (draft.status === 'FINALIZED') throw conflict('This bill has already been generated', 'BILL_FINALIZED');
  if (draft.status === 'DELETED') throw conflict('This bill was deleted', 'BILL_DELETED');
}

// ---------------- Reading / creating drafts ----------------

/** Waiters take table orders only: a counter bill is the admin's. */
export function assertWaiterTable(actor: Pick<AuthUser, 'role'>, draft: Pick<Draft, 'type'>) {
  if (actor.role === 'WAITER' && draft.type !== 'TABLE') throw forbidden('Waiters can only take table orders');
}

export async function getDraft(actor: AuthUser, scope: BranchScope, id: string): Promise<DraftDTO> {
  const draft = await findDraft(scope, id);
  assertWaiterTable(actor, draft);
  return toDTO(draft);
}

export async function listTableDrafts(scope: BranchScope, tableId: unknown): Promise<DraftDTO[]> {
  const id = toObjectId(tableId, 'table');
  const table = await TableModel.findOne({ _id: id, branchId: scope.branch._id }).lean<TableLean>();
  if (!table) throw notFound('Table');
  const drafts = await DraftModel.find({ tableId: id, status: 'ACTIVE', type: 'TABLE' })
    .sort({ createdAt: 1 })
    .lean<DraftLean[]>();
  return drafts.map((d) => toDraftDTO(d, table.label));
}

/** The admin's own takeaway/counter bill for this branch, created on first use. */
export async function getCounterDraft(actor: AuthUser, scope: BranchScope): Promise<DraftDTO> {
  assertAdmin(actor);
  const filter = { branchId: scope.branch._id, ownerUserId: actor._id, type: 'COUNTER', status: 'ACTIVE' };
  let draft = await DraftModel.findOne(filter).lean<DraftLean>();
  if (!draft) {
    try {
      const created = await DraftModel.create({
        ...filter,
        restaurantId: scope.restaurant._id,
        createdBy: actor._id,
        updatedBy: actor._id,
        updatedByName: actor.name,
      });
      draft = created.toObject() as DraftLean;
    } catch (err) {
      // Two tabs raced to create it – the unique partial index kept just one.
      if ((err as { code?: number }).code !== 11000) throw err;
      draft = await DraftModel.findOne(filter).lean<DraftLean>();
      if (!draft) throw err;
    }
  }
  return toDTO(draft);
}

export function nextGroupName(existing: string[]): string {
  const used = new Set(existing);
  for (let n = 1; ; n++) if (!used.has(`Group ${n}`)) return `Group ${n}`;
}

export async function createTableGroup(
  actor: AuthUser,
  scope: BranchScope,
  input: { tableId: string; guestCount: number; groupName?: string; groupTag?: string },
): Promise<DraftDTO> {
  const tableId = toObjectId(input.tableId, 'table');
  const wantedName = input.groupName?.replace(/\s+/g, ' ').trim();
  const draft = await runInTransaction(async (session) => {
    const table = await TableModel.findOne({ _id: tableId, branchId: scope.branch._id, isActive: true })
      .session(session ?? null)
      .lean<TableLean>();
    if (!table) throw notFound('Table');
    if (table.status === 'RESERVED') {
      throw conflict('This table is reserved. Mark it available before seating guests.', 'TABLE_RESERVED');
    }
    const open = await DraftModel.find({ tableId, status: 'ACTIVE', type: 'TABLE' })
      .session(session ?? null)
      .select('groupName guestCount')
      .lean<{ groupName: string; guestCount: number }[]>();
    const used = open.reduce((a, d) => a + d.guestCount, 0);
    const free = table.seats - used;
    if (wantedName && open.some((d) => d.groupName.toLowerCase() === wantedName.toLowerCase())) {
      throw conflict(`“${wantedName}” is already seated at ${table.label}. Use another name.`, 'DUPLICATE');
    }
    if (input.guestCount > free) {
      throw conflict(
        free > 0 ? `Only ${free} seat${free === 1 ? '' : 's'} available at ${table.label}` : `${table.label} is full`,
        'SEATS_UNAVAILABLE',
        { free },
      );
    }
    // Claim the table version so two concurrent "add group" calls cannot both use the last seats.
    const claimed = await TableModel.updateOne(
      { _id: tableId, version: table.version },
      { $inc: { version: 1 } },
      { session },
    );
    if (claimed.modifiedCount !== 1) throw conflict('The table was just updated. Please try again.', 'TABLE_BUSY');
    await claimTable(actor, tableId, session); // a waiter seating guests looks after the table
    const [created] = await DraftModel.create(
      [
        {
          restaurantId: scope.restaurant._id,
          branchId: scope.branch._id,
          type: 'TABLE',
          tableId,
          groupName: wantedName || nextGroupName(open.map((d) => d.groupName)),
          guestCount: input.guestCount,
          groupTag: input.groupTag ?? '',
          createdBy: actor._id,
          updatedBy: actor._id,
          updatedByName: actor.name,
        },
      ],
      { session },
    );
    return { draft: created.toObject() as DraftLean, label: table.label };
  });
  return toDraftDTO(draft.draft, draft.label);
}

// ---------------- Updating ----------------

const sameDiscount = (a: { type?: string | null; value?: number | null } | null | undefined, b: typeof a) =>
  (a?.type ?? null) === (b?.type ?? null) && (!a?.type || (a.value ?? 0) === (b?.value ?? 0));

/**
 * A waiter changes only the dishes of a table order: no discount, name or guest changes.
 * (Lowering what the kitchen already has is checked in updateDraft: allowed only while the kitchen
 * has not started it.) Unchanged fields may still be sent, as the bill screens always send them.
 */
function assertWaiterEdit(draft: DraftLean, input: DraftUpdateInput) {
  if (input.discount !== undefined && !sameDiscount(input.discount, draft.discount)) throw forbidden('Only a Restaurant Admin can give a discount');
  if (input.customerName !== undefined && input.customerName !== (draft.customerName ?? '')) throw forbidden('Only a Restaurant Admin can change the customer name');
  if (input.guestCount !== undefined && input.guestCount !== draft.guestCount) throw forbidden('Only a Restaurant Admin can change the guests');
  if (input.groupTag !== undefined && input.groupTag !== (draft.groupTag ?? '')) throw forbidden('Only a Restaurant Admin can change the group');
}

export async function updateDraft(actor: AuthUser, scope: BranchScope, id: string, input: DraftUpdateInput): Promise<DraftDTO> {
  const draft = await findDraft(scope, id);
  assertWaiterTable(actor, draft);
  assertActive(draft);
  if (draft.version !== input.version) throw await staleVersion(draft);
  if (actor.role === 'WAITER') {
    assertWaiterEdit(draft, input);
    await claimTable(actor, draft.tableId); // taking the order makes the table theirs; another waiter's is refused
  }

  const previousQty = new Map(draft.items.map((i) => [String(i.menuItemId), i.quantity]));
  // A dish sent without a note keeps the one it has (screens that do not show notes).
  const previousNote = new Map(draft.items.map((i) => [String(i.menuItemId), i.note ?? '']));
  const lines = await priceLines(
    scope,
    input.items.map((i) => ({ ...i, note: i.note ?? previousNote.get(i.menuItemId) ?? '' })),
  );
  const blocked = lines.filter((l) => l.unavailable && l.quantity > (previousQty.get(String(l.menuItemId)) ?? 0));
  if (blocked.length) {
    throw badRequest(`${blocked.map((l) => l.name).join(', ')} ${blocked.length > 1 ? 'are' : 'is'} unavailable`, 'ITEM_UNAVAILABLE', {
      menuItemIds: blocked.map((l) => String(l.menuItemId)),
    });
  }

  if (input.guestCount !== undefined && draft.type === 'TABLE' && input.guestCount !== draft.guestCount) {
    const table = await TableModel.findById(draft.tableId).lean<TableLean>();
    const others = await seatsInUse(draft.tableId!, draft._id);
    if (table && others + input.guestCount > table.seats) {
      throw conflict(`Only ${table.seats - others} seats available at ${table.label}`, 'SEATS_UNAVAILABLE');
    }
  }

  const discount = input.discount === undefined ? draft.discount : input.discount;
  const set: Record<string, unknown> = {
    items: lines.map(({ categoryName: _c, ...l }) => l),
    totals: totalsFor(scope, lines, discount?.type ? (discount as DraftUpdateInput['discount']) : null),
    discount: discount?.type ? discount : null,
    updatedBy: actor._id,
    updatedByName: actor.name,
  };
  if (input.customerName !== undefined) set.customerName = input.customerName;
  if (input.groupTag !== undefined && draft.type === 'TABLE') set.groupTag = input.groupTag;
  if (input.guestCount !== undefined && draft.type === 'TABLE') set.guestCount = input.guestCount;

  // Food already sent to the kitchen that is now lowered or removed, and sent dishes whose note changed.
  const sent = new Map((draft.kitchenSent ?? []).map((s) => [String(s.menuItemId), s.quantity]));
  const wanted = new Map(lines.map((l) => [String(l.menuItemId), l.quantity]));
  const takeBack = new Map([...sent].flatMap(([id, q]) => ((wanted.get(id) ?? 0) < q ? [[id, q - (wanted.get(id) ?? 0)] as const] : [])));
  const newNotes = new Map(
    lines.filter((l) => sent.has(String(l.menuItemId)) && l.note !== (previousNote.get(String(l.menuItemId)) ?? '')).map((l) => [String(l.menuItemId), l.note]),
  );

  const updated = await runInTransaction(async (session) => {
    // While the kitchen has not started it (New), it comes off / changes on the KOT too. What the
    // kitchen has started stays: a waiter may not lower that; the admin may (the bill is theirs).
    const tickets = takeBack.size || newNotes.size ? await unstartedTickets(draft._id, session) : [];
    const free = unstartedQty(tickets);
    const taken = new Map([...takeBack].map(([id, q]) => [id, Math.min(q, free.get(id) ?? 0)]));
    if (actor.role === 'WAITER') {
      for (const line of draft.items) {
        const id = String(line.menuItemId);
        const lowered = Math.min(line.quantity, sent.get(id) ?? 0) - (wanted.get(id) ?? 0);
        if (lowered > (taken.get(id) ?? 0)) {
          throw new AppError(403, 'IN_KITCHEN', `The kitchen has started ${line.name} – ask the Restaurant Admin to remove it`);
        }
      }
    }
    const filter: Record<string, unknown> = { _id: draft._id, version: input.version, status: 'ACTIVE' };
    const inc: Record<string, number> = { version: 1 };
    if ([...taken.values()].some((q) => q > 0)) {
      // The kitchen no longer has it: adding it back later sends it again. kitchenRev keeps a
      // send running at the same moment from recording the old numbers.
      set.kitchenSent = (draft.kitchenSent ?? [])
        .map((s) => ({ menuItemId: s.menuItemId, quantity: s.quantity - (taken.get(String(s.menuItemId)) ?? 0) }))
        .filter((s) => s.quantity > 0);
      filter.kitchenRev = draft.kitchenRev ?? null; // null also matches older bills without one
      inc.kitchenRev = 1;
    }
    const saved = await DraftModel.findOneAndUpdate(filter, { $set: set, $inc: inc }, { new: true, session }).lean<DraftLean>();
    if (saved && tickets.length) await editUnstarted(tickets, taken, newNotes, session);
    return saved;
  });
  if (!updated) {
    const current = await findDraft(scope, id);
    assertActive(current);
    throw await staleVersion(current);
  }
  return toDTO(updated);
}

// ---------------- Deleting ----------------

export async function deleteDraft(actor: AuthUser, scope: BranchScope, id: string, version: number): Promise<void> {
  assertAdmin(actor);
  const draft = await findDraft(scope, id);
  assertActive(draft);
  if (draft.version !== version) throw await staleVersion(draft);
  const deleted = await DraftModel.findOneAndUpdate(
    { _id: draft._id, version, status: 'ACTIVE' },
    {
      $set: { status: 'DELETED', deletedAt: new Date(), deletedBy: actor._id, updatedBy: actor._id, updatedByName: actor.name },
      $inc: { version: 1 },
    },
    { new: true },
  ).lean<DraftLean>();
  if (!deleted) throw await staleVersion(await findDraft(scope, id));
  await cancelUnstarted(draft._id);
  await releaseTableIfFree(draft.tableId);
  const label = await tableLabelOf(draft);
  await audit(actor, {
    action: 'DRAFT_DELETED',
    entityType: 'Draft',
    entityId: draft._id,
    restaurantId: scope.restaurant._id,
    branchId: scope.branch._id,
    summary: `Deleted open bill ${label ? `${label} ${draft.groupName}` : '(counter)'} with ${draft.items.length} item(s), total ${draft.totals?.grandTotal ?? 0} paise`,
    meta: { items: draft.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })) },
  });
}

// ---------------- Finalising ----------------


async function existingFor(draftId: Types.ObjectId): Promise<TransactionLean | null> {
  return TransactionModel.findOne({ sourceDraftId: draftId }).lean<TransactionLean>();
}

export async function finalizeDraft(
  actor: AuthUser,
  scope: BranchScope,
  id: string,
  input: FinalizeInput,
): Promise<{ transaction: TransactionDTO; replayed: boolean }> {
  assertAdmin(actor, 'Only a Restaurant Admin can generate the bill');
  const draftId = toObjectId(id, 'bill');

  // Same idempotency key seen before → return the original result.
  const byKey = await TransactionModel.findOne({ branchId: scope.branch._id, idempotencyKey: input.idempotencyKey }).lean<TransactionLean>();
  if (byKey) {
    if (!byKey.sourceDraftId.equals(draftId)) throw conflict('Idempotency key was used for another bill', 'IDEMPOTENCY_MISMATCH');
    return { transaction: toTransactionDTO(byKey), replayed: true };
  }

  try {
    const result = await runInTransaction(async (session) => {
      const draft = await findDraft(scope, id, session);
      if (draft.status === 'FINALIZED') {
        const existing = await TransactionModel.findOne({ sourceDraftId: draft._id }).session(session ?? null).lean<TransactionLean>();
        if (existing) return { transaction: toTransactionDTO(existing), replayed: true };
      }
      assertActive(draft);
      if (draft.version !== input.version) throw await staleVersion(draft);
      if (draft.items.length === 0) throw badRequest('Add at least one item before generating the bill', 'EMPTY_BILL');

      const lines = await priceLines(scope, draft.items, session);
      const unavailable = lines.filter((l) => l.unavailable);
      if (unavailable.length) {
        throw badRequest(
          `Remove unavailable item(s) before generating the bill: ${unavailable.map((l) => l.name).join(', ')}`,
          'ITEM_UNAVAILABLE',
          { menuItemIds: unavailable.map((l) => String(l.menuItemId)) },
        );
      }
      const settings = restaurantSettings(scope.restaurant);
      const discount = draft.discount?.type ? { type: draft.discount.type, value: draft.discount.value ?? 0 } : null;
      const totals = calculateBill(lines, settings, discount);
      const now = new Date();
      const tableLabel = await tableLabelOf(draft);
      const paid = resolvePayments(input.paymentMethod, input.payments, totals.grandTotal);

      // Claim the draft first; a concurrent finaliser fails here (or on the unique index).
      const claimed = await DraftModel.findOneAndUpdate(
        { _id: draft._id, version: input.version, status: 'ACTIVE' },
        {
          $set: { status: 'FINALIZED', finalizedAt: now, updatedBy: actor._id, updatedByName: actor.name },
          $inc: { version: 1 },
        },
        { new: true, session },
      ).lean<DraftLean>();
      if (!claimed) {
        const current = await findDraft(scope, id, session);
        if (current.status === 'FINALIZED') {
          const existing = await existingFor(current._id);
          if (existing) return { transaction: toTransactionDTO(existing), replayed: true };
        }
        assertActive(current);
        throw await staleVersion(current);
      }

      try {
        // Numbered by branch code (ITH0001 …); a new code starts its own series at 0001.
        const prefix = scope.branch.code;
        const seq = await nextSequence(`bill:${scope.branch._id}:${prefix}`, session);
        const [tx] = await TransactionModel.create(
          [
            {
              billNumber: formatBillNumber(prefix, seq),
              restaurantId: scope.restaurant._id,
              branchId: scope.branch._id,
              tableId: draft.tableId ?? null,
              tableLabel,
              type: draft.type,
              // New Bill (counter) is always Take Away, a table's bill Dine In.
              orderType: draft.type === 'TABLE' ? 'DINE_IN' : 'TAKEAWAY',
              groupName: draft.groupName ?? '',
              guestCount: draft.guestCount ?? 0,
              customerName: draft.customerName ?? '',
              restaurantSnapshot: {
                name: scope.restaurant.name,
                address: scope.restaurant.address ?? '',
                phone: scope.restaurant.phone ?? '',
                gstin: scope.restaurant.gstin ?? '',
                receiptFooter: settings.receiptFooter,
                logoUrl: scope.restaurant.logoUrl ?? '',
              },
              branchSnapshot: {
                name: scope.branch.name,
                code: scope.branch.code,
                address: scope.branch.address ?? '',
                phone: scope.branch.phone ?? '',
              },
              items: lines.map((l, i) => ({
                menuItemId: l.menuItemId,
                name: l.name,
                categoryName: l.categoryName,
                imageUrl: l.imageUrl,
                unitPrice: l.unitPrice,
                quantity: l.quantity,
                taxable: l.taxable,
                taxRateBps: l.taxRateBps,
                extraTaxes: l.extraTaxes,
                lineTotal: totals.lineTotals[i],
              })),
              subtotal: totals.subtotal,
              discount: discount ? { ...discount, amount: totals.discountAmount } : null,
              taxes: totals.taxes,
              taxTotal: totals.taxTotal,
              grandTotal: totals.grandTotal,
              pricesIncludeTax: settings.pricesIncludeTax,
              ...paid,
              paymentStatus: 'PAID',
              status: 'COMPLETED',
              sourceDraftId: draft._id,
              idempotencyKey: input.idempotencyKey,
              createdBy: actor._id,
              createdByName: actor.name,
              finalizedAt: now,
            },
          ],
          { session },
        );
        await DraftModel.updateOne({ _id: draft._id }, { $set: { transactionId: tx._id } }, { session });
        await audit(
          actor,
          {
            action: 'BILL_FINALIZED',
            entityType: 'Transaction',
            entityId: tx._id,
            restaurantId: scope.restaurant._id,
            branchId: scope.branch._id,
            summary: `Generated bill ${tx.billNumber}${tableLabel ? ` for ${tableLabel} ${draft.groupName}` : ''} – ${tx.grandTotal} paise via ${tx.paymentMethod}`,
          },
          session,
        );
        return { transaction: toTransactionDTO(tx.toObject() as TransactionLean), replayed: false };
      } catch (err) {
        // Without a MongoDB transaction, undo the claim so the bill can be retried.
        if (!session) {
          await DraftModel.updateOne(
            { _id: draft._id, status: 'FINALIZED', transactionId: null },
            { $set: { status: 'ACTIVE', finalizedAt: null }, $inc: { version: -1 } },
          );
        }
        throw err;
      }
    });
    if (!result.replayed) {
      // Whatever the kitchen has not seen yet goes now (the whole order for counter bills); tickets
      // sent before payment get the bill number. The bill is already saved, so a kitchen problem
      // must not fail it.
      const { billNumber, orderType } = result.transaction;
      await linkBill(draftId, billNumber, orderType)
        .then(() => sendToKitchen(actor, scope, draftId))
        .catch((err) => console.error('[kitchen] could not send ticket:', err));
      // The last group billed: the table is free for any waiter again.
      const { tableId } = result.transaction;
      if (tableId) await releaseTableIfFree(new Types.ObjectId(tableId)).catch((err) => console.error('[tables] could not free the waiter:', err));
    }
    return result;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      // A concurrent request finalised the same draft – return its transaction.
      const existing = await existingFor(draftId);
      if (existing) return { transaction: toTransactionDTO(existing), replayed: true };
    }
    throw err;
  }
}

// ---------------- Manual sale ----------------

/**
 * New Bill › Add Sale: a bill of just an amount and a payment mode, without choosing dishes.
 * It is numbered, counted and voided like any bill; it has one "Manual sale" line and no tax.
 */
export async function createManualSale(
  actor: AuthUser,
  scope: BranchScope,
  input: ManualSaleInput,
): Promise<{ transaction: TransactionDTO; replayed: boolean }> {
  assertAdmin(actor);
  const byKey = await TransactionModel.findOne({ branchId: scope.branch._id, idempotencyKey: input.idempotencyKey }).lean<TransactionLean>();
  if (byKey) {
    if (!byKey.manual) throw conflict('Idempotency key was used for another bill', 'IDEMPOTENCY_MISMATCH');
    return { transaction: toTransactionDTO(byKey), replayed: true };
  }
  const paid = resolvePayments(input.paymentMethod, input.payments, input.amount);
  const settings = restaurantSettings(scope.restaurant);
  const prefix = scope.branch.code;
  const seq = await nextSequence(`bill:${scope.branch._id}:${prefix}`);
  const now = new Date();
  const tx = await TransactionModel.create({
    billNumber: formatBillNumber(prefix, seq),
    restaurantId: scope.restaurant._id,
    branchId: scope.branch._id,
    tableId: null,
    tableLabel: '',
    type: 'COUNTER',
    manual: true,
    customerName: input.customerName ?? '',
    restaurantSnapshot: {
      name: scope.restaurant.name,
      address: scope.restaurant.address ?? '',
      phone: scope.restaurant.phone ?? '',
      gstin: scope.restaurant.gstin ?? '',
      receiptFooter: settings.receiptFooter,
      logoUrl: scope.restaurant.logoUrl ?? '',
    },
    branchSnapshot: {
      name: scope.branch.name,
      code: scope.branch.code,
      address: scope.branch.address ?? '',
      phone: scope.branch.phone ?? '',
    },
    items: [
      {
        menuItemId: new Types.ObjectId(MANUAL_SALE_ITEM_ID),
        name: MANUAL_SALE_NAME,
        categoryName: MANUAL_SALE_NAME,
        imageUrl: null,
        unitPrice: input.amount,
        quantity: 1,
        taxable: false,
        taxRateBps: null,
        extraTaxes: [],
        lineTotal: input.amount,
      },
    ],
    subtotal: input.amount,
    discount: null,
    taxes: [],
    taxTotal: 0,
    grandTotal: input.amount,
    pricesIncludeTax: settings.pricesIncludeTax,
    ...paid,
    paymentStatus: 'PAID',
    status: 'COMPLETED',
    sourceDraftId: new Types.ObjectId(), // no open bill behind it
    idempotencyKey: input.idempotencyKey,
    createdBy: actor._id,
    createdByName: actor.name,
    finalizedAt: now,
  }).catch(async (err: { code?: number }) => {
    if (err.code !== 11000) throw err;
    // The same key a moment earlier (a double tap): return that sale.
    const existing = await TransactionModel.findOne({ branchId: scope.branch._id, idempotencyKey: input.idempotencyKey }).lean<TransactionLean>();
    if (!existing) throw err;
    return existing;
  });
  if (!('save' in tx)) return { transaction: toTransactionDTO(tx), replayed: true };
  await audit(actor, {
    action: 'BILL_FINALIZED',
    entityType: 'Transaction',
    entityId: tx._id,
    restaurantId: scope.restaurant._id,
    branchId: scope.branch._id,
    summary: `Manual sale ${tx.billNumber} – ${tx.grandTotal} paise via ${tx.paymentMethod}`,
  });
  return { transaction: toTransactionDTO(tx.toObject() as TransactionLean), replayed: false };
}
