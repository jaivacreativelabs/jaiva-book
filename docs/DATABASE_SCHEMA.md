# Database Schema (MongoDB / Mongoose)

Models live in `server/src/models/`. All collections have `createdAt` / `updatedAt`
timestamps unless noted.

## Conventions

- **Money** is stored as integer **paise** (1 ₹ = 100 paise). No floating-point amounts are
  stored or summed. Tax rates are stored in **basis points** (`250` = 2.50 %).
- Rounding: half-up to the nearest paisa, done once per tax component per bill
  (`shared/src/money.ts`). The same function is used by the client preview and the server.
- `branchId: null` on menu data means "shared by every branch of the restaurant".
- Records referenced by transactions (menu items, categories, tables, branches, users) are
  never hard-deleted; they are archived / deactivated.

## users

| Field | Type | Notes |
|---|---|---|
| name | string | |
| email | string | unique, lower-cased |
| passwordHash | string | bcrypt (cost 12), never returned by the API |
| role | `SUPER_ADMIN` \| `RESTAURANT_ADMIN` \| `KITCHEN` | enum validated by Mongoose and Zod; `KITCHEN` = Kitchen Display of one branch only |
| restaurantIds | ObjectId[] | derived server-side from `branchIds` |
| branchIds | ObjectId[] | branches the Restaurant Admin may operate |
| kitchenStationId | ObjectId \| null | Kitchen logins: the branch kitchen counter they work (`branches.kitchenStations._id`); null = every counter |
| status | `ACTIVE` \| `INACTIVE` | |
| tokenVersion | number | incremented on deactivate / password reset → old sessions die |
| lastLoginAt | Date | |
| demo | `{ enabled, label }` | one-tap demo sign-in button on the login page (Super Admin controlled) |

Indexes: `{ email: 1 }` unique, `{ role: 1, status: 1 }`, `{ branchIds: 1 }`.

Super Admin accounts are only created by `npm run setup:superadmin` – no API creates them.

## restaurants

| Field | Type | Notes |
|---|---|---|
| name | string | unique (case-insensitive via `nameKey`) |
| nameKey | string | lower-cased trimmed name |
| phone, email, gstin | string | optional |
| address | string | |
| status | `ACTIVE` \| `INACTIVE` | inactive restaurants block all branch operations |
| settings.taxes | `{ name, rateBps }[]` | e.g. CGST 250 + SGST 250. Empty by default – no tax is assumed |
| settings.pricesIncludeTax | boolean | menu prices are tax-inclusive when true |
| settings.receiptFooter | string | printed at the bottom of receipts |

Indexes: `{ nameKey: 1 }` unique.

## branches

| Field | Type | Notes |
|---|---|---|
| restaurantId | ObjectId → restaurants | |
| name | string | |
| code | string | short upper-case code, unique within the restaurant |
| address, phone, email | string | |
| status | `ACTIVE` \| `INACTIVE` | |
| kitchenDisplay | boolean | Kitchen Display board on for this branch (Super Admin switch, default off) |
| kitchenStations | `{ _id, name, categoryIds[] }[]` | kitchen counters (Tiffin, Juice…), in order. Each send makes one ticket per counter; dishes of categories no counter lists go to the first. Empty = one kitchen |

Indexes: `{ restaurantId: 1, code: 1 }` unique, `{ restaurantId: 1, nameKey: 1 }` unique.

## categories

| Field | Type | Notes |
|---|---|---|
| restaurantId | ObjectId | |
| branchId | ObjectId \| null | null = shared category |
| name / nameKey | string | |
| icon | string | optional emoji shown on the chip |
| displayOrder | number | |
| status | `ACTIVE` \| `INACTIVE` | |

Indexes: `{ restaurantId: 1, branchId: 1, nameKey: 1 }` unique. The service additionally
rejects a branch category whose name equals a shared category (and vice versa).

## menuitems

| Field | Type | Notes |
|---|---|---|
| restaurantId | ObjectId | |
| branchId | ObjectId \| null | null = shared item, otherwise branch-only item |
| categoryId | ObjectId → categories | must be visible in the same scope |
| name / nameKey | string | unique per `(restaurantId, branchId, nameKey)` |
| description | string | |
| imageUrl | string \| null | relative URL `/uploads/menu/<random>.jpg` (no binary data in MongoDB) |
| price | int (paise) | base price |
| taxable | boolean | excluded from tax when false |
| isAvailable | boolean | base availability |
| status | `ACTIVE` \| `ARCHIVED` | archived = "deleted" from the menu, still referenced by history |
| branchOverrides | `{ branchId, price?, isAvailable?, imageUrl? }[]` | per-branch price, availability and photo for shared items |
| displayOrder | number | |

Effective menu for a branch = shared items + that branch's items, with that branch's override
applied (branch photo replaces the main photo). Indexes: `{ restaurantId: 1, branchId: 1, nameKey: 1 }` unique,
`{ restaurantId: 1, categoryId: 1 }`, `{ 'branchOverrides.branchId': 1 }`.

## tables

| Field | Type | Notes |
|---|---|---|
| restaurantId, branchId | ObjectId | |
| label / labelKey | string | e.g. `T01`, unique per branch |
| seats | int 1–30 | |
| shape | `SQUARE` \| `ROUND` | |
| floor | string | e.g. "Ground Floor" |
| status | `AVAILABLE` \| `RESERVED` | manual status only |
| isActive | boolean | false = removed from the floor plan |
| version | int | bumped when seats are claimed, serialises group creation |

Occupancy is **derived**, not stored: `seatsUsed = Σ guestCount` of the table's `ACTIVE`
drafts. Display state: `RESERVED` if reserved, else `FULL` (seatsUsed ≥ seats), `PARTIAL`
(> 0) or `AVAILABLE`. The "active draft reference" is the query
`drafts.find({ tableId, status: 'ACTIVE' })`, which avoids a second source of truth.

Indexes: `{ branchId: 1, labelKey: 1 }` unique, `{ branchId: 1, floor: 1 }`.

## drafts (active / in-progress bills)

| Field | Type | Notes |
|---|---|---|
| restaurantId, branchId | ObjectId | |
| type | `TABLE` \| `COUNTER` | COUNTER = New Bill without a table (takeaway) |
| tableId | ObjectId \| null | |
| groupName | string | "Group 1"… (TABLE only) |
| guestCount | int | seats claimed by the group |
| groupTag | string | optional e.g. "Family" |
| ownerUserId | ObjectId \| null | COUNTER drafts belong to one admin |
| customerName | string | |
| items | `{ menuItemId, name, imageUrl, unitPrice, taxable, quantity, unavailable }[]` | name/price refreshed from the menu on every save |
| discount | `{ type: 'PERCENT' \| 'FLAT', value }` \| null | PERCENT in bps, FLAT in paise |
| totals | `{ subtotal, discountAmount, taxes[], taxTotal, grandTotal }` | server-computed preview |
| status | `ACTIVE` \| `FINALIZED` \| `DELETED` | |
| version | int | optimistic concurrency token – every write must send the version it read |
| transactionId | ObjectId | set when finalized |
| createdBy, updatedBy, deletedBy | ObjectId | |
| deletedAt, finalizedAt | Date | |

Indexes:
- `{ tableId: 1, status: 1 }`
- `{ branchId: 1, status: 1, type: 1 }`
- unique partial `{ tableId: 1, groupName: 1 }` where `status = 'ACTIVE'`
- unique partial `{ branchId: 1, ownerUserId: 1 }` where `status = 'ACTIVE' and type = 'COUNTER'`

## kitchentickets (Kitchen Display / KOT)

| Field | Type | Notes |
|---|---|---|
| restaurantId, branchId | ObjectId | |
| number | string | `20261025-0001` – date + running number of the day per branch (`counters` key `kot:<branchId>:<yyyymmdd>`) |
| draftId | ObjectId → drafts | the order it came from |
| type, tableLabel, groupName | | `TABLE` / `COUNTER`; empty table label = takeaway |
| items | `{ menuItemId, name, quantity }[]` | only what was added since the previous ticket |
| status | `NEW` → `PREPARING` → `READY` → `SERVED`, or `CANCELLED` | |
| priority | boolean | starred tickets are listed first |
| statusAt | Date | when it entered the current status |
| createdBy, createdByName | | |
| stationId, stationName | | the kitchen counter it went to; null / "" for a branch with one kitchen |
| servedBy, servedByName | | who served it (or handed the parcel over) |

Drafts keep `kitchenSent` (the most ever sent per dish) and `kitchenRev`, so a ticket carries only new
items and the same food is never sent twice. Deleting an order cancels its tickets that are still `NEW`.

Indexes: `{ branchId: 1, status: 1, createdAt: 1 }`, `{ branchId: 1, number: 1 }` unique, `{ draftId: 1 }`.

## transactions (completed bills – immutable)

| Field | Type | Notes |
|---|---|---|
| billNumber | string | `B00001`… sequential per branch (from `counters`) |
| restaurantId, branchId | ObjectId | |
| tableId, tableLabel | ObjectId, string | null / "" for takeaway |
| type, groupName, guestCount, customerName | | copied from the draft |
| orderType | `DINE_IN` / `TAKEAWAY` / null | table bills `DINE_IN`; New Bill asks. null on older bills (read as dine-in for tables, takeaway for counter) |
| restaurantSnapshot | `{ name, address, phone, gstin }` | as at billing time |
| branchSnapshot | `{ name, code, address, phone }` | |
| items | `{ menuItemId, name, categoryName, imageUrl, unitPrice, quantity, taxable, lineTotal }[]` | **snapshots** |
| subtotal, discount `{type,value,amount}`, taxes `{name,rateBps,amount}[]`, taxTotal, grandTotal | int paise | |
| pricesIncludeTax | boolean | |
| paymentMethod | `CASH` \| `UPI` \| `CARD` | |
| paymentStatus | `PAID` \| `REFUNDED` | |
| status | `COMPLETED` \| `VOIDED` \| `REFUNDED` | |
| statusChange | `{ at, by, byName, reason }` | set by the void/refund workflow |
| sourceDraftId | ObjectId | **unique** – one transaction per draft (duplicate-finalise guard) |
| idempotencyKey | string | unique per branch |
| createdBy, createdByName | | cashier shown on the receipt |
| finalizedAt | Date | |
| editCount, editedAt, editedByName | int, Date, string | set when the bill is corrected |
| revisions | `{ at, by, byName, reason, items, customerName, subtotal, discount, taxes, taxTotal, grandTotal, paymentMethod }[]` | every earlier version, oldest first |

A Mongoose guard rejects any update that touches snapshot or amount fields. Permitted changes:
`COMPLETED → VOIDED | REFUNDED` through the controlled workflow, and the bill edit
(`PUT /transactions/:id`; Restaurant Admins within 30 minutes of `finalizedAt`, the Super Admin any time), which must push the previous
version to `revisions` and increment `editCount` in the same update.

Indexes: `{ branchId: 1, billNumber: 1 }` unique, `{ sourceDraftId: 1 }` unique,
`{ branchId: 1, idempotencyKey: 1 }` unique, `{ branchId: 1, finalizedAt: -1 }`,
`{ restaurantId: 1, finalizedAt: -1 }`, `{ status: 1, finalizedAt: -1 }`.

### Status semantics for reporting

| Status | Counted as revenue | Notes |
|---|---|---|
| COMPLETED | yes | |
| VOIDED | no | cancelled bill; shown separately |
| REFUNDED | no | money returned; shown separately |
| Drafts (any) | no | not a transaction until finalised |

Pending / partially-paid bills do not exist in v1: a transaction is created only when the bill
is paid in full.

## counters

`{ _id: 'bill:<branchId>', seq }` – atomic `$inc` inside the finalisation transaction, so a
rolled-back finalisation does not consume a bill number.

## auditlogs

| Field | Type |
|---|---|
| actorId, actorName, actorRole | |
| restaurantId, branchId | ObjectId \| null |
| action | e.g. `RESTAURANT_CREATED`, `DRAFT_DELETED`, `TRANSACTION_VOIDED` |
| entityType, entityId | |
| summary | human readable |
| meta | small JSON object with before/after values |
| createdAt | Date |

Indexes: `{ createdAt: -1 }`, `{ restaurantId: 1, createdAt: -1 }`, `{ entityType: 1, entityId: 1 }`.

## Transactions & concurrency

- Finalisation, group creation and draft deletion run inside a MongoDB multi-document
  transaction when the server is a replica set (MongoDB Atlas always is). On a standalone
  server the same code runs without a session; unique indexes (`sourceDraftId`,
  `idempotencyKey`, `billNumber`) still prevent duplicate transactions.
- Draft writes use `findOneAndUpdate({ _id, version })` + `$inc: { version: 1 }`. A stale
  version returns HTTP 409 with the latest draft so the UI can show a conflict message.
