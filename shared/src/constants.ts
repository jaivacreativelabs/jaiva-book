/** The app's name: every dashboard, the sign-in page and the browser tab. */
export const APP_NAME = 'Jaiva Book';

/**
 * SUPER_ADMIN: everything. RESTAURANT_ADMIN: one branch's billing, menu, tables, transactions.
 * KITCHEN: one branch's Kitchen Display only (no bills, sales or prices).
 * WAITER: one branch's Waiter board only – food the kitchen marked Ready, to serve.
 */
export const ROLES = ['SUPER_ADMIN', 'RESTAURANT_ADMIN', 'KITCHEN', 'WAITER'] as const;
export type Role = (typeof ROLES)[number];
/** Branch accounts the Super Admin creates and manages. */
export const STAFF_ROLES = ['RESTAURANT_ADMIN', 'KITCHEN', 'WAITER'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const RECORD_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const ITEM_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const TRANSACTION_STATUSES = ['COMPLETED', 'VOIDED', 'REFUNDED'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const PAYMENT_STATUSES = ['PAID', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const DRAFT_STATUSES = ['ACTIVE', 'FINALIZED', 'DELETED'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/**
 * Kitchen ticket pipeline: NEW → PREPARING → READY → SERVED (off the board).
 * CANCELLED: the order was deleted before the kitchen started it.
 */
export const KITCHEN_STATUSES = ['NEW', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'] as const;
export type KitchenStatus = (typeof KITCHEN_STATUSES)[number];
export const KITCHEN_BOARD_STATUSES = ['NEW', 'PREPARING', 'READY'] as const;
export const KITCHEN_NEXT: Partial<Record<KitchenStatus, KitchenStatus>> = {
  NEW: 'PREPARING',
  PREPARING: 'READY',
  READY: 'SERVED',
};

export const DRAFT_TYPES = ['TABLE', 'COUNTER'] as const;
export type DraftType = (typeof DRAFT_TYPES)[number];

/** How a bill's food is served. Table bills are always DINE_IN; New Bill asks. */
export const ORDER_TYPES = ['DINE_IN', 'TAKEAWAY'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
/** A sale entered as just an amount (New Bill › Add Sale): one line with this name, no tax. */
export const MANUAL_SALE_NAME = 'Manual sale';
/** Shared by every manual-sale line, so reports add them up as one "item". */
export const MANUAL_SALE_ITEM_ID = '000000000000000000000000';
export const ORDER_TYPE_LABEL: Record<OrderType, string> = { DINE_IN: 'Dine In', TAKEAWAY: 'Take Away' };

export const TABLE_SHAPES = ['SQUARE', 'ROUND'] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];

/** Status a user can set on a table. Occupancy is derived from active drafts. */
export const TABLE_STATUSES = ['AVAILABLE', 'RESERVED'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const TABLE_OCCUPANCY = ['AVAILABLE', 'PARTIAL', 'FULL', 'RESERVED'] as const;
export type TableOccupancy = (typeof TABLE_OCCUPANCY)[number];

export const DISCOUNT_TYPES = ['PERCENT', 'FLAT'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const LIMITS = {
  maxPricePaise: 10_000_000, // ₹1,00,000 per item
  maxQuantity: 999,
  maxBillLines: 200,
  maxSeats: 30,
  maxTaxes: 5,
  maxPageSize: 100,
  maxImageBytes: 2 * 1024 * 1024,
  maxVariants: 12,
  maxDishNote: 60,
} as const;

/** A generated (paid) bill can be corrected for this long; every edit keeps the old version. */
export const BILL_EDIT_WINDOW_MINUTES = 30;

/** What a branch spends money on (shown in the Expenses page and the daily report). */
export const EXPENSE_CATEGORIES = ['GROCERIES', 'VEGETABLES', 'MILK', 'SNACKS', 'GAS', 'SALARY', 'RENT', 'ELECTRICITY', 'MAINTENANCE', 'OTHER'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  GROCERIES: 'Groceries',
  VEGETABLES: 'Vegetables',
  MILK: 'Milk',
  SNACKS: 'Snacks',
  GAS: 'Gas',
  SALARY: 'Salary',
  RENT: 'Rent',
  ELECTRICITY: 'Electricity',
  MAINTENANCE: 'Maintenance',
  OTHER: 'Other',
};
/** Restaurant Admins can correct or delete an expense for this long; the Super Admin any time. */
export const EXPENSE_EDIT_WINDOW_MINUTES = 30;
/** ₹1,00,00,000 per expense (rent and salaries are larger than any menu price). */
export const MAX_EXPENSE_PAISE = 1_000_000_000;

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'rb-client';
export const BRANCH_HEADER = 'x-branch-id';
/** One random key per save; a retried save with the same key gets the first answer back. */
export const REQUEST_KEY_HEADER = 'idempotency-key';

/**
 * Bill numbers are the branch code + a running number, e.g. ITH0001. A code ending in a digit
 * gets a dash (AN1-0001) so the series stays readable.
 */
export const formatBillNumber = (branchCode: string, seq: number) =>
  `${branchCode}${/\d$/.test(branchCode) ? '-' : ''}${String(seq).padStart(4, '0')}`;
