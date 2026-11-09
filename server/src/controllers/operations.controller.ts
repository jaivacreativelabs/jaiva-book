/** Restaurant-level operations: tables, open bills and transactions. */
import type { Request, Response } from 'express';
import {
  createGroupSchema,
  draftUpdateSchema,
  expenseQuerySchema,
  expenseSchema,
  finalizeSchema,
  manualSaleSchema,
  kitchenAdvanceSchema,
  kitchenDishReadySchema,
  kitchenPrioritySchema,
  kitchenSendSchema,
  mergeGroupSchema,
  moveGroupSchema,
  servedQuerySchema,
  splitGroupSchema,
  tableCreateSchema,
  tableUpdateSchema,
  transactionEditSchema,
  transactionQuerySchema,
  transactionStatusChangeSchema,
} from '@rb/shared';
import { env } from '../config/env.js';
import { currentUser } from '../middleware/auth.js';
import { getBranchScope } from '../middleware/scope.js';
import * as bills from '../services/bills.service.js';
import * as expenses from '../services/expenses.service.js';
import * as kitchen from '../services/kitchen.service.js';
import * as shop from '../services/shop.service.js';
import * as groups from '../services/tableGroups.service.js';
import * as tables from '../services/tables.service.js';
import * as transactions from '../services/transactions.service.js';
import { todayIn } from '../utils/dates.js';
import { badRequest } from '../utils/errors.js';
import { parse } from '../utils/validate.js';

const id = (req: Request) => String(req.params.id);

// Tables
export const listTables = async (req: Request, res: Response) => {
  res.json({ data: await tables.listTables(getBranchScope(req), req.query.floor) });
};
export const createTable = async (req: Request, res: Response) => {
  res.status(201).json({ data: await tables.createTable(currentUser(req), getBranchScope(req), parse(tableCreateSchema, req.body)) });
};
export const updateTable = async (req: Request, res: Response) => {
  res.json({ data: await tables.updateTable(currentUser(req), getBranchScope(req), id(req), parse(tableUpdateSchema, req.body)) });
};
export const deleteTable = async (req: Request, res: Response) => {
  await tables.deactivateTable(currentUser(req), getBranchScope(req), id(req));
  res.status(204).end();
};

// Open bills (drafts)
export const counterDraft = async (req: Request, res: Response) => {
  res.json({ data: await bills.getCounterDraft(currentUser(req), getBranchScope(req)) });
};
export const tableDrafts = async (req: Request, res: Response) => {
  res.json({ data: await bills.listTableDrafts(getBranchScope(req), req.query.tableId) });
};
export const createGroup = async (req: Request, res: Response) => {
  res.status(201).json({ data: await bills.createTableGroup(currentUser(req), getBranchScope(req), parse(createGroupSchema, req.body)) });
};
export const getDraft = async (req: Request, res: Response) => {
  res.json({ data: await bills.getDraft(currentUser(req), getBranchScope(req), id(req)) });
};
export const updateDraft = async (req: Request, res: Response) => {
  res.json({ data: await bills.updateDraft(currentUser(req), getBranchScope(req), id(req), parse(draftUpdateSchema, req.body)) });
};
export const finalizeDraft = async (req: Request, res: Response) => {
  const result = await bills.finalizeDraft(currentUser(req), getBranchScope(req), id(req), parse(finalizeSchema, req.body));
  res.status(result.replayed ? 200 : 201).json({ data: result });
};
export const manualSale = async (req: Request, res: Response) => {
  const result = await bills.createManualSale(currentUser(req), getBranchScope(req), parse(manualSaleSchema, req.body));
  res.status(result.replayed ? 200 : 201).json({ data: result });
};
export const deleteDraft = async (req: Request, res: Response) => {
  const version = Number(req.query.version);
  if (!Number.isInteger(version) || version < 0) throw badRequest('version is required');
  await bills.deleteDraft(currentUser(req), getBranchScope(req), id(req), version);
  res.status(204).end();
};

// Move / merge / split table groups
export const moveGroup = async (req: Request, res: Response) => {
  res.json({ data: await groups.moveGroup(currentUser(req), getBranchScope(req), id(req), parse(moveGroupSchema, req.body)) });
};
export const mergeGroup = async (req: Request, res: Response) => {
  res.json({ data: await groups.mergeGroup(currentUser(req), getBranchScope(req), id(req), parse(mergeGroupSchema, req.body)) });
};
export const splitGroup = async (req: Request, res: Response) => {
  res.status(201).json({ data: await groups.splitGroup(currentUser(req), getBranchScope(req), id(req), parse(splitGroupSchema, req.body)) });
};

// Kitchen Display
export const sendToKitchen = async (req: Request, res: Response) => {
  parse(kitchenSendSchema, req.body ?? {}); // older apps still send an orderType: it is ignored
  res.json({ data: await kitchen.sendToKitchen(currentUser(req), getBranchScope(req), id(req)) });
};
export const kitchenBoard = async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: await kitchen.listBoard(currentUser(req), getBranchScope(req)) });
};
export const kitchenTicket = async (req: Request, res: Response) => {
  res.json({ data: await kitchen.getTicket(getBranchScope(req), id(req)) });
};
export const advanceKitchenTicket = async (req: Request, res: Response) => {
  res.json({ data: await kitchen.advanceTicket(currentUser(req), getBranchScope(req), id(req), parse(kitchenAdvanceSchema, req.body).from) });
};
export const readyKitchenDish = async (req: Request, res: Response) => {
  const body = parse(kitchenDishReadySchema, req.body);
  res.json({ data: await kitchen.setDishReady(currentUser(req), getBranchScope(req), id(req), body.menuItemId, body.ready) });
};
export const waiterBoard = async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: await kitchen.listReady(getBranchScope(req)) });
};
export const serveTicket = async (req: Request, res: Response) => {
  res.json({ data: await kitchen.serveTicket(currentUser(req), getBranchScope(req), id(req)) });
};
export const readyParcels = async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: await kitchen.listReadyParcels(currentUser(req), getBranchScope(req)) });
};
export const handOverParcel = async (req: Request, res: Response) => {
  res.json({ data: await kitchen.handOverParcel(currentUser(req), getBranchScope(req), id(req)) });
};
export const servedTickets = async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: await kitchen.listServed(currentUser(req), getBranchScope(req), parse(servedQuerySchema, req.query).date) });
};
export const kitchenTicketPriority = async (req: Request, res: Response) => {
  res.json({ data: await kitchen.setTicketPriority(currentUser(req), getBranchScope(req), id(req), parse(kitchenPrioritySchema, req.body).priority) });
};

// Transactions
export const listTransactions = async (req: Request, res: Response) => {
  const result = await transactions.listTransactions(currentUser(req), parse(transactionQuerySchema, req.query));
  res.json(result);
};
export const getTransaction = async (req: Request, res: Response) => {
  res.json({ data: await transactions.getTransaction(currentUser(req), id(req)) });
};
export const exportTransactions = async (req: Request, res: Response) => {
  const csv = await transactions.exportTransactionsCsv(currentUser(req), parse(transactionQuerySchema, req.query));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="transactions-${todayIn(env.APP_TIMEZONE)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
};
export const editTransaction = async (req: Request, res: Response) => {
  res.json({ data: await transactions.editTransaction(currentUser(req), id(req), parse(transactionEditSchema, req.body)) });
};
export const voidTransaction = async (req: Request, res: Response) => {
  const { reason } = parse(transactionStatusChangeSchema, req.body);
  res.json({ data: await transactions.changeTransactionStatus(currentUser(req), id(req), 'VOIDED', reason) });
};
export const refundTransaction = async (req: Request, res: Response) => {
  const { reason } = parse(transactionStatusChangeSchema, req.body);
  res.json({ data: await transactions.changeTransactionStatus(currentUser(req), id(req), 'REFUNDED', reason) });
};

// Expenses
export const listExpenses = async (req: Request, res: Response) => {
  res.json({ data: await expenses.listExpenses(currentUser(req), parse(expenseQuerySchema, req.query)) });
};
export const createExpense = async (req: Request, res: Response) => {
  res.status(201).json({ data: await expenses.createExpense(currentUser(req), getBranchScope(req), parse(expenseSchema, req.body)) });
};
export const updateExpense = async (req: Request, res: Response) => {
  res.json({ data: await expenses.updateExpense(currentUser(req), id(req), parse(expenseSchema, req.body)) });
};
export const deleteExpense = async (req: Request, res: Response) => {
  await expenses.deleteExpense(currentUser(req), id(req));
  res.status(204).end();
};
export const openShop = async (req: Request, res: Response) => {
  res.json({ data: await shop.setShopOpen(currentUser(req), getBranchScope(req), true) });
};
export const closeShop = async (req: Request, res: Response) => {
  res.json({ data: await shop.setShopOpen(currentUser(req), getBranchScope(req), false) });
};
export const draftKitchenTickets = async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: await kitchen.listForDraft(currentUser(req), getBranchScope(req), id(req)) });
};
