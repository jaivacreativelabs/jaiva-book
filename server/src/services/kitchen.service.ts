/**
 * Kitchen Display: order tickets per branch. A table order sends what was added since its last
 * ticket; generating a bill sends whatever has not gone to the kitchen yet. Only branches with
 * `kitchenDisplay` switched on (Super Admin) use it.
 *
 * Counter orders get a token for the day. Take-away ones are parcels: when Ready, the counter
 * hands them over (stored as SERVED) instead of a waiter serving them.
 */
import type { Types } from 'mongoose';
import { KITCHEN_BOARD_STATUSES, KITCHEN_NEXT, type KitchenStatus, type KitchenTicketDTO, type OrderType } from '@rb/shared';
import { env } from '../config/env.js';
import type { AuthUser } from '../middleware/auth.js';
import type { BranchScope } from '../middleware/scope.js';
import { DraftModel, KitchenTicketModel, nextSequence, TableModel, TransactionModel, type Draft, type KitchenTicket } from '../models/index.js';
import { todayIn } from '../utils/dates.js';
import { AppError, conflict, forbidden, notFound } from '../utils/errors.js';
import { assertAdmin } from '../utils/roles.js';
import { toObjectId } from '../utils/validate.js';

type TicketLean = KitchenTicket & { _id: Types.ObjectId; createdAt: Date };
type DraftLean = Draft & { _id: Types.ObjectId };

/** Tickets from before order types count by their order: counter orders were parcels. */
const orderTypeOf = (t: Pick<TicketLean, 'orderType' | 'type'>): OrderType => t.orderType ?? (t.type === 'TABLE' ? 'DINE_IN' : 'TAKEAWAY');
const PARCEL = [{ orderType: 'TAKEAWAY' }, { orderType: null, type: 'COUNTER' }];

export function toKitchenTicketDTO(t: TicketLean): KitchenTicketDTO {
  return {
    id: String(t._id),
    number: t.number,
    branchId: String(t.branchId),
    draftId: String(t.draftId),
    type: t.type,
    tableLabel: t.tableLabel ?? '',
    groupName: t.groupName ?? '',
    orderType: orderTypeOf(t),
    token: t.token ?? null,
    billNumber: t.billNumber ?? '',
    items: t.items.map((i) => ({ menuItemId: String(i.menuItemId), name: i.name, quantity: i.quantity })),
    status: t.status,
    priority: t.priority,
    createdByName: t.createdByName ?? '',
    createdAt: new Date(t.createdAt).toISOString(),
    statusAt: new Date(t.statusAt).toISOString(),
    servedByName: t.servedByName ?? '',
  };
}

function assertKitchenOn(scope: BranchScope) {
  if (!scope.branch.kitchenDisplay) throw new AppError(409, 'KITCHEN_OFF', 'The Kitchen Display is not switched on for this restaurant');
}

/** What is on the bill but not yet sent to the kitchen. */
function unsentItems(draft: DraftLean) {
  const sent = new Map(draft.kitchenSent.map((s) => [String(s.menuItemId), s.quantity]));
  return draft.items
    .map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity - (sent.get(String(i.menuItemId)) ?? 0) }))
    .filter((i) => i.quantity > 0);
}

/**
 * Sends the not-yet-sent items of an order to the kitchen as one ticket. Returns null when there
 * is nothing new (or the branch does not use the Kitchen Display). Safe to call twice: the
 * `kitchenRev` check lets only one caller record the same items. `orderType` is New Bill's
 * Dine In / Take Away before the bill exists; once billed, the bill's own one is used.
 */
export async function sendToKitchen(
  actor: AuthUser,
  scope: BranchScope,
  draftId: string | Types.ObjectId,
  orderType?: OrderType,
): Promise<KitchenTicketDTO | null> {
  if (!scope.branch.kitchenDisplay) return null;
  const draft = await DraftModel.findOne({ _id: toObjectId(String(draftId), 'bill'), branchId: scope.branch._id, status: { $ne: 'DELETED' } }).lean<DraftLean>();
  if (!draft) throw notFound('Bill');
  if (actor.role === 'WAITER' && draft.type !== 'TABLE') throw forbidden('Waiters can only take table orders');
  const items = unsentItems(draft);
  if (!items.length) return null;

  // Remember the most ever sent per dish: lowering a quantity later and raising it again must
  // not send the same food twice.
  const sent = new Map(draft.kitchenSent.map((s) => [String(s.menuItemId), { menuItemId: s.menuItemId, quantity: s.quantity }]));
  for (const i of draft.items) {
    const prev = sent.get(String(i.menuItemId));
    sent.set(String(i.menuItemId), { menuItemId: i.menuItemId, quantity: Math.max(prev?.quantity ?? 0, i.quantity) });
  }
  const claimed = await DraftModel.updateOne(
    { _id: draft._id, kitchenRev: draft.kitchenRev ?? 0 },
    { $set: { kitchenSent: [...sent.values()] }, $inc: { kitchenRev: 1 } },
  );
  if (claimed.modifiedCount !== 1) return null; // someone else just sent these items

  const date = todayIn(env.APP_TIMEZONE).replaceAll('-', '');
  const seq = await nextSequence(`kot:${scope.branch._id}:${date}`);
  const table = draft.tableId ? await TableModel.findById(draft.tableId).select('label').lean<{ label: string }>() : null;
  const bill = draft.transactionId
    ? await TransactionModel.findById(draft.transactionId).select('billNumber orderType').lean<{ billNumber: string; orderType: OrderType | null }>()
    : null;
  const [ticket] = await KitchenTicketModel.create([
    {
      restaurantId: scope.restaurant._id,
      branchId: scope.branch._id,
      number: `${date}-${String(seq).padStart(4, '0')}`,
      draftId: draft._id,
      type: draft.type,
      tableLabel: table?.label ?? '',
      groupName: draft.type === 'TABLE' ? (draft.groupName ?? '') : '',
      orderType: draft.type === 'TABLE' ? 'DINE_IN' : (bill?.orderType ?? orderType ?? 'TAKEAWAY'),
      token: draft.type === 'COUNTER' ? await tokenFor(scope, draft, date) : null,
      billNumber: bill?.billNumber ?? '',
      items,
      createdBy: actor._id,
      createdByName: actor.name,
    },
  ]);
  return toKitchenTicketDTO(ticket.toObject() as TicketLean);
}

/** A counter order's token: the next of the day on its first ticket, the same one after that. */
async function tokenFor(scope: BranchScope, draft: DraftLean, date: string): Promise<number> {
  if (draft.kitchenToken) return draft.kitchenToken;
  const seq = await nextSequence(`token:${scope.branch._id}:${date}`);
  const set = await DraftModel.updateOne({ _id: draft._id, kitchenToken: null }, { $set: { kitchenToken: seq } });
  if (set.modifiedCount === 1) return seq;
  const current = await DraftModel.findById(draft._id).select('kitchenToken').lean<{ kitchenToken: number | null }>();
  return current?.kitchenToken ?? seq;
}

/** A bill was generated: its tickets show the bill number and New Bill's Dine In / Take Away. */
export async function linkBill(draftId: Types.ObjectId, billNumber: string, orderType: OrderType): Promise<void> {
  await KitchenTicketModel.updateMany({ draftId }, { $set: { billNumber, orderType } });
}

/** The board: every ticket still in the kitchen, priority first, then oldest first. */
export async function listBoard(scope: BranchScope): Promise<KitchenTicketDTO[]> {
  assertKitchenOn(scope);
  const rows = await KitchenTicketModel.find({ branchId: scope.branch._id, status: { $in: KITCHEN_BOARD_STATUSES } })
    .sort({ priority: -1, createdAt: 1 })
    .limit(500)
    .lean<TicketLean[]>();
  return rows.map(toKitchenTicketDTO);
}

async function findTicket(scope: BranchScope, id: string) {
  const t = await KitchenTicketModel.findOne({ _id: toObjectId(id, 'ticket'), branchId: scope.branch._id }).lean<TicketLean>();
  if (!t) throw notFound('Ticket');
  return t;
}

/** Moves a ticket one step on. `from` must match, so two screens cannot skip a step. */
export async function advanceTicket(actor: AuthUser, scope: BranchScope, id: string, from: KitchenStatus): Promise<KitchenTicketDTO> {
  assertKitchenOn(scope);
  const next = KITCHEN_NEXT[from];
  if (!next) throw conflict('This ticket is already finished', 'INVALID_STATUS');
  const t = await findTicket(scope, id);
  // A Ready parcel waits at the counter until the customer collects it.
  if (from === 'READY' && orderTypeOf(t) === 'TAKEAWAY') assertAdmin(actor, 'Parcels are handed over at the counter');
  const updated = await KitchenTicketModel.findOneAndUpdate(
    { _id: t._id, status: from },
    { $set: { status: next, statusAt: new Date(), ...(next === 'SERVED' && { servedBy: actor._id, servedByName: actor.name }) } },
    { new: true },
  ).lean<TicketLean>();
  if (!updated) {
    throw conflict(`Ticket #${t.number} was already moved to ${t.status.toLowerCase()}`, 'CONFLICT', { current: toKitchenTicketDTO(t) });
  }
  return toKitchenTicketDTO(updated);
}

/** Waiter board: food the kitchen marked Ready, longest waiting first (priority on top). Parcels go to the counter instead. */
export async function listReady(scope: BranchScope): Promise<KitchenTicketDTO[]> {
  assertKitchenOn(scope);
  const rows = await KitchenTicketModel.find({ branchId: scope.branch._id, status: 'READY', $nor: PARCEL })
    .sort({ priority: -1, statusAt: 1 })
    .limit(200)
    .lean<TicketLean[]>();
  return rows.map(toKitchenTicketDTO);
}

/** A waiter carried a Ready order to its table. */
export function serveTicket(actor: AuthUser, scope: BranchScope, id: string): Promise<KitchenTicketDTO> {
  return advanceTicket(actor, scope, id, 'READY');
}

/** New Bill: parcels the kitchen marked Ready, waiting to be collected (longest waiting first). */
export async function listReadyParcels(actor: AuthUser, scope: BranchScope): Promise<KitchenTicketDTO[]> {
  assertAdmin(actor);
  assertKitchenOn(scope);
  const rows = await KitchenTicketModel.find({ branchId: scope.branch._id, status: 'READY', $or: PARCEL })
    .sort({ statusAt: 1 })
    .limit(200)
    .lean<TicketLean[]>();
  return rows.map(toKitchenTicketDTO);
}

/** The counter gave a Ready parcel to its customer: it leaves every board, recording who handed it over. */
export async function handOverParcel(actor: AuthUser, scope: BranchScope, id: string): Promise<KitchenTicketDTO> {
  assertAdmin(actor, 'Parcels are handed over at the counter');
  const t = await findTicket(scope, id);
  if (orderTypeOf(t) !== 'TAKEAWAY') throw conflict('Only parcels are handed over at the counter', 'NOT_PARCEL');
  return advanceTicket(actor, scope, id, 'READY');
}

export async function setTicketPriority(scope: BranchScope, id: string, priority: boolean): Promise<KitchenTicketDTO> {
  assertKitchenOn(scope);
  const t = await findTicket(scope, id);
  const updated = await KitchenTicketModel.findByIdAndUpdate(t._id, { $set: { priority } }, { new: true }).lean<TicketLean>();
  return toKitchenTicketDTO(updated!);
}

/** For the printed kitchen slip. Works even after the branch switches the board off. */
export async function getTicket(scope: BranchScope, id: string): Promise<KitchenTicketDTO> {
  return toKitchenTicketDTO(await findTicket(scope, id));
}

/** An order was deleted: tickets the kitchen has not started yet are cancelled. */
export async function cancelUnstarted(draftId: Types.ObjectId): Promise<void> {
  await KitchenTicketModel.updateMany({ draftId, status: 'NEW' }, { $set: { status: 'CANCELLED', statusAt: new Date() } });
}
