import type { Types } from 'mongoose';
import {
  BILL_EDIT_WINDOW_MINUTES,
  calculateBill,
  ORDER_TYPE_LABEL,
  type PageMeta,
  type TransactionDTO,
  type TransactionEditInput,
  type TransactionQuery,
} from '@rb/shared';
import { env } from '../config/env.js';
import type { AuthUser } from '../middleware/auth.js';
import { loadBranchScope } from '../middleware/scope.js';
import { BranchModel, RestaurantModel, TransactionModel, type Transaction } from '../models/index.js';
import { dayRange, formatDateTime } from '../utils/dates.js';
import { toCsv, paiseToDecimal } from '../utils/csv.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { editableUntil, restaurantSettings, toTransactionDTO } from '../utils/serialize.js';
import { priceLines } from './bills.service.js';
import { resolvePayments } from '../utils/payments.js';
import { escapeRegex, toObjectId } from '../utils/validate.js';
import { assertAdmin } from '../utils/roles.js';
import { audit } from './audit.service.js';

type TransactionLean = Transaction & { _id: Types.ObjectId };

/**
 * Builds the MongoDB filter for a transaction query, always constrained to what the caller
 * may see. Restaurant Admins never get results outside their assigned branches.
 */
export function transactionFilter(user: AuthUser, q: Partial<TransactionQuery>): Record<string, unknown> {
  assertAdmin(user);
  const filter: Record<string, unknown> = {};
  if (user.role !== 'SUPER_ADMIN') {
    if (q.branchId) {
      const id = toObjectId(q.branchId, 'branch');
      if (!user.branchIds.some((b) => b.equals(id))) throw forbidden('You are not assigned to this restaurant');
      filter.branchId = id;
    } else {
      filter.branchId = { $in: user.branchIds };
    }
    filter.restaurantId = { $in: user.restaurantIds };
  } else {
    if (q.restaurantId) filter.restaurantId = toObjectId(q.restaurantId, 'restaurant');
    if (q.branchId) filter.branchId = toObjectId(q.branchId, 'branch');
  }
  const { start, end } = dayRange(q.from, q.to, env.APP_TIMEZONE);
  if (start || end) filter.finalizedAt = { ...(start && { $gte: start }), ...(end && { $lt: end }) };
  // A split bill shows under each mode it was paid with.
  if (q.paymentMethod) filter.$and = [{ $or: [{ paymentMethod: q.paymentMethod }, { 'payments.method': q.paymentMethod }] }];
  if (q.status) filter.status = q.status;
  if (q.q) {
    const term = q.q.replace(/^#/, '').trim();
    const rx = { $regex: escapeRegex(term), $options: 'i' };
    filter.$or = [{ billNumber: rx }, { tableLabel: rx }, { customerName: rx }];
  }
  return filter;
}

export async function listTransactions(
  user: AuthUser,
  q: TransactionQuery,
): Promise<{ data: TransactionDTO[]; meta: PageMeta }> {
  const filter = transactionFilter(user, q);
  const [total, rows] = await Promise.all([
    TransactionModel.countDocuments(filter),
    TransactionModel.find(filter)
      .sort({ finalizedAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<TransactionLean[]>(),
  ]);
  return {
    data: rows.map(toTransactionDTO),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
  };
}

async function getAccessible(user: AuthUser, id: string) {
  assertAdmin(user);
  const tx = await TransactionModel.findById(toObjectId(id, 'transaction')).lean<TransactionLean>();
  if (!tx) throw notFound('Transaction');
  if (user.role !== 'SUPER_ADMIN' && !user.branchIds.some((b) => b.equals(tx.branchId))) {
    throw notFound('Transaction');
  }
  return tx;
}

export async function getTransaction(user: AuthUser, id: string): Promise<TransactionDTO> {
  return toTransactionDTO(await getAccessible(user, id));
}

const MAX_EXPORT_ROWS = 50_000;

export async function exportTransactionsCsv(user: AuthUser, q: Partial<TransactionQuery>): Promise<string> {
  const filter = transactionFilter(user, q);
  const rows = await TransactionModel.find(filter).sort({ finalizedAt: -1 }).limit(MAX_EXPORT_ROWS).lean<TransactionLean[]>();
  const restaurants = new Map(
    (await RestaurantModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.restaurantId)))] } }).select('name').lean<{ _id: Types.ObjectId; name: string }[]>()).map(
      (r) => [String(r._id), r.name],
    ),
  );
  const branches = new Map(
    (await BranchModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.branchId)))] } }).select('name').lean<{ _id: Types.ObjectId; name: string }[]>()).map(
      (b) => [String(b._id), b.name],
    ),
  );
  return toCsv(
    [
      'Bill No.',
      'Date & Time',
      'Restaurant',
      'Branch',
      'Table',
      'Customer',
      'Items',
      'Item Count',
      'Subtotal',
      'Discount',
      'Tax',
      'Total',
      'Payment Mode',
      'Payment Status',
      'Status',
      'Cashier',
    ],
    rows.map((t) => [
      t.billNumber,
      formatDateTime(t.finalizedAt, env.APP_TIMEZONE),
      restaurants.get(String(t.restaurantId)) ?? t.restaurantSnapshot?.name ?? '',
      branches.get(String(t.branchId)) ?? t.branchSnapshot?.name ?? '',
      t.tableLabel ? `${t.tableLabel} ${t.groupName ?? ''}`.trim() : ORDER_TYPE_LABEL[t.orderType ?? 'TAKEAWAY'],
      t.customerName ?? '',
      t.items.map((i) => `${i.name} x${i.quantity}`).join('; '),
      t.items.reduce((a, i) => a + i.quantity, 0),
      paiseToDecimal(t.subtotal),
      paiseToDecimal(t.discount?.amount ?? 0),
      paiseToDecimal(t.taxTotal),
      paiseToDecimal(t.grandTotal),
      t.payments?.length ? t.payments.map((p) => `${p.method} ${paiseToDecimal(p.amount)}`).join(' + ') : t.paymentMethod,
      t.paymentStatus,
      t.status,
      t.createdByName ?? '',
    ]),
  );
}

/**
 * Corrects a paid bill. Restaurant Admins can do this within BILL_EDIT_WINDOW_MINUTES of billing;
 * the Super Admin at any time. Lines already on the bill keep their billed price, added dishes
 * take the branch menu price, and totals are recomputed on the server. The previous version is
 * kept in `revisions` and the change is audit logged.
 */
export async function editTransaction(user: AuthUser, id: string, input: TransactionEditInput): Promise<TransactionDTO> {
  const tx = await getAccessible(user, id);
  if (tx.status !== 'COMPLETED') throw conflict(`Bill ${tx.billNumber} is ${tx.status.toLowerCase()} and cannot be edited`, 'INVALID_STATUS');
  if (tx.manual) throw conflict(`Bill ${tx.billNumber} is a manual sale – void it and add the sale again`, 'MANUAL_SALE');
  if (user.role !== 'SUPER_ADMIN' && !editableUntil(tx)) {
    throw conflict(`Bills can be edited only within ${BILL_EDIT_WINDOW_MINUTES} minutes of billing. Use Void or Refund instead.`, 'EDIT_WINDOW_CLOSED');
  }
  if ((tx.editCount ?? 0) !== input.editCount) {
    throw conflict(`Bill ${tx.billNumber} was just changed by ${tx.editedByName || 'someone else'}. The latest version has been loaded.`, 'CONFLICT', {
      current: toTransactionDTO(tx),
    });
  }

  const scope = await loadBranchScope(user, String(tx.branchId));
  const billed = new Map(tx.items.map((i) => [String(i.menuItemId), i]));
  const lines = (await priceLines(scope, input.items)).map((l) => {
    const old = billed.get(String(l.menuItemId));
    return old ? { ...l, unitPrice: old.unitPrice, taxable: old.taxable, taxRateBps: old.taxRateBps ?? null, extraTaxes: (old.extraTaxes ?? []).map((t) => ({ name: t.name ?? '', rateBps: t.rateBps ?? 0 })) } : l;
  });
  const blocked = lines.filter((l) => l.unavailable && l.quantity > (billed.get(String(l.menuItemId))?.quantity ?? 0));
  if (blocked.length) {
    throw badRequest(`${blocked.map((l) => l.name).join(', ')} ${blocked.length > 1 ? 'are' : 'is'} unavailable`, 'ITEM_UNAVAILABLE');
  }
  const settings = restaurantSettings(scope.restaurant);
  const discount =
    input.discount === undefined ? (tx.discount?.type ? { type: tx.discount.type as 'PERCENT' | 'FLAT', value: tx.discount.value ?? 0 } : null) : input.discount;
  const totals = calculateBill(lines, settings, discount);
  const now = new Date();

  const updated = await TransactionModel.findOneAndUpdate(
    // Bills made before editing existed have no editCount field; `null` matches those too.
    { _id: tx._id, status: 'COMPLETED', editCount: tx.editCount ? tx.editCount : { $in: [0, null] } },
    {
      $set: {
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
        ...resolvePayments(input.paymentMethod, input.payments, totals.grandTotal),
        ...(input.customerName !== undefined && { customerName: input.customerName }),
        editedAt: now,
        editedByName: user.name,
      },
      $inc: { editCount: 1 },
      $push: {
        revisions: {
          at: now,
          by: user._id,
          byName: user.name,
          reason: input.reason ?? '',
          items: tx.items,
          customerName: tx.customerName,
          subtotal: tx.subtotal,
          discount: tx.discount,
          taxes: tx.taxes,
          taxTotal: tx.taxTotal,
          grandTotal: tx.grandTotal,
          paymentMethod: tx.paymentMethod,
          payments: tx.payments ?? [],
        },
      },
    },
    { new: true, billEdit: true },
  ).lean<TransactionLean>();
  if (!updated) {
    const current = await getAccessible(user, id);
    throw conflict(`Bill ${tx.billNumber} was just changed. The latest version has been loaded.`, 'CONFLICT', { current: toTransactionDTO(current) });
  }
  await audit(user, {
    action: 'TRANSACTION_EDITED',
    entityType: 'Transaction',
    entityId: tx._id,
    restaurantId: tx.restaurantId,
    branchId: tx.branchId,
    summary: `Edited bill ${tx.billNumber}: ${tx.grandTotal} → ${updated.grandTotal} paise${input.reason ? ` (${input.reason})` : ''}`,
    meta: {
      before: { grandTotal: tx.grandTotal, paymentMethod: tx.paymentMethod, items: tx.items.map((i) => `${i.name} x${i.quantity}`) },
      after: { grandTotal: updated.grandTotal, paymentMethod: updated.paymentMethod, items: updated.items.map((i) => `${i.name} x${i.quantity}`) },
    },
  });
  return toTransactionDTO(updated);
}

/** Controlled correction workflow: COMPLETED → VOIDED | REFUNDED. Amounts are never edited. */
export async function changeTransactionStatus(
  user: AuthUser,
  id: string,
  next: 'VOIDED' | 'REFUNDED',
  reason: string,
): Promise<TransactionDTO> {
  const tx = await getAccessible(user, id);
  const updated = await TransactionModel.findOneAndUpdate(
    { _id: tx._id, status: 'COMPLETED' },
    {
      $set: {
        status: next,
        ...(next === 'REFUNDED' && { paymentStatus: 'REFUNDED' }),
        statusChange: { at: new Date(), by: user._id, byName: user.name, reason },
      },
    },
    { new: true },
  ).lean<TransactionLean>();
  if (!updated) throw conflict(`Bill ${tx.billNumber} is already ${tx.status.toLowerCase()}`, 'INVALID_STATUS');
  await audit(user, {
    action: next === 'VOIDED' ? 'TRANSACTION_VOIDED' : 'TRANSACTION_REFUNDED',
    entityType: 'Transaction',
    entityId: tx._id,
    restaurantId: tx.restaurantId,
    branchId: tx.branchId,
    summary: `${next === 'VOIDED' ? 'Voided' : 'Refunded'} bill ${tx.billNumber} (${tx.grandTotal} paise): ${reason}`,
    meta: { reason, previousStatus: tx.status },
  });
  return toTransactionDTO(updated);
}
