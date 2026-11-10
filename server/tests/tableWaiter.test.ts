import { beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, Client, key, ok, PASSWORD, useTestDatabase, type World } from './helpers.js';

useTestDatabase();

interface Draft {
  id: string;
  version: number;
}
interface Table {
  id: string;
  label: string;
  waiter: { id: string; name: string } | null;
}

let w: World;
let ravi: Client;
let kumar: Client;
let raviId: string;
let kumarId: string;

async function makeWaiter(name: string, email: string) {
  const u = ok<{ id: string }>(await w.sa.post('/api/v1/admin/users', { name, email, password: PASSWORD, branchIds: [w.branchA1], role: 'WAITER' }), 201);
  return { id: u.id, client: (await new Client().login(email)).useBranch(w.branchA1) };
}
const tableOf = async (id: string) => ok<{ tables: Table[] }>(await w.adminA1.get('/api/v1/tables')).tables.find((t) => t.id === id)!;
const order = (c: Client, d: Draft, quantity = 1) => c.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.dosa, quantity }] });

beforeAll(async () => {
  w = await buildWorld();
  ok(await w.sa.patch(`/api/v1/admin/branches/${w.branchA1}`, { kitchenDisplay: true }));
  ({ id: raviId, client: ravi } = await makeWaiter('Ravi', 'ravi@test.local'));
  ({ id: kumarId, client: kumar } = await makeWaiter('Kumar', 'kumar@test.local'));
});

describe('a table’s waiter', () => {
  it('the first waiter to take an order gets the table; another waiter is refused, everyone sees whose it is', async () => {
    expect((await tableOf(w.tables.t1)).waiter).toBeNull();
    const g = ok<Draft>(await ravi.post('/api/v1/bills/table-groups', { tableId: w.tables.t1, guestCount: 2 }), 201);
    expect((await tableOf(w.tables.t1)).waiter).toEqual({ id: raviId, name: 'Ravi' });
    // Kumar sees it too, and cannot seat, order or send there.
    expect(ok<{ tables: Table[] }>(await kumar.get('/api/v1/tables')).tables.find((t) => t.id === w.tables.t1)!.waiter?.name).toBe('Ravi');
    const seat = await kumar.post('/api/v1/bills/table-groups', { tableId: w.tables.t1, guestCount: 1 });
    expect([seat.status, seat.body.error.code, seat.body.error.message]).toEqual([403, 'TABLE_TAKEN', 'T1 is Ravi’s table']);
    expect((await order(kumar, g)).status).toBe(403);
    expect((await kumar.post(`/api/v1/bills/${g.id}/kitchen`)).status).toBe(403);
    // Ravi carries on.
    const saved = ok<Draft>(await order(ravi, g));
    ok(await ravi.post(`/api/v1/bills/${saved.id}/kitchen`));
    // The cashier is never blocked.
    ok(await order(w.adminA1, saved, 2));
  });

  it('is free for anyone again once the last group is billed', async () => {
    const [d] = ok<Draft[]>(await w.adminA1.get(`/api/v1/bills?tableId=${w.tables.t1}`));
    ok(await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', idempotencyKey: key() }), 201);
    expect((await tableOf(w.tables.t1)).waiter).toBeNull();
    ok(await kumar.post('/api/v1/bills/table-groups', { tableId: w.tables.t1, guestCount: 1 }), 201);
    expect((await tableOf(w.tables.t1)).waiter?.name).toBe('Kumar');
  });

  it('the cashier gives a table to a waiter, moves it to another or frees it', async () => {
    expect(ok<{ name: string }[]>(await w.adminA1.get('/api/v1/tables/waiters')).map((x) => x.name)).toEqual(['Kumar', 'Ravi']);
    expect((await ravi.get('/api/v1/tables/waiters')).status).toBe(403);
    expect((await ravi.put(`/api/v1/tables/${w.tables.t2}/waiter`, { waiterId: raviId })).status).toBe(403); // waiters cannot assign

    expect(ok<Table>(await w.adminA1.put(`/api/v1/tables/${w.tables.t2}/waiter`, { waiterId: raviId })).waiter?.name).toBe('Ravi');
    // Given to Ravi before guests arrive: only Ravi can seat them.
    expect((await kumar.post('/api/v1/bills/table-groups', { tableId: w.tables.t2, guestCount: 2 })).status).toBe(403);
    const g = ok<Draft>(await ravi.post('/api/v1/bills/table-groups', { tableId: w.tables.t2, guestCount: 2 }), 201);

    // Ravi goes on break: the cashier gives T2 to Kumar.
    ok(await w.adminA1.put(`/api/v1/tables/${w.tables.t2}/waiter`, { waiterId: kumarId }));
    expect((await order(ravi, g)).status).toBe(403);
    ok(await order(kumar, g));

    ok(await w.adminA1.put(`/api/v1/tables/${w.tables.t2}/waiter`, { waiterId: null }));
    expect((await tableOf(w.tables.t2)).waiter).toBeNull();
    // Only this branch's active waiters.
    expect((await w.adminA1.put(`/api/v1/tables/${w.tables.t2}/waiter`, { waiterId: '0123456789abcdef01234567' })).status).toBe(404);
  });

  it('is freed when the last group is deleted or moved away', async () => {
    const g = ok<Draft>(await ravi.post('/api/v1/bills/table-groups', { tableId: w.tables.t3, guestCount: 1 }), 201);
    ok(await w.adminA1.post(`/api/v1/bills/${g.id}/move`, { version: g.version, tableId: w.tables.t4 }));
    expect((await tableOf(w.tables.t3)).waiter).toBeNull();

    const h = ok<Draft>(await ravi.post('/api/v1/bills/table-groups', { tableId: w.tables.t3, guestCount: 1 }), 201);
    expect((await w.adminA1.delete(`/api/v1/bills/${h.id}?version=${h.version}`)).status).toBe(204);
    expect((await tableOf(w.tables.t3)).waiter).toBeNull();
  });

  it('a deactivated waiter no longer holds tables', async () => {
    ok(await w.adminA1.put(`/api/v1/tables/${w.tables.t3}/waiter`, { waiterId: raviId }));
    ok(await w.sa.patch(`/api/v1/admin/users/${raviId}/status`, { status: 'INACTIVE' }));
    expect((await tableOf(w.tables.t3)).waiter).toBeNull();
    expect(ok<{ name: string }[]>(await w.adminA1.get('/api/v1/tables/waiters')).map((x) => x.name)).toEqual(['Kumar']);
  });
});
