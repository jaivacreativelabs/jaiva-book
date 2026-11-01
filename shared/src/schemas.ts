/**
 * Request validation schemas shared by the server (authoritative) and the client (form hints).
 * Every body schema is strict: unknown keys such as `role`, `price` on bills or `total` are
 * rejected instead of silently ignored.
 */
import { z } from 'zod';
import {
  DISCOUNT_TYPES,
  EXPENSE_CATEGORIES,
  KITCHEN_STATUSES,
  LIMITS,
  MAX_EXPENSE_PAISE,
  ORDER_TYPES,
  PAYMENT_METHODS,
  RECORD_STATUSES,
  STAFF_ROLES,
  TABLE_SHAPES,
  TABLE_STATUSES,
  TRANSACTION_STATUSES,
} from './constants.js';

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const name = (max: number) => z.string().trim().min(1, 'Required').max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const optionalEmail = z.union([z.literal(''), z.string().trim().toLowerCase().email('Invalid email')]).optional();
const optionalPhone = z
  .string()
  .trim()
  .max(20)
  .regex(/^[0-9+\-() ]*$/, 'Invalid phone number')
  .optional();

export const passwordSchema = z
  .string()
  .min(8, 'At least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/\d/, 'Must contain a number');

export const pricePaiseSchema = z
  .number()
  .int('Price must be whole paise')
  .min(0, 'Price cannot be negative')
  .max(LIMITS.maxPricePaise, 'Price is too high');

// ---------- Auth ----------
export const loginSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email('Invalid email').max(200),
  password: z.string().min(1, 'Required').max(200),
});

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

// ---------- Restaurants / branches ----------
export const statusSchema = z.strictObject({ status: z.enum(RECORD_STATUSES) });

const restaurantFields = {
  name: name(100),
  phone: optionalPhone,
  email: optionalEmail,
  address: optionalText(300),
  gstin: optionalText(20),
};
export const restaurantCreateSchema = z.strictObject({
  ...restaurantFields,
  /** Bills are numbered with it (KKV0001 …); left out → the name's initials */
  billCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,10}$/, 'Letters and digits only, max 10')
    .optional(),
});
export const restaurantUpdateSchema = z.strictObject(restaurantFields).partial();

export const taxRateSchema = z.strictObject({
  name: name(30),
  rateBps: z.number().int().min(0).max(10_000),
});

export const restaurantSettingsSchema = z.strictObject({
  taxes: z.array(taxRateSchema).max(LIMITS.maxTaxes),
  pricesIncludeTax: z.boolean(),
  receiptFooter: z.string().trim().max(200),
});

const branchCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,10}$/, 'Letters and digits only, max 10');

export const branchCreateSchema = z.strictObject({
  restaurantId: objectIdSchema,
  name: name(100),
  code: branchCode,
  address: optionalText(300),
  phone: optionalPhone,
  email: optionalEmail,
  /** Kitchen Display (order tickets board) for this branch */
  kitchenDisplay: z.boolean().optional(),
});
export const branchUpdateSchema = branchCreateSchema.omit({ restaurantId: true }).partial();

export const kitchenAdvanceSchema = z.strictObject({ from: z.enum(KITCHEN_STATUSES) });
export const kitchenPrioritySchema = z.strictObject({ priority: z.boolean() });
/** Send to Kitchen: New Bill says whether the order is dine-in or a parcel (table orders are dine-in). */
export const kitchenSendSchema = z.strictObject({ orderType: z.enum(ORDER_TYPES).optional() });

// ---------- Users (Restaurant Admins only) ----------
// Branches are fully isolated: a Restaurant Admin manages exactly one branch. Only the
// Super Admin works across branches.
const singleBranchSchema = z
  .array(objectIdSchema)
  .min(1, 'Choose the branch this admin manages')
  .max(1, 'A Restaurant Admin can manage only one branch');

export const userCreateSchema = z.strictObject({
  name: name(100),
  email: z.string().trim().toLowerCase().email('Invalid email').max(200),
  password: passwordSchema,
  branchIds: singleBranchSchema,
  /** Branch Admin (default), a Kitchen login (Kitchen Display only) or a Waiter login (Waiter board only) */
  role: z.enum(STAFF_ROLES).default('RESTAURANT_ADMIN'),
});
export const userUpdateSchema = z.strictObject({
  name: name(100).optional(),
  branchIds: singleBranchSchema.optional(),
});
export const resetPasswordSchema = z.strictObject({ password: passwordSchema });

// ---------- Demo sign-in buttons (configured by the Super Admin, stored in MongoDB) ----------
export const demoAccountUpdateSchema = z.strictObject({
  enabled: z.boolean(),
  label: z.string().trim().max(40).optional(),
});
export const demoLoginSchema = z.strictObject({ userId: objectIdSchema });

export const dailyReportSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  recipients: z
    .array(z.string().trim().toLowerCase().email('Invalid email').max(200))
    .max(10, 'At most 10 email addresses')
    .refine((a) => new Set(a).size === a.length, 'Each email only once'),
});
export type DailyReportSettingsInput = z.infer<typeof dailyReportSettingsSchema>;
/** "Send now": to the saved recipients, or a one-off copy to `to` (they are not saved). */
export const dailyReportSendSchema = z.strictObject({
  to: z.array(z.string().trim().toLowerCase().email('Invalid email').max(200)).min(1).max(10).optional(),
});

// ---------- Menu ----------
export const categoryCreateSchema = z.strictObject({
  name: name(50),
  icon: z.string().trim().max(8).optional(),
});
export const categoryUpdateSchema = categoryCreateSchema.partial();
export const reorderSchema = z.strictObject({ ids: z.array(objectIdSchema).min(1).max(200) });
/** Dishes in their new order (a menu can have more dishes than categories). */
export const itemReorderSchema = z.strictObject({
  ids: z
    .array(objectIdSchema)
    .min(1)
    .max(2000)
    .refine((ids) => new Set(ids).size === ids.length, 'Each dish only once'),
});

export const menuItemCreateSchema = z.strictObject({
  categoryId: objectIdSchema,
  name: name(80),
  description: z.string().trim().max(300).optional(),
  price: pricePaiseSchema,
  taxable: z.boolean().optional(),
  /** GST % of this item in basis points (500 = 5 %); null → the restaurant's taxes */
  taxRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  /** Other taxes on this item besides GST, e.g. Service charge 10 % */
  extraTaxes: z.array(taxRateSchema).max(LIMITS.maxTaxes).optional(),
  isAvailable: z.boolean().optional(),
});
export const menuItemUpdateSchema = menuItemCreateSchema.partial();
/**
 * The full list of a dish's variants (sizes / types). Rows with an id update that variant, rows
 * without one are added, and variants left out are removed. An empty list removes them all.
 * For a shared dish seen from a branch only price and availability of existing variants change.
 */
export const variantsSchema = z.strictObject({
  variants: z
    .array(
      z.strictObject({
        id: objectIdSchema.optional(),
        name: name(30),
        /** How much it is, e.g. "2 pcs" or "250 ml" */
        qty: z.string().trim().max(20).optional(),
        price: pricePaiseSchema,
        isAvailable: z.boolean().optional(),
      }),
    )
    .max(LIMITS.maxVariants, `At most ${LIMITS.maxVariants} variants`)
    .refine((v) => new Set(v.map((x) => x.name.trim().toLowerCase())).size === v.length, { message: 'Each variant name only once' }),
});
export type VariantsInput = z.infer<typeof variantsSchema>;

export const availabilitySchema = z.strictObject({ isAvailable: z.boolean() });
export const pinSchema = z.strictObject({ pinned: z.boolean() });

// ---------- Tables ----------
export const tableCreateSchema = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1, 'Required')
    .max(10)
    .regex(/^[A-Za-z0-9 -]+$/, 'Letters, digits, space or dash'),
  seats: z.number().int().min(1).max(LIMITS.maxSeats),
  shape: z.enum(TABLE_SHAPES),
  floor: z.string().trim().min(1).max(40),
  status: z.enum(TABLE_STATUSES).optional(),
});
export const tableUpdateSchema = tableCreateSchema.partial();

// ---------- Bills ----------
export const discountSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(DISCOUNT_TYPES[0]), value: z.number().int().min(0).max(10_000) }),
  z.strictObject({ type: z.literal(DISCOUNT_TYPES[1]), value: pricePaiseSchema }),
]);

export const createGroupSchema = z.strictObject({
  tableId: objectIdSchema,
  guestCount: z.number().int().min(1).max(LIMITS.maxSeats),
  /** Optional name such as "Ravi family"; defaults to "Group N". */
  groupName: z.string().trim().max(40).optional(),
  groupTag: z.string().trim().max(30).optional(),
});

export const draftUpdateSchema = z.strictObject({
  version: z.number().int().min(0),
  items: z
    .array(
      z.strictObject({
        menuItemId: objectIdSchema,
        quantity: z.number().int().min(1).max(LIMITS.maxQuantity),
        /** For the kitchen ("no onion"); left out keeps the dish's note */
        note: z.string().trim().max(LIMITS.maxDishNote, `Keep the note under ${LIMITS.maxDishNote} letters`).optional(),
      }),
    )
    .max(LIMITS.maxBillLines)
    .refine((items) => new Set(items.map((i) => i.menuItemId)).size === items.length, {
      message: 'Duplicate items',
    }),
  customerName: z.string().trim().max(80).optional(),
  discount: discountSchema.nullable().optional(),
  guestCount: z.number().int().min(1).max(LIMITS.maxSeats).optional(),
  groupTag: z.string().trim().max(30).optional(),
});

/** Move a group's open bill (and its guests) to another table of the branch. */
export const moveGroupSchema = z.strictObject({
  version: z.number().int().min(0),
  tableId: objectIdSchema,
});

/** Add a group's open bill to another group's bill; the merged group closes. */
export const mergeGroupSchema = z.strictObject({
  version: z.number().int().min(0),
  intoDraftId: objectIdSchema,
});

/** Move some dishes and guests of a group into a new group at the same table. */
export const splitGroupSchema = z.strictObject({
  version: z.number().int().min(0),
  items: z
    .array(
      z.strictObject({
        menuItemId: objectIdSchema,
        quantity: z.number().int().min(1).max(LIMITS.maxQuantity),
      }),
    )
    .min(1, 'Choose at least one dish to split off')
    .max(LIMITS.maxBillLines)
    .refine((items) => new Set(items.map((i) => i.menuItemId)).size === items.length, { message: 'Duplicate items' }),
  guestCount: z.number().int().min(1).max(LIMITS.maxSeats),
  groupName: z.string().trim().max(40).optional(),
});

/** A bill paid in two or three ways (each mode once); the parts must add up to the bill. */
export const paymentPartsSchema = z
  .array(z.strictObject({ method: z.enum(PAYMENT_METHODS), amount: z.number().int().min(1, 'Each part needs an amount') }))
  .min(2, 'A split needs two payment modes')
  .max(PAYMENT_METHODS.length)
  .refine((parts) => new Set(parts.map((p) => p.method)).size === parts.length, { message: 'Each payment mode only once' });

export const finalizeSchema = z.strictObject({
  version: z.number().int().min(0),
  paymentMethod: z.enum(PAYMENT_METHODS),
  /** paid in more than one way; paymentMethod is then the main one */
  payments: paymentPartsSchema.optional(),
  /** New Bill only – table bills are always dine-in; left out means takeaway (older apps). */
  orderType: z.enum(ORDER_TYPES).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, 'Invalid idempotency key'),
});

/** New Bill › Add Sale: a bill of just an amount, without choosing dishes. */
export const manualSaleSchema = z.strictObject({
  amount: z.number().int('Amount must be whole paise').min(100, 'Enter at least ₹1').max(LIMITS.maxPricePaise * 10, 'Amount is too high'),
  paymentMethod: z.enum(PAYMENT_METHODS),
  payments: paymentPartsSchema.optional(),
  customerName: z.string().trim().max(80).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, 'Invalid idempotency key'),
});

/** Correcting a generated bill within the edit window. Prices always come from the server. */
export const transactionEditSchema = z.strictObject({
  /** editCount the client last saw – a stale value returns 409 instead of overwriting */
  editCount: z.number().int().min(0),
  items: z
    .array(
      z.strictObject({
        menuItemId: objectIdSchema,
        quantity: z.number().int().min(1).max(LIMITS.maxQuantity),
      }),
    )
    .min(1, 'A bill needs at least one item – void it instead')
    .max(LIMITS.maxBillLines)
    .refine((items) => new Set(items.map((i) => i.menuItemId)).size === items.length, { message: 'Duplicate items' }),
  paymentMethod: z.enum(PAYMENT_METHODS),
  payments: paymentPartsSchema.optional(),
  customerName: z.string().trim().max(80).optional(),
  discount: discountSchema.nullable().optional(),
  reason: z.string().trim().max(200).optional(),
});

export const transactionStatusChangeSchema = z.strictObject({
  reason: z.string().trim().min(3, 'Give a reason').max(200),
});

// ---------- Expenses ----------
/** Adding or correcting an expense. The branch comes from the request's branch scope. */
export const expenseSchema = z.strictObject({
  /** Day the money was spent (restaurant time zone); not in the future – checked by the server */
  date: dateStringSchema,
  category: z.enum(EXPENSE_CATEGORIES),
  amount: z.number().int('Amount must be whole paise').min(1, 'Enter an amount').max(MAX_EXPENSE_PAISE, 'Amount is too high'),
  paymentMethod: z.enum(PAYMENT_METHODS),
  note: z.string().trim().max(200).optional(),
});

// ---------- Queries ----------
const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).default(20),
};

export const expenseQuerySchema = z.object({
  ...pageQuery,
  q: z.string().trim().max(50).optional(),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  restaurantId: objectIdSchema.optional(),
  branchId: objectIdSchema.optional(),
});

export const transactionQuerySchema = z.object({
  ...pageQuery,
  q: z.string().trim().max(50).optional(),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  restaurantId: objectIdSchema.optional(),
  branchId: objectIdSchema.optional(),
});

/** Served orders of one day (restaurant time zone); today when left out. */
export const servedQuerySchema = z.object({
  date: dateStringSchema.optional(),
});

export const analyticsQuerySchema = z.object({
  from: dateStringSchema,
  to: dateStringSchema,
  restaurantId: objectIdSchema.optional(),
  branchId: objectIdSchema.optional(),
});

export const salesReportQuerySchema = analyticsQuerySchema.extend({
  granularity: z.enum(['day', 'month']).default('day'),
});

export const auditQuerySchema = z.object({
  ...pageQuery,
  restaurantId: objectIdSchema.optional(),
  action: z.string().trim().max(60).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RestaurantCreateInput = z.infer<typeof restaurantCreateSchema>;
export type RestaurantUpdateInput = z.infer<typeof restaurantUpdateSchema>;
export type RestaurantSettingsInput = z.infer<typeof restaurantSettingsSchema>;
export type BranchCreateInput = z.infer<typeof branchCreateSchema>;
export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;
export type MenuItemCreateInput = z.infer<typeof menuItemCreateSchema>;
export type MenuItemUpdateInput = z.infer<typeof menuItemUpdateSchema>;
export type TableCreateInput = z.infer<typeof tableCreateSchema>;
export type DraftUpdateInput = z.infer<typeof draftUpdateSchema>;
export type FinalizeInput = z.infer<typeof finalizeSchema>;
export type ManualSaleInput = z.infer<typeof manualSaleSchema>;
export type MoveGroupInput = z.infer<typeof moveGroupSchema>;
export type MergeGroupInput = z.infer<typeof mergeGroupSchema>;
export type SplitGroupInput = z.infer<typeof splitGroupSchema>;
export type TransactionEditInput = z.infer<typeof transactionEditSchema>;
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;
export type ExpenseInput = z.infer<typeof expenseSchema>;
export type ExpenseQuery = z.infer<typeof expenseQuerySchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
