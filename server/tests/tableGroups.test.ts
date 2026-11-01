import { beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, key, ok, useTestDatabase, type Client, type World } from './helpers.js';

useTestDatabase();

interface Draft {
  id: string;
  version: number;
  tableId: string;
  tableLabel: string;
  groupName: string;
  guestCount: number;
  status: string;
  items: { menuItemId: string; name: string; quantity: number }[];
  totals: { grandTotal: number };
  kitchenSent: { menuItemId: string; quantity: number }[];
}
interface Ticket {
  draftId: string;
  tableLabel: string;
  groupName: string;
  items: { name: string; quantity: number }[];
}

let w: World;
let c: Client;
const seat = async (tableId: string, guestCount: number, groupName?: string) =>
  ok<Draft>(await c.post('/api/v1/bills/table-groups', { tableId, guestCount, ...(groupName && { groupName }) }), 201);
const save = async (d: Draft, items: [string, number][]) =>
  ok<Draft>(await c.put(`/api/v1/bills/${d.id}`, { version: d.version, items: items.map(([menuItemId, quantity]) => ({ menuItemId, quantity })) }));
const get = async (d: Draft) => ok<Draft>(await c.get(`/api/v1/bills/${d.id}`));
const lines = (d: Draft) => d.items.map((i) => [i.name, i.quantity]);
const board = async () => ok<Ticket[]>(await c.get('/api/v1/kitchen/tickets'));

beforeAll(async () => {
  w = await buildWorld();
  c = w.adminA1;
  ok(await w.sa.patch(`/api/v1/admin/branches/${w.branchA1}`, { kitchenDisplay: true }));
});

describe('move a group to another table', () => {
  it('moves the bill and guests, keeping its name unless taken', async () => {
    let ravi = await seat(w.tables.t1, 2, 'Ravi');
    ravi = await save(ravi, [[w.items.idly, 2]]);
    ok(await c.post(`/api/v1/bills/${ravi.id}/kitchen`));
    const moved = ok<Draft>(await c.post(`/api/v1/bills/${ravi.id}/move`, { version: ravi.version, tableId: w.tables.t4 }));
    expect([moved.tableLabel, moved.groupName, moved.guestCount]).toEqual(['T4', 'Ravi', 2]);
    expect(lines(moved)).toEqual([['Idly', 2]]);
    // The kitchen ticket now says where the food goes.
    expect((await board()).find((t) => t.draftId === ravi.id)?.tableLabel).toBe('T4');

    const { tables } = ok<{ tables: { id: string; seatsUsed: number }[] }>(await c.get('/api/v1/tables'));
    expect(tables.find((t) => t.id === w.tables.t1)?.seatsUsed).toBe(0);
    expect(tables.find((t) => t.id === w.tables.t4)?.seatsUsed).toBe(2);

    // Name clash at the new table → next free "Group N".
    const other = await seat(w.tables.t2, 1, 'Ravi');
    const renamed = ok<Draft>(await c.post(`/api/v1/bills/${other.id}/move`, { version: other.version, tableId: w.tables.t4 }));
    expect(renamed.groupName).toBe('Group 1');
  });

  it('refuses when seats are short, the version is stale, or another branch asks', async () => {
    const big = await seat(w.tables.t1, 3);
    const short = await c.post(`/api/v1/bills/${big.id}/move`, { version: big.version, tableId: w.tables.t3 });
    expect([short.status, short.body.error.code]).toEqual([409, 'SEATS_UNAVAILABLE']);
    expect((await c.post(`/api/v1/bills/${big.id}/move`, { version: big.version + 5, tableId: w.tables.t2 })).status).toBe(409);
    expect((await c.post(`/api/v1/bills/${big.id}/move`, { version: big.version, tableId: w.tables.t1 })).status).toBe(400);
    expect((await w.adminA2.post(`/api/v1/bills/${big.id}/move`, { version: big.version, tableId: w.tables.t2 })).status).toBe(404);
    ok(await c.delete(`/api/v1/bills/${big.id}?version=${big.version}`), 204);
  });
});

describe('merge two groups', () => {
  it('adds the dishes and guests to the other bill and closes the first', async () => {
    let a = await seat(w.tables.t2, 1, 'Anu');
    let b = await seat(w.tables.t2, 2, 'Bala');
    a = await save(a, [[w.items.idly, 1], [w.items.coffee, 2]]);
    b = await save(b, [[w.items.idly, 2], [w.items.dosa, 1]]);
    ok(await c.post(`/api/v1/bills/${a.id}/kitchen`));
    a = await get(a);

    const merged = ok<Draft>(await c.post(`/api/v1/bills/${a.id}/merge`, { version: a.version, intoDraftId: b.id }));
    expect(merged.id).toBe(b.id);
    expect(merged.guestCount).toBe(3);
    expect(lines(merged)).toEqual([['Idly', 3], ['Dosa', 1], ['Coffee', 2]]);
    expect(merged.totals.grandTotal).toBe(3 * 3000 + 5000 + 2 * 2500);
    // Anu's food was already sent: it stays sent, only Bala's is new.
    expect(merged.kitchenSent).toEqual(expect.arrayContaining([{ menuItemId: w.items.idly, quantity: 1 }, { menuItemId: w.items.coffee, quantity: 2 }]));
    const t = ok<Ticket[]>(await c.post(`/api/v1/bills/${b.id}/kitchen`))[0];
    expect(t!.items.map((i) => [i.name, i.quantity])).toEqual([['Idly', 2], ['Dosa', 1]]);
    expect((await board()).filter((x) => x.draftId === b.id).length).toBe(2);

    expect((await get(a)).status).toBe('DELETED');
    expect((await c.post(`/api/v1/bills/${a.id}/merge`, { version: a.version + 1, intoDraftId: b.id })).status).toBe(409);
  });

  it('joins bills across tables without needing free seats', async () => {
    const small = await seat(w.tables.t3, 2, 'Small'); // T3 has 2 seats, now full
    const solo = await seat(w.tables.t1, 1, 'Solo');
    // Into the full table: only the bills join; Solo's seat at T1 is freed.
    const merged = ok<Draft>(await c.post(`/api/v1/bills/${solo.id}/merge`, { version: solo.version, intoDraftId: small.id }));
    expect([merged.tableLabel, merged.guestCount]).toEqual(['T3', 2]);
    const { tables } = ok<{ tables: { id: string; seatsUsed: number }[] }>(await c.get('/api/v1/tables'));
    expect(tables.find((t) => t.id === w.tables.t3)?.seatsUsed).toBe(2);
  });
});

describe('split a group', () => {
  it('moves the chosen dishes and guests into a new group and pays separately', async () => {
    let g = await seat(w.tables.t4, 3, 'Family');
    g = await save(g, [[w.items.idly, 4], [w.items.vada, 2], [w.items.juice, 1]]);
    ok(await c.post(`/api/v1/bills/${g.id}/kitchen`));
    g = await get(g);

    const res = ok<{ source: Draft; created: Draft }>(
      await c.post(`/api/v1/bills/${g.id}/split`, {
        version: g.version,
        guestCount: 1,
        groupName: 'Kid',
        items: [
          { menuItemId: w.items.idly, quantity: 1 },
          { menuItemId: w.items.juice, quantity: 1 },
        ],
      }),
      201,
    );
    expect(lines(res.source)).toEqual([['Idly', 3], ['Vada', 2]]);
    expect(lines(res.created)).toEqual([['Idly', 1], ['Fresh Juice', 1]]);
    expect([res.source.guestCount, res.created.guestCount, res.created.groupName, res.created.tableLabel]).toEqual([2, 1, 'Kid', 'T4']);
    expect(res.source.totals.grandTotal + res.created.totals.grandTotal).toBe(4 * 3000 + 2 * 3500 + 5000);
    // Both halves were already sent – nothing new for the kitchen.
    expect(ok(await c.post(`/api/v1/bills/${g.id}/kitchen`))).toEqual([]);
    expect(ok(await c.post(`/api/v1/bills/${res.created.id}/kitchen`))).toEqual([]);

    const paid = await c.post(`/api/v1/bills/${res.created.id}/finalize`, { version: res.created.version, paymentMethod: 'UPI', idempotencyKey: key() });
    expect(paid.status).toBe(201);
    expect(paid.body.data.transaction.grandTotal).toBe(8000);
  });

  it('keeps at least one guest and one dish behind', async () => {
    let g = await seat(w.tables.t2, 1, 'One');
    g = await save(g, [[w.items.dosa, 2]]);
    const body = { version: g.version, guestCount: 1, items: [{ menuItemId: w.items.dosa, quantity: 1 }] };
    expect((await c.post(`/api/v1/bills/${g.id}/split`, body)).status).toBe(400);

    const t5 = ok<{ id: string }>(await c.post('/api/v1/tables', { label: 'T5', seats: 4, shape: 'SQUARE', floor: 'Ground Floor' }), 201).id;
    let two = await seat(t5, 2, 'Two');
    two = await save(two, [[w.items.dosa, 2]]);
    const all = await c.post(`/api/v1/bills/${two.id}/split`, { version: two.version, guestCount: 1, items: [{ menuItemId: w.items.dosa, quantity: 2 }] });
    expect(all.status).toBe(400);
    const tooMany = await c.post(`/api/v1/bills/${two.id}/split`, { version: two.version, guestCount: 1, items: [{ menuItemId: w.items.dosa, quantity: 3 }] });
    expect(tooMany.status).toBe(400);
    const notOnBill = await c.post(`/api/v1/bills/${two.id}/split`, { version: two.version, guestCount: 1, items: [{ menuItemId: w.items.biryani, quantity: 1 }] });
    expect(notOnBill.status).toBe(400);
  });
});
