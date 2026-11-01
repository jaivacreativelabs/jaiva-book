import { beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, Client, key, ok, PASSWORD, useTestDatabase, type World } from './helpers.js';

useTestDatabase();

interface Draft {
  id: string;
  version: number;
}
interface Ticket {
  id: string;
  number: string;
  tableLabel: string;
  status: string;
  servedByName: string;
  items: { name: string; quantity: number }[];
}

let w: World;
let waiter: Client;

beforeAll(async () => {
  w = await buildWorld();
  ok(await w.sa.patch(`/api/v1/admin/branches/${w.branchA1}`, { kitchenDisplay: true }));
  const body = { name: 'Muthu', email: 'muthu.a1@test.local', password: PASSWORD, branchIds: [w.branchA1], role: 'WAITER' };
  expect((await w.adminA1.post('/api/v1/admin/users', body)).status).toBe(403); // only the Super Admin creates logins
  expect(ok<{ role: string }>(await w.sa.post('/api/v1/admin/users', body), 201).role).toBe('WAITER');
  waiter = await new Client().login('muthu.a1@test.local');
  waiter.useBranch(w.branchA1);
});

describe('waiter board', () => {
  it('shows only Ready food; Served records the waiter', async () => {
    let g = ok<Draft>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId: w.tables.t1, guestCount: 2 }), 201);
    g = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${g.id}`, { version: g.version, items: [{ menuItemId: w.items.idly, quantity: 2 }] }));
    const t = ok<Ticket>(await w.adminA1.post(`/api/v1/bills/${g.id}/kitchen`));
    expect(ok<Ticket[]>(await waiter.get('/api/v1/waiter/tickets'))).toEqual([]); // still NEW

    for (const from of ['NEW', 'PREPARING']) ok(await w.adminA1.post(`/api/v1/kitchen/tickets/${t.id}/advance`, { from }));
    const ready = ok<Ticket[]>(await waiter.get('/api/v1/waiter/tickets'));
    expect(ready.map((r) => [r.number, r.tableLabel, r.status])).toEqual([[t.number, 'T1', 'READY']]);
    expect(ready[0].items).toEqual([expect.objectContaining({ name: 'Idly', quantity: 2 })]);

    const served = ok<Ticket>(await waiter.post(`/api/v1/waiter/tickets/${t.id}/served`));
    expect([served.status, served.servedByName]).toEqual(['SERVED', 'Muthu']);
    expect(ok<Ticket[]>(await waiter.get('/api/v1/waiter/tickets'))).toEqual([]);
    // A second tap (or another waiter) cannot serve it again.
    expect((await waiter.post(`/api/v1/waiter/tickets/${t.id}/served`)).status).toBe(409);
  });

  it('parcels are not on the waiter board and a waiter cannot hand one over', async () => {
    let d = ok<Draft>(await w.adminA1.get('/api/v1/bills/counter'));
    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.dosa, quantity: 1 }] }));
    const t = ok<Ticket>(await w.adminA1.post(`/api/v1/bills/${d.id}/kitchen`, { orderType: 'TAKEAWAY' }));
    for (const from of ['NEW', 'PREPARING']) ok(await w.adminA1.post(`/api/v1/kitchen/tickets/${t.id}/advance`, { from }));
    expect(ok<Ticket[]>(await waiter.get('/api/v1/waiter/tickets'))).toEqual([]);
    expect((await waiter.post(`/api/v1/waiter/tickets/${t.id}/served`)).status).toBe(403);
    expect(ok<Ticket>(await w.adminA1.post(`/api/v1/kitchen/tickets/${t.id}/handed-over`)).status).toBe('SERVED');
  });

  it('a waiter login opens nothing beyond taking table orders', async () => {
    for (const url of ['/api/v1/kitchen/tickets', '/api/v1/kitchen/parcels', '/api/v1/transactions', '/api/v1/bills/counter', '/api/v1/expenses', '/api/v1/admin/users']) {
      expect((await waiter.get(url)).status, url).toBe(403);
    }
    expect((await waiter.post('/api/v1/bills/manual-sale', { amount: 100, paymentMethod: 'CASH', idempotencyKey: key() })).status).toBe(403);
    expect((await waiter.post('/api/v1/shop/close')).status).toBe(403);
    expect((await waiter.post('/api/v1/tables', { label: 'W1', seats: 2, shape: 'SQUARE', floor: 'Ground Floor' })).status).toBe(403);
    expect((await waiter.patch(`/api/v1/menu/items/${w.items.idly}/availability`, { isAvailable: false })).status).toBe(403);
    expect((await waiter.post('/api/v1/menu/categories', { name: 'Waiter menu', icon: '🍛' })).status).toBe(403);
    expect(ok<{ user: { role: string } }>(await waiter.get('/api/v1/auth/me')).user.role).toBe('WAITER');
  });

  it('cannot see another branch', async () => {
    for (const url of ['/api/v1/waiter/tickets', '/api/v1/tables', '/api/v1/menu/items']) {
      expect((await waiter.useBranch(w.branchA2).get(url)).status, url).toBe(403);
    }
    waiter.useBranch(w.branchA1);
  });
});

describe('waiter takes table orders', () => {
  let g: Draft;
  const save = async (items: { menuItemId: string; quantity: number }[]) => {
    g = ok<Draft>(await waiter.put(`/api/v1/bills/${g.id}`, { version: g.version, items }));
  };
  const groupOnTables = async () => {
    const { tables } = ok<{ tables: { groups: { draftId: string; kitchenStatus: string | null; kitchenPending: number }[] }[] }>(await waiter.get('/api/v1/tables'));
    return tables.flatMap((t) => t.groups).find((x) => x.draftId === g.id)!;
  };

  it('seats a group, adds dishes and sends a KOT with the waiter’s name', async () => {
    expect(ok<unknown[]>(await waiter.get('/api/v1/menu/items')).length).toBeGreaterThan(0);
    g = ok<Draft>(await waiter.post('/api/v1/bills/table-groups', { tableId: w.tables.t4, guestCount: 3 }), 201);
    await save([{ menuItemId: w.items.dosa, quantity: 2 }]);
    expect(ok<Draft>(await waiter.get(`/api/v1/bills/${g.id}`)).version).toBe(g.version);
    expect((await groupOnTables()).kitchenPending).toBe(2);

    const t = ok<Ticket & { createdByName: string; orderType: string }>(await waiter.post(`/api/v1/bills/${g.id}/kitchen`));
    expect([t.tableLabel, t.createdByName, t.orderType]).toEqual(['T4', 'Muthu', 'DINE_IN']);
    const onBoard = ok<(Ticket & { createdByName: string })[]>(await w.adminA1.get('/api/v1/kitchen/tickets')).find((x) => x.id === t.id)!;
    expect([onBoard.tableLabel, onBoard.createdByName]).toEqual(['T4', 'Muthu']);
    expect(await groupOnTables()).toEqual(expect.objectContaining({ kitchenPending: 0, kitchenStatus: 'NEW' }));
  });

  it('a later KOT carries only the new dish; the table shows the kitchen status', async () => {
    await save([
      { menuItemId: w.items.dosa, quantity: 2 },
      { menuItemId: w.items.coffee, quantity: 1 },
    ]);
    const t = ok<Ticket>(await waiter.post(`/api/v1/bills/${g.id}/kitchen`));
    expect(t.items.map((i) => [i.name, i.quantity])).toEqual([['Coffee', 1]]);
    expect(ok(await waiter.post(`/api/v1/bills/${g.id}/kitchen`))).toBeNull(); // nothing is ever sent twice
    for (const from of ['NEW', 'PREPARING']) ok(await w.adminA1.post(`/api/v1/kitchen/tickets/${t.id}/advance`, { from }));
    expect((await groupOnTables()).kitchenStatus).toBe('READY');
  });

  it('cannot lower what the kitchen already has, give discounts or rename', async () => {
    const lower = await waiter.put(`/api/v1/bills/${g.id}`, { version: g.version, items: [{ menuItemId: w.items.dosa, quantity: 1 }, { menuItemId: w.items.coffee, quantity: 1 }] });
    expect([lower.status, lower.body.error.code]).toEqual([403, 'IN_KITCHEN']);
    const items = [
      { menuItemId: w.items.dosa, quantity: 2 },
      { menuItemId: w.items.coffee, quantity: 1 },
    ];
    expect((await waiter.put(`/api/v1/bills/${g.id}`, { version: g.version, items, discount: { type: 'PERCENT', value: 10 } })).status).toBe(403);
    expect((await waiter.put(`/api/v1/bills/${g.id}`, { version: g.version, items, customerName: 'Ravi' })).status).toBe(403);
    expect((await waiter.put(`/api/v1/bills/${g.id}`, { version: g.version, items, guestCount: 4 })).status).toBe(403);
    // Unchanged fields are fine (the bill screens always send them).
    await save([...items, { menuItemId: w.items.vada, quantity: 1 }]);
    const sameAgain = await waiter.put(`/api/v1/bills/${g.id}`, { version: g.version, items: [...items, { menuItemId: w.items.vada, quantity: 1 }], customerName: '', discount: null });
    expect(sameAgain.status).toBe(200);
    g = sameAgain.body.data;
    // A dish not sent yet can still be taken off.
    await save(items);
  });

  it('never bills, deletes, moves, merges or splits – the server says 403', async () => {
    const fin = await waiter.post(`/api/v1/bills/${g.id}/finalize`, { version: g.version, paymentMethod: 'CASH', idempotencyKey: key() });
    expect(fin.status).toBe(403);
    expect((await waiter.delete(`/api/v1/bills/${g.id}?version=${g.version}`)).status).toBe(403);
    expect((await waiter.post(`/api/v1/bills/${g.id}/move`, { version: g.version, tableId: w.tables.t2 })).status).toBe(403);
    expect((await waiter.post(`/api/v1/bills/${g.id}/merge`, { version: g.version, targetDraftId: g.id })).status).toBe(403);
    expect((await waiter.post(`/api/v1/bills/${g.id}/split`, { version: g.version, guestCount: 1, items: [] })).status).toBe(403);
    // The Restaurant Admin generates the bill.
    expect((await w.adminA1.post(`/api/v1/bills/${g.id}/finalize`, { version: g.version, paymentMethod: 'CASH', idempotencyKey: key() })).status).toBe(201);
  });

  it('cannot open or send a counter bill', async () => {
    const counter = ok<Draft>(await w.adminA1.get('/api/v1/bills/counter'));
    expect((await waiter.get(`/api/v1/bills/${counter.id}`)).status).toBe(403);
    expect((await waiter.put(`/api/v1/bills/${counter.id}`, { version: counter.version, items: [{ menuItemId: w.items.idly, quantity: 1 }] })).status).toBe(403);
    expect((await waiter.post(`/api/v1/bills/${counter.id}/kitchen`)).status).toBe(403);
  });

  it('cannot reach another restaurant’s orders', async () => {
    const other = ok<Draft>(await w.adminB1.get('/api/v1/bills/counter'));
    expect((await waiter.get(`/api/v1/bills/${other.id}`)).status).toBe(404);
    expect((await waiter.useBranch(w.branchB1).post('/api/v1/bills/table-groups', { tableId: w.tables.t1, guestCount: 1 })).status).toBe(403);
    waiter.useBranch(w.branchA1);
  });
});
