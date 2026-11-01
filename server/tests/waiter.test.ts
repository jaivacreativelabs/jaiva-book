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

  it('a waiter login opens nothing else', async () => {
    for (const url of ['/api/v1/kitchen/tickets', '/api/v1/transactions', '/api/v1/bills/counter', '/api/v1/tables', '/api/v1/menu/items', '/api/v1/expenses']) {
      expect((await waiter.get(url)).status, url).toBe(403);
    }
    expect((await waiter.post('/api/v1/bills/manual-sale', { amount: 100, paymentMethod: 'CASH', idempotencyKey: key() })).status).toBe(403);
    expect(ok<{ user: { role: string } }>(await waiter.get('/api/v1/auth/me')).user.role).toBe('WAITER');
  });

  it('cannot see another branch', async () => {
    expect((await waiter.useBranch(w.branchA2).get('/api/v1/waiter/tickets')).status).toBe(403);
    waiter.useBranch(w.branchA1);
  });
});
