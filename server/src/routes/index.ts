import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import * as admin from '../controllers/admin.controller.js';
import * as auth from '../controllers/auth.controller.js';
import * as menu from '../controllers/menu.controller.js';
import * as ops from '../controllers/operations.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { repeatSafe } from '../middleware/idempotency.js';
import { apiNotFound } from '../middleware/error.js';
import { requireBranchScope, requireMenuScope, requireShopOpen } from '../middleware/scope.js';
import { imageUpload } from '../middleware/upload.js';
import { recordScheduledRun, runDueDailyReport } from '../services/dailyReport.service.js';
import { AppError } from '../utils/errors.js';

/** Only the scheduler knows CRON_SECRET; without one configured the endpoint stays closed. */
function cronAuth(req: Request, _res: Response, next: NextFunction) {
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  const given = Buffer.from(req.get('authorization') ?? '');
  if (!env.CRON_SECRET || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Not allowed');
  }
  next();
}

function rateLimited(message: string) {
  return (_req: unknown, _res: unknown, next: (err: unknown) => void) => next(new AppError(429, 'RATE_LIMITED', message));
}

export function createApiRouter(): Router {
  const api = Router();

  // Clients are identified by req.ip, which Express derives from X-Forwarded-For when
  // TRUST_PROXY is set. Hosts such as Vercel also send the standard `Forwarded` header, which
  // Express ignores – that is expected, so the limiter's warning about it is turned off.
  const validate = { forwardedHeader: false } as const;

  // Only failed attempts count, so busy counters are not locked out by their own logins.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.LOGIN_RATE_LIMIT_MAX,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate,
    handler: rateLimited('Too many sign-in attempts. Try again in 15 minutes.'),
  });
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 1200,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate,
    handler: rateLimited('Too many requests. Slow down a little.'),
  });

  api.use(apiLimiter);
  api.use(csrfProtection);
  api.use(repeatSafe);

  api.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' } });
  });

  // ---- Auth ----
  const authRouter = Router();
  authRouter.post('/login', loginLimiter, auth.login);
  authRouter.get('/demo-accounts', auth.demoAccounts);
  authRouter.post('/demo-login', loginLimiter, auth.demoLogin);
  authRouter.post('/logout', auth.logout);
  authRouter.get('/me', authenticate, auth.me);
  authRouter.post('/change-password', authenticate, auth.changePassword);
  api.use('/auth', authRouter);

  // ---- Super Admin ----
  const adminRouter = Router();
  adminRouter.use(authenticate, requireRole('SUPER_ADMIN'));
  adminRouter.get('/restaurants', admin.listRestaurants);
  adminRouter.post('/restaurants', admin.createRestaurant);
  adminRouter.get('/restaurants/:id', admin.getRestaurant);
  adminRouter.patch('/restaurants/:id', admin.updateRestaurant);
  adminRouter.patch('/restaurants/:id/status', admin.setRestaurantStatus);
  adminRouter.delete('/restaurants/:id', admin.deleteRestaurant);
  adminRouter.patch('/restaurants/:id/settings', admin.updateRestaurantSettings);
  adminRouter.post('/restaurants/:id/logo', imageUpload, admin.uploadRestaurantLogo);
  adminRouter.delete('/restaurants/:id/logo', admin.removeRestaurantLogo);
  adminRouter.get('/branches', admin.listBranches);
  adminRouter.post('/branches', admin.createBranch);
  adminRouter.patch('/branches/:id', admin.updateBranch);
  adminRouter.patch('/branches/:id/status', admin.setBranchStatus);
  adminRouter.delete('/branches/:id', admin.deleteBranch);
  adminRouter.get('/users', admin.listUsers);
  adminRouter.post('/users', admin.createUser);
  adminRouter.patch('/users/:id', admin.updateUser);
  adminRouter.patch('/users/:id/status', admin.setUserStatus);
  adminRouter.post('/users/:id/reset-password', admin.resetUserPassword);
  adminRouter.get('/demo-accounts', admin.listDemoAccounts);
  adminRouter.patch('/demo-accounts/:id', admin.updateDemoAccount);
  adminRouter.get('/daily-report', admin.getDailyReport);
  adminRouter.put('/daily-report', admin.updateDailyReport);
  adminRouter.get('/daily-report/preview', admin.previewDailyReport);
  adminRouter.post('/daily-report/send', admin.sendDailyReportNow);
  adminRouter.get('/analytics/overview', admin.analyticsOverview);
  adminRouter.get('/reports/transactions.csv', admin.transactionsCsv);
  adminRouter.get('/reports/sales.csv', admin.salesCsv);
  adminRouter.get('/reports/restaurants.csv', admin.restaurantsCsv);
  adminRouter.get('/reports/branches.csv', admin.branchesCsv);
  adminRouter.get('/audit-logs', admin.auditLogs);
  api.use('/admin', adminRouter);

  // ---- Scheduled jobs (schedulers send `Authorization: Bearer $CRON_SECRET`) ----
  api.get(
    '/cron/daily-report',
    async (req, _res, next) => {
      // Without a secret Vercel Cron is refused every day; note it so the page can say why.
      if (!env.CRON_SECRET && /^vercel-cron\//.test(req.get('user-agent') ?? '')) {
        await recordScheduledRun('refused: CRON_SECRET is not set on the server');
      }
      next();
    },
    cronAuth,
    async (_req, res) => {
      // A scheduler firing on the minute may land a moment early, so allow one minute.
      const result = await runDueDailyReport(new Date(Date.now() + 60_000));
      await recordScheduledRun(result.status === 'sent' ? `sent to ${result.recipients.join(', ')}` : result.reason);
      res.json({ data: result });
    },
  );

  // ---- Menu (both roles, scoped) ----
  const menuRouter = Router();
  menuRouter.use(authenticate, requireMenuScope);
  menuRouter.get('/categories', menu.listCategories);
  menuRouter.post('/categories', menu.createCategory);
  menuRouter.post('/categories/reorder', menu.reorderCategories);
  menuRouter.patch('/categories/:id', menu.updateCategory);
  menuRouter.patch('/categories/:id/status', menu.setCategoryStatus);
  menuRouter.delete('/categories/:id', menu.deleteCategory);
  menuRouter.get('/items', menu.listItems);
  menuRouter.post('/items', menu.createItem);
  menuRouter.post('/items/reorder', menu.reorderItems);
  menuRouter.patch('/items/:id', menu.updateItem);
  menuRouter.patch('/items/:id/availability', menu.setAvailability);
  menuRouter.patch('/items/:id/pin', menu.setPinned);
  menuRouter.put('/items/:id/variants', menu.setVariants);
  menuRouter.delete('/items/:id/override', menu.removeOverride);
  menuRouter.post('/items/:id/image', imageUpload, menu.uploadImage);
  menuRouter.delete('/items/:id/image', menu.removeImage);
  menuRouter.post('/items/:id/archive', menu.archiveItem);
  menuRouter.post('/items/:id/restore', menu.restoreItem);
  api.use('/menu', menuRouter);

  // ---- Tables & open bills (branch scoped) ----
  const tablesRouter = Router();
  tablesRouter.use(authenticate, requireBranchScope);
  tablesRouter.get('/', ops.listTables);
  tablesRouter.post('/', ops.createTable);
  tablesRouter.patch('/:id', ops.updateTable);
  tablesRouter.delete('/:id', ops.deleteTable);
  api.use('/tables', tablesRouter);

  // ---- Open / Close Shop (closing emails the day's report and locks billing) ----
  const shopRouter = Router();
  shopRouter.use(authenticate, requireRole('RESTAURANT_ADMIN', 'SUPER_ADMIN'), requireBranchScope);
  shopRouter.post('/open', ops.openShop);
  shopRouter.post('/close', ops.closeShop);
  api.use('/shop', shopRouter);

  const billsRouter = Router();
  billsRouter.use(authenticate, requireBranchScope, requireShopOpen);
  billsRouter.get('/counter', ops.counterDraft);
  billsRouter.get('/', ops.tableDrafts);
  billsRouter.post('/table-groups', ops.createGroup);
  billsRouter.post('/manual-sale', ops.manualSale);
  billsRouter.get('/:id', ops.getDraft);
  billsRouter.put('/:id', ops.updateDraft);
  billsRouter.post('/:id/finalize', ops.finalizeDraft);
  billsRouter.post('/:id/kitchen', ops.sendToKitchen);
  billsRouter.post('/:id/move', ops.moveGroup);
  billsRouter.post('/:id/merge', ops.mergeGroup);
  billsRouter.post('/:id/split', ops.splitGroup);
  billsRouter.delete('/:id', ops.deleteDraft);
  api.use('/bills', billsRouter);

  const kitchenRouter = Router();
  kitchenRouter.use(authenticate, requireBranchScope);
  kitchenRouter.get('/tickets', ops.kitchenBoard);
  kitchenRouter.get('/tickets/:id', ops.kitchenTicket);
  kitchenRouter.post('/tickets/:id/advance', ops.advanceKitchenTicket);
  kitchenRouter.post('/tickets/:id/priority', ops.kitchenTicketPriority);
  // Ready parcels and handing them over: the counter's job (admins only, checked in the service)
  kitchenRouter.get('/parcels', ops.readyParcels);
  kitchenRouter.post('/tickets/:id/handed-over', ops.handOverParcel);
  api.use('/kitchen', kitchenRouter);

  // ---- Waiter board (food the kitchen marked Ready) ----
  const waiterRouter = Router();
  waiterRouter.use(authenticate, requireBranchScope);
  waiterRouter.get('/tickets', ops.waiterBoard);
  waiterRouter.post('/tickets/:id/served', ops.serveTicket);
  api.use('/waiter', waiterRouter);

  // ---- Transactions (role-filtered in the service) ----
  const txRouter = Router();
  txRouter.use(authenticate);
  txRouter.get('/', ops.listTransactions);
  txRouter.get('/export.csv', ops.exportTransactions);
  txRouter.get('/:id', ops.getTransaction);
  txRouter.put('/:id', ops.editTransaction);
  txRouter.post('/:id/void', ops.voidTransaction);
  txRouter.post('/:id/refund', ops.refundTransaction);
  api.use('/transactions', txRouter);

  // ---- Expenses (role-filtered in the service; adding one needs the branch) ----
  const expenseRouter = Router();
  expenseRouter.use(authenticate);
  expenseRouter.get('/', ops.listExpenses);
  expenseRouter.post('/', requireBranchScope, ops.createExpense);
  expenseRouter.put('/:id', ops.updateExpense);
  expenseRouter.delete('/:id', ops.deleteExpense);
  api.use('/expenses', expenseRouter);

  api.use(apiNotFound);
  return api;
}
