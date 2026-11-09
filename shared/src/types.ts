/** API response shapes (DTOs). Ids are strings, money is integer paise, dates are ISO strings. */
import type {
  DraftStatus,
  DraftType,
  ExpenseCategory,
  ItemStatus,
  KitchenStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  RecordStatus,
  Role,
  TableOccupancy,
  TableShape,
  TableStatus,
  TransactionStatus,
} from './constants.js';
import type { DiscountInput, TaxLine, TaxRate } from './money.js';
import type { PaymentPart } from './payments.js';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface UserDTO {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: RecordStatus;
  restaurantIds: string[];
  branchIds: string[];
  /** Kitchen logins: the counter whose orders they see; null → every counter */
  kitchenStationId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Public: one button on the login page. Contains no email or password. */
export interface DemoAccountDTO {
  id: string;
  label: string;
  role: Role;
  hint: string;
}

/** Super Admin view of every account and its demo-button setting. */
export interface AdminDemoAccountDTO extends DemoAccountDTO {
  name: string;
  email: string;
  status: RecordStatus;
  demoEnabled: boolean;
  demoLabel: string;
}

/** Emailed daily sales report (Super Admin). */
export interface DailyReportSettingsDTO {
  enabled: boolean;
  recipients: string[];
  /** "21:00" in `timezone` */
  sendTime: string;
  timezone: string;
  /** false until SMTP_USER / SMTP_PASS are set on the server */
  mailConfigured: boolean;
  /** Address the report is sent from */
  sender: string;
  lastSentFor: string;
  lastSentAt: string | null;
  lastError: string;
  /** false on Vercel while CRON_SECRET is missing: the scheduler is refused, nothing is sent */
  scheduleConfigured: boolean;
  /** when the email really goes out, e.g. "between 9:30 and 10:30 PM" (Vercel runs the schedule once in that hour) */
  scheduleNote: string;
  /** the last automatic check and its outcome ("sent", "not yet time", "mail not configured"…) */
  lastRunAt: string | null;
  lastRunResult: string;
}

export interface RestaurantSettings {
  taxes: TaxRate[];
  pricesIncludeTax: boolean;
  receiptFooter: string;
}

export interface RestaurantDTO {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  gstin: string;
  /** Uploaded logo ("/uploads/…"), or null to use the Tiffin House logo */
  logoUrl: string | null;
  status: RecordStatus;
  settings: RestaurantSettings;
  branchCount?: number;
  createdAt: string;
}

export interface BranchDTO {
  id: string;
  restaurantId: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  status: RecordStatus;
  kitchenDisplay: boolean;
  kitchenStations: KitchenStationDTO[];
  createdAt: string;
}

/**
 * A kitchen counter (Tiffin, Juice…): dishes of its categories go to it as their own ticket.
 * Dishes of categories no counter lists go to the first counter.
 */
export interface KitchenStationDTO {
  id: string;
  name: string;
  categoryIds: string[];
}

/** A branch the current user can operate, with what the billing UI needs. */
export interface BranchContextDTO {
  id: string;
  name: string;
  code: string;
  /** The branch uses the Kitchen Display (orders are sent to the kitchen board). */
  kitchenDisplay: boolean;
  /** Its kitchen counters; empty → one kitchen for everything */
  kitchenStations: { id: string; name: string }[];
  /** false after Close Shop: billing is locked until Open Shop */
  shopOpen: boolean;
  restaurant: { id: string; name: string; logoUrl: string | null; settings: RestaurantSettings };
}

/** Open Shop / Close Shop; closing also emails the restaurant's report for today. */
export interface ShopStateDTO {
  shopOpen: boolean;
  /** what came of the report email on Close Shop ("sent to …", "email is not set up", …) */
  report?: { sent: boolean; message: string };
}

export interface MeDTO {
  user: UserDTO;
  branches: BranchContextDTO[];
}

export interface CategoryDTO {
  id: string;
  restaurantId: string;
  branchId: string | null;
  name: string;
  icon: string;
  displayOrder: number;
  status: RecordStatus;
  /** true when the caller may rename, hide or move it (a branch changes shared ones for itself only) */
  editable: boolean;
  /** a main-menu category seen from a branch */
  isShared: boolean;
}

export interface MenuItemDTO {
  id: string;
  restaurantId: string;
  branchId: string | null;
  categoryId: string;
  name: string;
  description: string;
  /** effective photo for the requested scope (branch photo, else main-menu photo) */
  imageUrl: string | null;
  /** this branch uses its own photo for a shared item */
  imageOverridden: boolean;
  /** pinned by this branch – listed first in its menu and New Bill screen */
  pinned: boolean;
  /** position in this menu (the branch's own once it drags dishes around); lower first */
  displayOrder: number;
  /** effective price for the requested scope */
  price: number;
  basePrice: number;
  taxable: boolean;
  /** Own GST % in basis points (500 = 5 %); null → the restaurant's taxes apply when taxable */
  taxRateBps: number | null;
  /** Other taxes besides GST, e.g. Service charge 10 % */
  extraTaxes: TaxRate[];
  /** effective availability for the requested scope */
  isAvailable: boolean;
  status: ItemStatus;
  /** shared item viewed in a branch scope */
  isShared: boolean;
  hasOverride: boolean;
  /** true when name/category/description/image may be edited in this scope */
  editable: boolean;
  /** Set on a variant: the dish it belongs to. Dishes with variants are ordered by variant. */
  parentId: string | null;
  /** "Masala", "Half" … ("" for dishes) */
  variantName: string;
  /** How much the variant is, e.g. "2 pcs" ("" when not set) */
  variantQty: string;
}

export interface DraftItemDTO {
  menuItemId: string;
  name: string;
  imageUrl: string | null;
  unitPrice: number;
  taxable: boolean;
  taxRateBps: number | null;
  /** Other taxes besides GST, e.g. Service charge 10 % */
  extraTaxes: TaxRate[];
  quantity: number;
  /** item became unavailable after it was added – must be removed before finalising */
  unavailable: boolean;
  /** for the kitchen ("no onion"); "" when none */
  note: string;
}

export interface DraftTotalsDTO {
  subtotal: number;
  discountAmount: number;
  taxes: TaxLine[];
  taxTotal: number;
  grandTotal: number;
}

export interface DraftDTO {
  id: string;
  restaurantId: string;
  branchId: string;
  type: DraftType;
  tableId: string | null;
  tableLabel: string;
  groupName: string;
  guestCount: number;
  groupTag: string;
  customerName: string;
  items: DraftItemDTO[];
  discount: DiscountInput | null;
  totals: DraftTotalsDTO;
  status: DraftStatus;
  version: number;
  transactionId: string | null;
  /** most ever sent to the kitchen per dish */
  kitchenSent: { menuItemId: string; quantity: number }[];
  updatedAt: string;
  updatedByName: string;
}

export interface TableGroupSummaryDTO {
  draftId: string;
  groupName: string;
  guestCount: number;
  groupTag: string;
  itemCount: number;
  /** number of distinct dishes on the bill */
  lineCount: number;
  grandTotal: number;
  previewItems: { name: string; imageUrl: string | null }[];
  version: number;
  /** portions added since the last kitchen ticket (0 when the branch has nothing left to send) */
  kitchenPending: number;
  /** food still in the kitchen: READY if any of it is ready, else PREPARING, else NEW (sent); null when none */
  kitchenStatus: 'NEW' | 'PREPARING' | 'READY' | null;
  /** portions of each dish already served (or handed over) */
  kitchenServed: { menuItemId: string; quantity: number }[];
  /** portions of each dish the kitchen has started (Preparing, Ready or Served): these can no longer be changed by a waiter */
  kitchenStarted: { menuItemId: string; quantity: number }[];
}

export interface TableDTO {
  id: string;
  branchId: string;
  label: string;
  seats: number;
  shape: TableShape;
  floor: string;
  status: TableStatus;
  seatsUsed: number;
  occupancy: TableOccupancy;
  groups: TableGroupSummaryDTO[];
}

export interface TablesResponseDTO {
  tables: TableDTO[];
  floors: string[];
}

/** One order sent to the branch kitchen (a KOT). */
export interface KitchenTicketDTO {
  id: string;
  /** "20261025-0001": date + running number of the day in the branch */
  number: string;
  branchId: string;
  draftId: string;
  type: DraftType;
  /** "" for counter / takeaway orders */
  tableLabel: string;
  groupName: string;
  /** TAKEAWAY tickets are parcels: handed over at the counter instead of served */
  orderType: OrderType;
  /** The order's number for the day, the same on all its tickets: a parcel's Token (the customer waits
   *  with it), or for a table order which customer at that table today ("T01-2"). Null on older
   *  table tickets. */
  token: number | null;
  /** The bill's number once it is generated; "" before */
  billNumber: string;
  /**
   * `note`: what the order asked of the kitchen for that dish ("no onion"), "" when nothing.
   * `ready`: the kitchen ticked it done (it is on the waiter's Ready to Serve); `served`: it reached the table.
   */
  items: { menuItemId: string; name: string; quantity: number; note: string; ready: boolean; served: boolean }[];
  status: KitchenStatus;
  priority: boolean;
  createdByName: string;
  createdAt: string;
  /** When the ticket entered its current status */
  statusAt: string;
  /** who marked it Served (a waiter or the kitchen) or handed the parcel over; "" until then */
  servedByName: string;
  /** The kitchen counter it went to; null when the branch has one kitchen (or it was sent before counters) */
  stationId: string | null;
  stationName: string;
  /** When the order last changed this ticket before the kitchen started it (dish lowered, removed or its note changed); null if never */
  editedAt: string | null;
}

export interface TransactionItemDTO {
  menuItemId: string;
  name: string;
  categoryName: string;
  imageUrl: string | null;
  unitPrice: number;
  quantity: number;
  taxable: boolean;
  taxRateBps: number | null;
  /** Other taxes besides GST, e.g. Service charge 10 % */
  extraTaxes: TaxRate[];
  lineTotal: number;
}

export interface TransactionDTO {
  id: string;
  billNumber: string;
  restaurantId: string;
  branchId: string;
  tableId: string | null;
  tableLabel: string;
  type: DraftType;
  orderType: OrderType;
  /** entered as just an amount (Add Sale): one "Manual sale" line, cannot be edited */
  manual: boolean;
  groupName: string;
  guestCount: number;
  customerName: string;
  /** logoUrl "" → the restaurant had no logo; the bill prints without one */
  restaurantSnapshot: { name: string; address: string; phone: string; gstin: string; receiptFooter: string; logoUrl: string };
  branchSnapshot: { name: string; code: string; address: string; phone: string };
  items: TransactionItemDTO[];
  itemCount: number;
  subtotal: number;
  discount: { type: string; value: number; amount: number } | null;
  taxes: TaxLine[];
  taxTotal: number;
  grandTotal: number;
  pricesIncludeTax: boolean;
  /** the main mode; see `payments` for a bill paid in more than one way */
  paymentMethod: PaymentMethod;
  /** how the bill was paid – one part, or two or more for a split payment */
  payments: PaymentPart[];
  paymentStatus: PaymentStatus;
  status: TransactionStatus;
  statusChange: { at: string; byName: string; reason: string } | null;
  createdByName: string;
  finalizedAt: string;
  /** How many times the bill was corrected (each keeps the previous version). */
  editCount: number;
  editedAt: string | null;
  editedByName: string;
  /** Until when the bill can still be edited; null when no longer editable. */
  editableUntil: string | null;
}

/** Money a branch spent (groceries, gas, salary …). */
export interface ExpenseDTO {
  id: string;
  restaurantId: string;
  branchId: string;
  branchName: string;
  /** YYYY-MM-DD in the restaurant time zone */
  date: string;
  category: ExpenseCategory;
  amount: number;
  paymentMethod: PaymentMethod;
  note: string;
  createdByName: string;
  createdAt: string;
  editedByName: string;
  editedAt: string | null;
  /** End of the Restaurant Admin delete window; null once over (editing is open any time). */
  editableUntil: string | null;
}

export interface ExpenseListDTO {
  expenses: ExpenseDTO[];
  meta: PageMeta;
  /** Over every expense matching the filters (not just this page) */
  totalAmount: number;
  byCategory: { category: ExpenseCategory; amount: number; count: number }[];
}

export interface AnalyticsPoint {
  key: string;
  sales: number;
  bills: number;
}

export interface AnalyticsOverviewDTO {
  range: { from: string; to: string; timezone: string };
  summary: { totalSales: number; billCount: number; averageBill: number; taxTotal: number };
  excluded: { voidedCount: number; voidedAmount: number; refundedCount: number; refundedAmount: number };
  daily: AnalyticsPoint[];
  monthly: AnalyticsPoint[];
  byRestaurant: (AnalyticsPoint & { name: string })[];
  byBranch: (AnalyticsPoint & { name: string; restaurantName: string })[];
  byPaymentMethod: (AnalyticsPoint & { key: PaymentMethod })[];
  /** Best-selling dishes (top 25) by item sales (quantity × price, before bill-level discount/tax). */
  topItems: AnalyticsRankRow[];
  /** Item sales per category. */
  topCategories: AnalyticsRankRow[];
  /** Completed sales per hour of the day (key "00"–"23", restaurant time zone). */
  hourly: AnalyticsPoint[];
}

export interface AnalyticsRankRow {
  key: string;
  name: string;
  quantity: number;
  sales: number;
}

export interface AuditLogDTO {
  id: string;
  actorName: string;
  actorRole: Role;
  restaurantId: string | null;
  branchId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  createdAt: string;
}
