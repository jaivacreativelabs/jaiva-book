import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel, DraftModel, TransactionModel } from '../src/models/index.js';
import { buildWorld, Client, key, ok, useTestDatabase, type World } from './helpers.js';

useTestDatabase();

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

interface Draft {
  id: string;
  version: number;
  groupName: string;
  tableLabel: string;
  status: string;
  items: { menuItemId: string; name: string; quantity: number }[];
}
interface Table {
  id: string;
  label: string;
  seatsUsed: number;
  occupancy: string;
  groups: { draftId: string; itemCount: number }[];
}

const lines = (d: Draft) => d.items.map((i) => [i.name, i.quantity]);

async function openGroup(c: Client, tableId: string, guestCount = 2) {
  return ok<Draft>(await c.post('/api/v1/bills/table-groups', { tableId, guestCount }), 201);
}
async function save(c: Client, d: Draft, items: { menuItemId: string; quantity: number }[]) {
  return ok<Draft>(await c.put(`/api/v1/bills/${d.id}`, { version: d.version, items }));
}
async function tableById(c: Client, id: string) {
  const res = ok<{ tables: Table[] }>(await c.get('/api/v1/tables'));
  return res.tables.find((t) => t.id === id)!;
}

describe('table persistence – the exact sequence from the specification', () => {
  it('keeps independent drafts per table across switching, refresh and finalisation', async () => {
    const admin = w.adminA1;

    // 1–2. Open Table 1 and add two items (2 Biryani, 1 Fresh Juice).
    let t1 = await openGroup(admin, w.tables.t1);
    t1 = await save(admin, t1, [
      { menuItemId: w.items.biryani, quantity: 2 },
      { menuItemId: w.items.juice, quantity: 1 },
    ]);

    // 3–4. Switch to Table 2 and add three items (3 Dosa, 2 Coffee, 1 Vada).
    const t2 = await openGroup(admin, w.tables.t2, 3);
    await save(admin, t2, [
      { menuItemId: w.items.dosa, quantity: 3 },
      { menuItemId: w.items.coffee, quantity: 2 },
      { menuItemId: w.items.vada, quantity: 1 },
    ]);

    // 5–6. Return to Table 1: the original two items are still there.
    const back = ok<Draft[]>(await admin.get(`/api/v1/bills?tableId=${w.tables.t1}`));
    expect(back).toHaveLength(1);
    expect(lines(back[0])).toEqual([
      ['Biryani', 2],
      ['Fresh Juice', 1],
    ]);

    // 7–8. "Refresh the browser": a brand-new session with no client state.
    const refreshed = (await new Client().login('a1@test.local')).useBranch(w.branchA1);
    const afterRefresh = ok<Draft>(await refreshed.get(`/api/v1/bills/${t1.id}`));
    expect(lines(afterRefresh)).toEqual([
      ['Biryani', 2],
      ['Fresh Juice', 1],
    ]);

    // 9–10. Table 2 still has its three items.
    const t2Again = ok<Draft[]>(await refreshed.get(`/api/v1/bills?tableId=${w.tables.t2}`));
    expect(lines(t2Again[0])).toEqual([
      ['Dosa', 3],
      ['Coffee', 2],
      ['Vada', 1],
    ]);

    // The grid reflects both tables.
    expect((await tableById(refreshed, w.tables.t1)).occupancy).toBe('PARTIAL');
    expect((await tableById(refreshed, w.tables.t2)).seatsUsed).toBe(3);

    // 11–12. Finalise Table 1 → a transaction exists.
    const fin = await refreshed.post(`/api/v1/bills/${t1.id}/finalize`, {
      version: afterRefresh.version,
      paymentMethod: 'CASH',
      idempotencyKey: key(),
    });
    expect(fin.status).toBe(201);
    const tx = fin.body.data.transaction;
    expect(tx.tableLabel).toBe('T1');
    expect(tx.grandTotal).toBe(2 * 8000 + 5000);
    expect(await TransactionModel.countDocuments({ sourceDraftId: t1.id })).toBe(1);

    // 13. The draft is closed.
    expect((await DraftModel.findById(t1.id).lean())?.status).toBe('FINALIZED');
    expect(ok<Draft[]>(await refreshed.get(`/api/v1/bills?tableId=${w.tables.t1}`))).toHaveLength(0);

    // 14. The table is released (no open groups → available); Table 2 is untouched.
    const t1State = await tableById(refreshed, w.tables.t1);
    expect(t1State.occupancy).toBe('AVAILABLE');
    expect(t1State.seatsUsed).toBe(0);
    expect((await tableById(refreshed, w.tables.t2)).groups[0].itemCount).toBe(6);

    // The transaction is visible on the Transactions page.
    const list = await refreshed.get(`/api/v1/transactions?q=${tx.billNumber}`);
    expect(list.body.data.map((t: { id: string }) => t.id)).toContain(tx.id);
  });
});

describe('table groups and seats', () => {
  it('supports several groups on one table and enforces capacity', async () => {
    const g1 = await openGroup(w.adminA1, w.tables.t4, 2);
    const g2 = await openGroup(w.adminA1, w.tables.t4, 3);
    expect([g1.groupName, g2.groupName]).toEqual(['Group 1', 'Group 2']);
    const tooMany = await w.adminA1.post('/api/v1/bills/table-groups', { tableId: w.tables.t4, guestCount: 2 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('SEATS_UNAVAILABLE');
    const last = await openGroup(w.adminA1, w.tables.t4, 1);
    expect((await tableById(w.adminA1, w.tables.t4)).occupancy).toBe('FULL');
    // Groups keep separate bills.
    await save(w.adminA1, g1, [{ menuItemId: w.items.idly, quantity: 1 }]);
    const drafts = ok<Draft[]>(await w.adminA1.get(`/api/v1/bills?tableId=${w.tables.t4}`));
    expect(drafts.map((d) => d.items.length)).toEqual([1, 0, 0]);
    expect(last.groupName).toBe('Group 3');
  });

  it('refuses a table label already used, on this floor or another', async () => {
    ok(await w.adminA1.post('/api/v1/tables', { label: 'L7', seats: 4, shape: 'SQUARE', floor: 'Ground Floor' }), 201);
    const same = await w.adminA1.post('/api/v1/tables', { label: ' l7 ', seats: 2, shape: 'SQUARE', floor: 'Ground Floor' });
    expect(same.status).toBe(409);
    expect(same.body.error.message).toBe('Table label already exists on this floor.');
    const other = await w.adminA1.post('/api/v1/tables', { label: 'L7', seats: 2, shape: 'SQUARE', floor: 'Terrace' });
    expect(other.status).toBe(409);
    expect(other.body.error.message).toBe('Table label already exists on Ground Floor.');
    const t = ok<{ id: string }>(await w.adminA1.post('/api/v1/tables', { label: 'L8', seats: 4, shape: 'SQUARE', floor: 'Ground Floor' }), 201);
    const rename = await w.adminA1.patch(`/api/v1/tables/${t.id}`, { label: 'L7' });
    expect(rename.status).toBe(409);
    expect(rename.body.error.message).toBe('Table label already exists on this floor.');
  });

  it('lets the admin name a group and rejects a duplicate name at the same table', async () => {
    const t = ok<{ id: string }>(await w.adminA1.post('/api/v1/tables', { label: 'N1', seats: 6, shape: 'SQUARE', floor: 'Ground Floor' }), 201);
    const named = ok<Draft>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId: t.id, guestCount: 2, groupName: '  Ravi   family ' }), 201);
    expect(named.groupName).toBe('Ravi family');
    const dup = await w.adminA1.post('/api/v1/bills/table-groups', { tableId: t.id, guestCount: 1, groupName: 'ravi FAMILY' });
    expect(dup.status).toBe(409);
    const unnamed = ok<Draft>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId: t.id, guestCount: 1 }), 201);
    expect(unnamed.groupName).toBe('Group 1');
  });

  it('does not over-book seats under concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => w.adminA1.post('/api/v1/bills/table-groups', { tableId: w.tables.t3, guestCount: 1 })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2); // T3 has 2 seats
    const t3 = await tableById(w.adminA1, w.tables.t3);
    expect(t3.seatsUsed).toBe(2);
  });

  it('cannot seat guests at a reserved table until it is made available', async () => {
    const t = ok<{ id: string }>(await w.adminA1.post('/api/v1/tables', { label: 'R1', seats: 4, shape: 'ROUND', floor: 'First Floor', status: 'RESERVED' }), 201);
    expect((await tableById(w.adminA1, t.id)).occupancy).toBe('RESERVED');
    expect((await w.adminA1.post('/api/v1/bills/table-groups', { tableId: t.id, guestCount: 2 })).status).toBe(409);
    ok(await w.adminA1.patch(`/api/v1/tables/${t.id}`, { status: 'AVAILABLE' }));
    expect((await w.adminA1.post('/api/v1/bills/table-groups', { tableId: t.id, guestCount: 2 })).status).toBe(201);
    // Seats cannot drop below what is in use; table with open bills cannot be removed.
    expect((await w.adminA1.patch(`/api/v1/tables/${t.id}`, { seats: 1 })).status).toBe(409);
    expect((await w.adminA1.delete(`/api/v1/tables/${t.id}`)).status).toBe(409);
  });

  it('rejects duplicate table labels within a branch but allows them across branches', async () => {
    expect((await w.adminA1.post('/api/v1/tables', { label: 't1', seats: 4, shape: 'SQUARE', floor: 'Ground Floor' })).status).toBe(409);
    expect((await w.adminA2.post('/api/v1/tables', { label: 'T1', seats: 4, shape: 'SQUARE', floor: 'Ground Floor' })).status).toBe(201);
  });
});

describe('draft deletion', () => {
  it('deletes a draft, logs it, and never touches transactions', async () => {
    const txBefore = await TransactionModel.countDocuments();
    let d = await openGroup(w.adminA1, w.tables.t2, 1);
    d = await save(w.adminA1, d, [{ menuItemId: w.items.coffee, quantity: 1 }]);
    const stale = await w.adminA1.delete(`/api/v1/bills/${d.id}?version=${d.version - 1}`);
    expect(stale.status).toBe(409);
    const res = await w.adminA1.delete(`/api/v1/bills/${d.id}?version=${d.version}`);
    expect(res.status).toBe(204);
    expect((await DraftModel.findById(d.id).lean())?.status).toBe('DELETED');
    expect(await TransactionModel.countDocuments()).toBe(txBefore);
    expect(await AuditLogModel.countDocuments({ action: 'DRAFT_DELETED', entityId: d.id })).toBe(1);
    // A deleted draft cannot be edited or finalised.
    expect((await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version + 1, items: [] })).status).toBe(409);
  });
});

describe('concurrent edits', () => {
  it('two admins editing the same table: the second gets a conflict, not a silent overwrite', async () => {
    const other = (await new Client().login('a1@test.local')).useBranch(w.branchA1);
    const [d] = ok<Draft[]>(await w.adminA1.get(`/api/v1/bills?tableId=${w.tables.t2}`));
    const mine = await save(w.adminA1, d, [...d.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })), { menuItemId: w.items.idly, quantity: 1 }]);
    const theirs = await other.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.biryani, quantity: 5 }] });
    expect(theirs.status).toBe(409);
    expect(theirs.body.error.details.current.version).toBe(mine.version);
    const stored = ok<Draft>(await other.get(`/api/v1/bills/${d.id}`));
    expect(stored.items.map((i) => i.name)).toContain('Idly');
    expect(stored.items.map((i) => i.name)).not.toContain('Biryani');
  });
});
