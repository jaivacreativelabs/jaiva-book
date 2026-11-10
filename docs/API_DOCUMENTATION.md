# API Documentation (v1)

Base URL: `/api/v1`. All bodies are JSON unless noted. Money is integer **paise**.

## Conventions

**Success:** `{ "data": ..., "meta": { ... } }` (`meta` only on paginated lists).

**Error:** `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": ... } }`

| Status | Code(s) |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_ID`, `BAD_REQUEST`, `ITEM_UNAVAILABLE`, `EMPTY_BILL` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `CSRF` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` (stale version – `details.current` holds the latest draft), `DUPLICATE`, `SEATS_UNAVAILABLE` |
| 413 | `FILE_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` (no stack traces are returned) |

**Authentication:** `POST /auth/login` sets an `httpOnly`, `SameSite=Strict` cookie
(`rb_session`, signed JWT). Every protected request reloads the user from MongoDB and
rejects inactive users or revoked sessions (`tokenVersion`).

**CSRF:** every non-GET request must send `X-Requested-With: rb-client`; when an `Origin`
header is present it must be in `CORS_ORIGINS` / the app origin.

**Retries:** the app sends every non-GET request with a random `Idempotency-Key` (16–100 of
`A–Z a–z 0–9 _ -`) and sends it again with the same key when no answer arrives (or on 502/503/504).
The server keeps the answer for 24 hours (`requestlogs`) and returns it again for that key
(`Idempotent-Replayed: true`) instead of running the request twice. 5xx answers are not kept;
a key used for another method/URL gets `422`; `/auth/*` is not covered.

**Branch scope:** restaurant-level endpoints take the branch from the `X-Branch-Id` header
(or `branchId` query). Restaurant Admins must be assigned to that branch, and the branch and
its restaurant must be active. The Super Admin may pass any branch, or `restaurantId` alone
for the shared (restaurant-wide) menu.

Unknown body fields are rejected (`.strict()` schemas), so fields such as `role`,
`restaurantId` or `price`/`total` on bills cannot be smuggled in.

## Auth – `/auth`

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/auth/login` | public (rate limited) | `{ email, password }` → `{ user }` + cookie |
| POST | `/auth/logout` | any | clears cookie |
| GET | `/auth/me` | any | `{ user, branches: [{ id, name, code, restaurant: { id, name, settings } }] }` |
| GET | `/auth/demo-accounts` | public | demo buttons switched on by the Super Admin: `[{ id, label, role, hint }]` (no email, no password) |
| POST | `/auth/demo-login` | public (rate limited) | `{ userId }` – signs in only while that account's demo button is on and the account is active |
| POST | `/auth/change-password` | any | `{ currentPassword, newPassword }` – revokes other sessions |

## Super Admin – `/admin/*` (SUPER_ADMIN only, 403 for everyone else)

### Restaurants
| Method | Path | Body / query |
|---|---|---|
| GET | `/admin/restaurants` | `?status=` – includes branch counts |
| POST | `/admin/restaurants` | `{ name, phone?, email?, address?, gstin? }` – also creates its **Main Branch** (code `MAIN`, same contact details) in the same transaction; returns `mainBranchId` |
| GET | `/admin/restaurants/:id` | restaurant + branches + admins |
| PATCH | `/admin/restaurants/:id` | any of the create fields |
| PATCH | `/admin/restaurants/:id/status` | `{ status: 'ACTIVE' \| 'INACTIVE' }` |
| PATCH | `/admin/restaurants/:id/settings` | `{ taxes: [{ name, rateBps }], pricesIncludeTax, receiptFooter }` |

### Branches
| Method | Path | Body / query |
|---|---|---|
| GET | `/admin/branches` | `?restaurantId=` |
| POST | `/admin/branches` | `{ restaurantId, name, code, address?, phone?, email? }` |
| PATCH | `/admin/branches/:id` | `{ name?, code?, address?, phone?, email? }` |
| PUT | `/admin/branches/:id/kitchen-stations` | `{ stations: [{ id?, name, categoryIds }] }` (≤ 10) – replaces the kitchen counters; `id` keeps an existing one. A category can be in one counter only (400 `DUPLICATE_CATEGORY`); a counter a Kitchen login works cannot be removed (409 `STATION_IN_USE`) |
| PATCH | `/admin/branches/:id/status` | `{ status }` |

### Restaurant Admin accounts
| Method | Path | Body |
|---|---|---|
| GET | `/admin/users` | `?restaurantId=&status=` – Restaurant Admins only |
| POST | `/admin/users` | `{ name, email, password, branchIds: [branchId], role? }` – `role` is `RESTAURANT_ADMIN` (default) or `KITCHEN` (Kitchen Display only); exactly one branch (branches are isolated); `kitchenStationId?` gives a Kitchen login one counter of that branch (400 `INVALID_STATION` otherwise) |
| PATCH | `/admin/users/:id` | `{ name?, branchIds?: [branchId], kitchenStationId?: id \| null }` (move the admin to another branch; a counter not in the new branch is dropped) |
| PATCH | `/admin/users/:id/status` | `{ status }` – deactivation revokes sessions |
| POST | `/admin/users/:id/reset-password` | `{ password }` |
| DELETE | `/admin/users/:id` | Deletes a Restaurant Admin / Kitchen / Waiter login for good (signed out at once; bills keep the name; its open counter bill goes too) |

Super Admin accounts cannot be read, modified or created through these endpoints.

### Analytics & reports
| Method | Path | Query |
|---|---|---|
| GET | `/admin/analytics/overview` | `from, to (YYYY-MM-DD), restaurantId?, branchId?` → `summary, excluded, daily, monthly, hourly, byRestaurant, byBranch, byPaymentMethod, topItems, topCategories` |
| GET | `/admin/reports/transactions.csv` | same filters as `/transactions` |
| GET | `/admin/reports/sales.csv` | `granularity=day\|month`, `from, to, restaurantId?, branchId?` |
| GET | `/admin/reports/restaurants.csv` | `from, to` |
| GET | `/admin/reports/branches.csv` | `from, to, restaurantId?` |
| GET | `/admin/audit-logs` | `page, limit, restaurantId?, action?` |
| GET | `/admin/demo-accounts` | every account with its demo-button setting |
| PATCH | `/admin/demo-accounts/:id` | `{ enabled, label? }` – show/hide a one-tap sign-in button on the login page (audit logged) |
| GET | `/admin/daily-report` | daily report email settings: `{ enabled, recipients, sendTime, timezone, mailConfigured, sender, lastSentFor, lastSentAt, lastError }` |
| PUT | `/admin/daily-report` | `{ enabled, recipients: email[] (≤10) }` (audit logged) |
| GET | `/admin/daily-report/preview` | `{ html }` – today's report email as it would be sent now |
| POST | `/admin/daily-report/send` | `{ to?: email[] }` – sends today's report now to the saved recipients, or one copy to `to` (not saved) (does not use up the scheduled send). 503 `MAIL_NOT_CONFIGURED`, 400 `NO_RECIPIENTS`, 502 `MAIL_FAILED` |

### Scheduled jobs

| Method | Path | Notes |
|---|---|---|
| GET | `/cron/daily-report` | called by Vercel Cron with `Authorization: Bearer $CRON_SECRET` (401 otherwise, also when `CRON_SECRET` is unset). Sends today's report once per day; a second call the same day returns `{ status: "skipped", reason: "already sent" }` |

Dates are interpreted in `APP_TIMEZONE` (default `Asia/Kolkata`). Only `COMPLETED`
transactions count as revenue.

## Menu – `/menu` (both roles, branch scoped)

| Method | Path | Notes |
|---|---|---|
| GET | `/menu/categories` | effective categories for the scope (`includeInactive=true` for management) |
| POST | `/menu/categories` | `{ name, icon? }` – created in the caller's scope (branch, or shared for SA without branch) |
| PATCH | `/menu/categories/:id` | `{ name?, icon?, taxRateBps? }` – only categories owned by the scope. A new `taxRateBps` (GST in basis points) is given to every dish in the category (a branch: its own dishes and its view of shared ones), and new dishes created without `taxRateBps` start with it; a dish can still be given its own afterwards. `null` clears it and leaves the dishes as they are |
| PATCH | `/menu/categories/:id/status` | `{ status }` |
| POST | `/menu/categories/reorder` | `{ ids: [] }` |
| GET | `/menu/items` | `?categoryId=&q=&includeArchived=` – effective prices / availability |
| POST | `/menu/items` | `{ categoryId, name, description?, price, taxable?, isAvailable? }` |
| PATCH | `/menu/items/:id` | owned item: any field. Shared item in branch scope: only `price`/`isAvailable` → stored as branch override |
| DELETE | `/menu/items/:id/override` | removes this branch's override of a shared item |
| PATCH | `/menu/items/:id/availability` | `{ isAvailable }` (override for shared items in branch scope) |
| PATCH | `/menu/items/:id/pin` | `{ pinned }` – branch scope only; pinned dishes are listed first in that branch |
| POST | `/menu/items/:id/image` | `multipart/form-data`, field `image` (JPEG/PNG/WebP, ≤ 2 MB, magic bytes checked). For a shared item in branch scope this sets the branch's own photo |
| DELETE | `/menu/items/:id/image` | removes the photo (branch scope + shared item: back to the main-menu photo) |
| POST | `/menu/items/:id/archive` | archive (soft delete) – history keeps its snapshots |
| POST | `/menu/items/:id/restore` | un-archive |

## Tables – `/tables` (branch scoped)

| Method | Path | Notes |
|---|---|---|
| GET | `/tables` | `?floor=` → tables with `seatsUsed`, `occupancy`, `groups[]` (draft summaries) and the floor list |
| POST | `/tables` | `{ label, seats, shape, floor, status }` |
| PATCH | `/tables/:id` | `{ label?, seats?, shape?, floor?, status? }` (seats cannot drop below seats in use) |
| DELETE | `/tables/:id` | deactivates; rejected while the table has active groups |
| GET | `/tables/waiters` | Restaurant Admin: the branch's active waiters `[{ id, name }]` |
| PUT | `/tables/:id/waiter` | Restaurant Admin: `{ waiterId: id \| null }` gives the table to a waiter / takes the waiter off. Each table in `GET /tables` has `waiter: { id, name } \| null` |

## Bills (drafts) – `/bills` (branch scoped)

| Method | Path | Notes |
|---|---|---|
| GET | `/bills/counter` | the caller's active counter (takeaway) draft – created if missing |
| GET | `/bills?tableId=` | active drafts of a table |
| POST | `/bills/table-groups` | `{ tableId, guestCount, groupName? }` → new group draft named `groupName` or "Group N" (`409 SEATS_UNAVAILABLE` if it does not fit, `409 DUPLICATE` if the name is already seated at that table) |
| GET | `/bills/:id` | draft (any status) |
| PUT | `/bills/:id` | `{ version, items: [{ menuItemId, quantity }], customerName?, discount?, guestCount?, groupTag? }` – the server looks up names/prices, recomputes totals and returns the new version; `409 CONFLICT` on a stale version. Lowering / removing a dish already sent to the kitchen (or changing its note) also changes its KOTs the kitchen has not started (New), latest first – a KOT left empty is cancelled, the others get `editedAt`. A waiter may lower only that food: lowering what the kitchen has started is 403 `IN_KITCHEN` (the admin may; that food stays on its KOT). Table groups carry `kitchenStarted` per dish |
| POST | `/bills/manual-sale` | `{ amount, paymentMethod, customerName?, idempotencyKey }` → `{ transaction }`. New Bill › Add Sale: a bill of just an amount (paise, ≥ ₹1) – one untaxed "Manual sale" line, `manual: true`, numbered like other bills, voidable but not editable |
| POST | `/bills/:id/finalize` | `{ version, paymentMethod, payments?, orderType?, idempotencyKey }` → `{ transaction }`. `payments` = `[{ method, amount }]` (2–3 different modes) for a bill paid partly one way and partly another; the parts must add up to the bill (`400 SPLIT_MISMATCH`) and the main mode (most money) is stored as `paymentMethod`. Every transaction returns `payments` (one part when paid one way); payment-mode totals and filters count each part under its own mode. The order type is fixed: New Bill (counter) bills are `TAKEAWAY`, table bills `DINE_IN`; an `orderType` sent by older apps is ignored. Repeating the call with the same key returns the same transaction |
| DELETE | `/bills/:id?version=` | marks the draft `DELETED` (audit logged); never touches transactions |

Items not available in the branch cannot be added or increased (`400 ITEM_UNAVAILABLE`); a
draft containing an item that became unavailable cannot be finalised until it is removed.

## Kitchen Display – `/kitchen` (branch scoped; only when the branch has `kitchenDisplay` on, else 409 `KITCHEN_OFF`)

| Method | Path | Notes |
|---|---|---|
| POST | `/bills/:id/kitchen` | sends the order's not-yet-sent items (New Bill orders as parcels, table orders dine-in): an array with one new ticket, or one per kitchen counter; `[]` when nothing is new or the branch has no Kitchen Display. Generating a bill does this automatically |
| GET | `/bills/:id/kitchen` | every KOT of that order, oldest first, in any status (the KOT Details popup on the Tables page). Waiters may call it for table orders |
| GET | `/kitchen/tickets` | the board: `NEW`, `PREPARING`, `READY` tickets, priority first, then oldest. A Kitchen login with a counter gets only that counter's tickets, and moving another counter's ticket is 403 |
| GET | `/kitchen/tickets/:id` | one ticket (kitchen slip printing; also works after it was served) |
| POST | `/kitchen/tickets/:id/advance` | `{ from }` – one step on (READY → SERVED leaves the board). 409 `CONFLICT` with `details.current` if another screen moved it first |
| POST | `/kitchen/tickets/:id/priority` | `{ priority: boolean }` |
| GET | `/kitchen/served?date=YYYY-MM-DD` | Served Orders: tickets served at a table or handed over at the counter on that day (restaurant time zone; today when left out), latest first, up to 500. Every login of the branch (waiters use `GET /waiter/served`, same answer); works even with the Kitchen Display off |

The Super Admin switches it on per branch with `PATCH /admin/branches/:id` `{ kitchenDisplay: true }`.

## Transactions – `/transactions` (Super Admin: all; Restaurant Admin: assigned branches)

| Method | Path | Notes |
|---|---|---|
| GET | `/transactions` | `page, limit (≤100), q (bill no./table), from, to, paymentMethod, status, restaurantId?, branchId?` |
| GET | `/transactions/:id` | full transaction with snapshots |
| GET | `/transactions/export.csv` | same filters, scoped to the caller |
| PUT | `/transactions/:id` | `{ editCount, items: [{menuItemId, quantity}], paymentMethod, customerName?, discount?, reason? }` – corrects a COMPLETED bill: Restaurant Admins within 30 minutes of billing, the Super Admin at any time. Same bill number; lines already on the bill keep their billed price, added dishes take the menu price, totals recomputed on the server; previous version kept in `revisions`; audit logged. 409 `EDIT_WINDOW_CLOSED` after 30 minutes (Restaurant Admins), 409 `CONFLICT` (with `details.current`) if `editCount` is stale, 409 `INVALID_STATUS` for voided/refunded bills |
| POST | `/transactions/:id/void` | `{ reason }` – COMPLETED → VOIDED (audit logged) |
| POST | `/transactions/:id/refund` | `{ reason }` – COMPLETED → REFUNDED (audit logged) |

Restaurant Admins always get results limited to their assigned branches; a `branchId` they
are not assigned to returns 403.

## Static files

`GET /uploads/menu/<file>` – uploaded menu images (served with `nosniff` and a restrictive CSP).

## Health

`GET /api/v1/health` → `{ data: { status: 'ok', db: 'connected' } }`
