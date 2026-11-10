import type { Request, Response } from 'express';
import {
  analyticsQuerySchema,
  auditQuerySchema,
  branchCreateSchema,
  branchUpdateSchema,
  dailyReportSendSchema,
  dailyReportSettingsSchema,
  demoAccountUpdateSchema,
  kitchenStationsSchema,
  resetPasswordSchema,
  restaurantCreateSchema,
  restaurantSettingsSchema,
  restaurantUpdateSchema,
  salesReportQuerySchema,
  statusSchema,
  transactionQuerySchema,
  userCreateSchema,
  userUpdateSchema,
} from '@rb/shared';
import { currentUser } from '../middleware/auth.js';
import { AuditLogModel } from '../models/index.js';
import * as admin from '../services/admin.service.js';
import * as analytics from '../services/analytics.service.js';
import * as dailyReport from '../services/dailyReport.service.js';
import * as demo from '../services/demo.service.js';
import { exportTransactionsCsv } from '../services/transactions.service.js';
import { todayIn } from '../utils/dates.js';
import { env } from '../config/env.js';
import { toAuditLogDTO } from '../utils/serialize.js';
import { parse, toObjectId } from '../utils/validate.js';

const id = (req: Request) => String(req.params.id);

// Restaurants
export const listRestaurants = async (req: Request, res: Response) => {
  res.json({ data: await admin.listRestaurants(String(req.query.status ?? '')) });
};
export const createRestaurant = async (req: Request, res: Response) => {
  res.status(201).json({ data: await admin.createRestaurant(currentUser(req), parse(restaurantCreateSchema, req.body)) });
};
export const getRestaurant = async (req: Request, res: Response) => {
  res.json({ data: await admin.getRestaurantDetail(id(req)) });
};
export const uploadRestaurantLogo = async (req: Request, res: Response) => {
  res.json({ data: await admin.setRestaurantLogo(currentUser(req), id(req), req.file) });
};
export const removeRestaurantLogo = async (req: Request, res: Response) => {
  res.json({ data: await admin.setRestaurantLogo(currentUser(req), id(req), null) });
};
export const updateRestaurant = async (req: Request, res: Response) => {
  res.json({ data: await admin.updateRestaurant(currentUser(req), id(req), parse(restaurantUpdateSchema, req.body)) });
};
export const setRestaurantStatus = async (req: Request, res: Response) => {
  const { status } = parse(statusSchema, req.body);
  res.json({ data: await admin.setRestaurantStatus(currentUser(req), id(req), status) });
};
export const deleteRestaurant = async (req: Request, res: Response) => {
  res.json({ data: await admin.deleteRestaurant(currentUser(req), id(req)) });
};
export const deleteBranch = async (req: Request, res: Response) => {
  res.json({ data: await admin.deleteBranch(currentUser(req), id(req)) });
};
export const updateRestaurantSettings = async (req: Request, res: Response) => {
  res.json({
    data: await admin.updateRestaurantSettings(currentUser(req), id(req), parse(restaurantSettingsSchema, req.body)),
  });
};

// Branches
export const listBranches = async (req: Request, res: Response) => {
  res.json({ data: await admin.listBranches(req.query.restaurantId) });
};
export const createBranch = async (req: Request, res: Response) => {
  res.status(201).json({ data: await admin.createBranch(currentUser(req), parse(branchCreateSchema, req.body)) });
};
export const updateBranch = async (req: Request, res: Response) => {
  res.json({ data: await admin.updateBranch(currentUser(req), id(req), parse(branchUpdateSchema, req.body)) });
};
export const setKitchenStations = async (req: Request, res: Response) => {
  res.json({ data: await admin.setKitchenStations(currentUser(req), id(req), parse(kitchenStationsSchema, req.body)) });
};
export const setBranchStatus = async (req: Request, res: Response) => {
  const { status } = parse(statusSchema, req.body);
  res.json({ data: await admin.setBranchStatus(currentUser(req), id(req), status) });
};

// Restaurant Admin accounts
export const listUsers = async (req: Request, res: Response) => {
  res.json({ data: await admin.listRestaurantAdmins(req.query) });
};
export const createUser = async (req: Request, res: Response) => {
  res.status(201).json({ data: await admin.createRestaurantAdmin(currentUser(req), parse(userCreateSchema, req.body)) });
};
export const updateUser = async (req: Request, res: Response) => {
  res.json({ data: await admin.updateRestaurantAdmin(currentUser(req), id(req), parse(userUpdateSchema, req.body)) });
};
export const setUserStatus = async (req: Request, res: Response) => {
  const { status } = parse(statusSchema, req.body);
  res.json({ data: await admin.setRestaurantAdminStatus(currentUser(req), id(req), status) });
};
export const deleteUser = async (req: Request, res: Response) => {
  res.json({ data: await admin.deleteRestaurantAdmin(currentUser(req), id(req)) });
};
export const resetUserPassword =async (req: Request, res: Response) => {
  const { password } = parse(resetPasswordSchema, req.body);
  res.json({ data: await admin.resetRestaurantAdminPassword(currentUser(req), id(req), password) });
};

// Demo login buttons
export const listDemoAccounts = async (_req: Request, res: Response) => {
  res.json({ data: await demo.listDemoSettings() });
};
export const updateDemoAccount = async (req: Request, res: Response) => {
  res.json({ data: await demo.updateDemoSetting(currentUser(req), id(req), parse(demoAccountUpdateSchema, req.body)) });
};

// Daily report email
export const getDailyReport = async (_req: Request, res: Response) => {
  res.json({ data: await dailyReport.getDailyReportSettings() });
};
export const updateDailyReport = async (req: Request, res: Response) => {
  res.json({ data: await dailyReport.updateDailyReportSettings(currentUser(req), parse(dailyReportSettingsSchema, req.body)) });
};
export const previewDailyReport = async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { html: await dailyReport.previewDailyReport() } });
};
export const sendDailyReportNow = async (req: Request, res: Response) => {
  const { to } = parse(dailyReportSendSchema, req.body ?? {});
  res.json({ data: await dailyReport.sendDailyReport({ manual: currentUser(req), to }) });
};

// Analytics & reports
export const analyticsOverview = async (req: Request, res: Response) => {
  res.json({ data: await analytics.analyticsOverview(parse(analyticsQuerySchema, req.query)) });
};

function sendCsv(res: Response, name: string, csv: string) {
  const stamp = todayIn(env.APP_TIMEZONE);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
}

export const transactionsCsv = async (req: Request, res: Response) => {
  const q = parse(transactionQuerySchema, req.query);
  sendCsv(res, 'transactions', await exportTransactionsCsv(currentUser(req), q));
};
export const salesCsv = async (req: Request, res: Response) => {
  const q = parse(salesReportQuerySchema, req.query);
  sendCsv(res, `sales-${q.granularity === 'month' ? 'monthly' : 'daily'}`, await analytics.salesReportCsv(q));
};
export const restaurantsCsv = async (req: Request, res: Response) => {
  sendCsv(res, 'restaurant-sales', await analytics.restaurantReportCsv(parse(analyticsQuerySchema, req.query)));
};
export const branchesCsv = async (req: Request, res: Response) => {
  sendCsv(res, 'branch-sales', await analytics.branchReportCsv(parse(analyticsQuerySchema, req.query)));
};

export const auditLogs = async (req: Request, res: Response) => {
  const q = parse(auditQuerySchema, req.query);
  const filter: Record<string, unknown> = {};
  if (q.restaurantId) filter.restaurantId = toObjectId(q.restaurantId, 'restaurant');
  if (q.action) filter.action = q.action.toUpperCase();
  const [total, rows] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
  ]);
  res.json({
    data: rows.map((r) => toAuditLogDTO(r)),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
  });
};
