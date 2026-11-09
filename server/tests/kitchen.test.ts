import { beforeAll, describe, expect, it } from 'vitest';
import { ticketPlace } from '@rb/shared';
import { KitchenTicketModel } from '../src/models/index.js';
import { buildWorld, Client, key, ok, PASSWORD, useTestDatabase, type World } from './helpers.js';

useTestDatabase();

interface Draft {
  id: string;
  version: number;
}
interface Ticket {
  id: string;
  draftId?: string;
  number: string;
  type: string;
  tableLabel: string;
  groupName: string;
  status: string;
  priority: boolean;
  orderType: string;
  token: number | null;
  billNumber: string;
  servedByName: string;
  createdAt: string;
  items: { name: string; quantity: number }[];
}

let w: World;
const lines = (t: Ticket) => t.items.map((i) => [i.name, i.quantity]);

async function save(c: Client, d: Draft, items: { menuItemId: string; quantity: number }[]) {
  return ok<Draft>(await c.put(`/api/v1/bills/${d.id}`, { version: d.version, items }));
}
async function finalize(c: Client, d: Draft, paymentMethod = 'CASH') {
  return c.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod, idempotencyKey: key() });
}
const board = async (c: Client) => ok<Ticket[]>(await c.get('/api/v1/kitchen/tickets'));

beforeAll(async () => {
  w = await buildWorld();
});

describe('kitchen display is per branch and off by default', () => {
  it('does nothing until the Super Admin switches it on', async () => {
    const res = await w.adminA1.get('/api/v1/kitchen/tickets');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KITCHEN_OFF');
    let d = ok<Draft>(await w.adminA1.get('/api/v1/bills/counter'));
    d = await save(w.adminA1, d, [{ menuItemId: w.items.idly, quantity: 1 }]);
    expect((await finalize(w.adminA1, d)).status).toBe(201);
    expect(await KitchenTicketModel.countDocuments()).toBe(0);

    expect((await w.adminA1.patch(`/api/v1/admin/branches/${w.branchA1}`, { kitchenDisplay: true })).status).toBe(403);
    const b = ok<{ kitchenDisplay: boolean }>(await w.sa.patch(`/api/v1/admin/branches/${w.branchA1}`, { kitchenDisplay: true }));
    expect(b.kitchenDisplay).toBe(true);
    const me = ok<{ branches: { id: string; kitchenDisplay: boolean }[] }>(await w.adminA1.get('/api/v1/auth/me'));
    expect(me.branches[0].kitchenDisplay).toBe(true);
    expect(await board(w.adminA1)).toEqual([]);
  });
});

describe('sending orders', () => {
  let group: Draft;

  it('sends only what was added since the last ticket', async () => {
    group = ok<Draft>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId: w.tables.t1, guestCount: 2, groupName: 'Ravi' }), 201);
    group = await save(w.adminA1, group, [{ menuItemId: w.items.idly, quantity: 2 }]);
    const pending = async () => {
      const { tables } = ok<{ tables: { groups: { draftId: string; kitchenPending: number }[] }[] }>(await w.adminA1.get('/api/v1/tables'));
      return tables.flatMap((t) => t.groups).find((g) => g.draftId === group.id)?.kitchenPending;
    };
    expect(await pending()).toBe(2);
    const t1 = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${group.id}/kitchen`))[0];
    expect(await pending()).toBe(0);
    expect(ok<{ kitchenSent: unknown[] }>(await w.adminA1.get(`/api/v1/bills/${group.id}`)).kitchenSent).toEqual([{ menuItemId: w.items.idly, quantity: 2 }]);
    expect(t1.number).toMatch(/^\d{8}-0001$/);
    expect([t1.type, t1.tableLabel, t1.groupName, t1.status]).toEqual(['TABLE', 'T1', 'Ravi', 'NEW']);
    expect(lines(t1)).toEqual([['Idly', 2]]);
    expect(ok(await w.adminA1.post(`/api/v1/bills/${group.id}/kitchen`))).toEqual([]);

    group = await save(w.adminA1, group, [
      { menuItemId: w.items.idly, quantity: 3 },
      { menuItemId: w.items.coffee, quantity: 1 },
    ]);
    const t2 = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${group.id}/kitchen`))[0];
    expect(t2.number).toMatch(/-0002$/);
    expect(lines(t2)).toEqual([
      ['Idly', 1],
      ['Coffee', 1],
    ]);
  });

  it('never re-sends food after a quantity goes down and up again', async () => {
    group = await save(w.adminA1, group, [{ menuItemId: w.items.idly, quantity: 1 }]);
    group = await save(w.adminA1, group, [{ menuItemId: w.items.idly, quantity: 3 }]);
    expect(ok(await w.adminA1.post(`/api/v1/bills/${group.id}/kitchen`))).toEqual([]);
  });

  it('generating the bill sends whatever is left', async () => {
    group = await save(w.adminA1, group, [
      { menuItemId: w.items.idly, quantity: 3 },
      { menuItemId: w.items.dosa, quantity: 1 },
    ]);
    expect((await finalize(w.adminA1, group)).status).toBe(201);
    const tickets = await board(w.adminA1);
    expect(tickets.map(lines)).toEqual([[['Idly', 2]], [['Idly', 1], ['Coffee', 1]], [['Dosa', 1]]]);
  });

  it('a counter bill goes to the kitchen in full', async () => {
    let d = ok<Draft>(await w.adminA1.get('/api/v1/bills/counter'));
    d = await save(w.adminA1, d, [
      { menuItemId: w.items.vada, quantity: 2 },
      { menuItemId: w.items.juice, quantity: 1 },
    ]);
    expect((await finalize(w.adminA1, d, 'UPI')).status).toBe(201);
    const last = (await board(w.adminA1)).at(-1)!;
    expect([last.type, last.tableLabel, last.orderType, last.token]).toEqual(['COUNTER', '', 'TAKEAWAY', 1]);
    expect(lines(last)).toEqual([
      ['Vada', 2],
      ['Fresh Juice', 1],
    ]);
  });

  it('deleting an order cancels tickets the kitchen has not started', async () => {
    let g = ok<Draft>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId: w.tables.t2, guestCount: 1 }), 201);
    g = await save(w.adminA1, g, [{ menuItemId: w.items.biryani, quantity: 1 }]);
    const t = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${g.id}/kitchen`))[0];
    expect((await w.adminA1.delete(`/api/v1/bills/${g.id}?version=${g.version}`)).status).toBe(204);
    expect((await board(w.adminA1)).some((x) => x.id === t.id)).toBe(false);
    expect((await KitchenTicketModel.findById(t.id).lean())?.status).toBe('CANCELLED');
  });
});

describe('the pipeline', () => {
  it('moves New → Preparing → Ready → Served, one step at a time', async () => {
    const [t] = await board(w.adminA1);
    const step = (from: string) => w.adminA1.post(`/api/v1/kitchen/tickets/${t.id}/advance`, { from });
    expect(ok<Ticket>(await step('NEW')).status).toBe('PREPARING');
    const stale = await step('NEW');
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.current.status).toBe('PREPARING');
    expect(ok<Ticket>(await step('PREPARING')).status).toBe('READY');
    expect(ok<Ticket>(await step('READY')).status).toBe('SERVED');
    expect((await board(w.adminA1)).some((x) => x.id === t.id)).toBe(false);
    expect((await step('SERVED')).status).toBe(409);
    // The printed slip still works once it has left the board.
    expect(ok<Ticket>(await w.adminA1.get(`/api/v1/kitchen/tickets/${t.id}`)).number).toBe(t.number);
  });

  it('priority tickets come first', async () => {
    const tickets = await board(w.adminA1);
    const last = tickets.at(-1)!;
    expect(ok<Ticket>(await w.adminA1.post(`/api/v1/kitchen/tickets/${last.id}/priority`, { priority: true })).priority).toBe(true);
    expect((await board(w.adminA1))[0].id).toBe(last.id);
  });

  it('other branches cannot see or move the tickets', async () => {
    const [t] = await board(w.adminA1);
    expect((await w.adminA2.get(`/api/v1/kitchen/tickets/${t.id}`)).status).toBe(404);
    expect((await w.adminA2.get('/api/v1/kitchen/tickets')).status).toBe(409); // A2 has no kitchen display
    await w.sa.patch(`/api/v1/admin/branches/${w.branchA2}`, { kitchenDisplay: true });
    expect(await board(w.adminA2)).toEqual([]);
    expect((await w.adminA2.post(`/api/v1/kitchen/tickets/${t.id}/advance`, { from: t.status })).status).toBe(404);
  });
});

let cook: Client;

describe('kitchen login', () => {
  it('the Super Admin creates a Kitchen login for one branch', async () => {
    const body = { name: 'A1 Kitchen', email: 'kitchen.a1@test.local', password: PASSWORD, branchIds: [w.branchA1], role: 'KITCHEN' };
    expect((await w.adminA1.post('/api/v1/admin/users', body)).status).toBe(403);
    const u = ok<{ role: string }>(await w.sa.post('/api/v1/admin/users', body), 201);
    expect(u.role).toBe('KITCHEN');
    cook = await new Client().login('kitchen.a1@test.local');
    const me = ok<{ user: { role: string }; branches: { id: string; kitchenDisplay: boolean }[] }>(await cook.get('/api/v1/auth/me'));
    expect(me.user.role).toBe('KITCHEN');
    expect(me.branches.map((b) => [b.id, b.kitchenDisplay])).toEqual([[w.branchA1, true]]);
    cook.useBranch(w.branchA1);
  });

  it('works the board of its own branch', async () => {
    const [t] = await board(cook);
    expect(ok<Ticket>(await cook.post(`/api/v1/kitchen/tickets/${t.id}/advance`, { from: t.status })).status).not.toBe(t.status);
    expect((await cook.useBranch(w.branchA2).get('/api/v1/kitchen/tickets')).status).toBe(403);
    cook.useBranch(w.branchA1);
  });

  it('cannot open anything else', async () => {
    for (const url of ['/api/v1/transactions', '/api/v1/bills/counter', '/api/v1/tables', '/api/v1/menu/items', '/api/v1/admin/users', '/api/v1/admin/analytics/overview']) {
      expect([url, (await cook.get(url)).status]).toEqual([url, 403]);
    }
    const [t] = await board(cook);
    expect((await cook.post(`/api/v1/bills/${t.draftId ?? t.id}/kitchen`)).status).toBe(403);
    expect((await cook.post('/api/v1/bills/table-groups', { tableId: w.tables.t3, guestCount: 1 })).status).toBe(403);
  });
});

describe('parcels', () => {
  let parcel: Ticket;
  let parcelRest: Ticket; // the coffee added after the first send

  it('a take-away order goes to the kitchen as a PARCEL with its token, then the bill number', async () => {
    let d = ok<Draft>(await w.adminA1.get('/api/v1/bills/counter'));
    d = await save(w.adminA1, d, [{ menuItemId: w.items.dosa, quantity: 2 }]);
    // Sent before payment: the token now, the bill number once the bill is generated.
    const early = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${d.id}/kitchen`, { orderType: 'TAKEAWAY' }))[0];
    expect([early.type, early.orderType, early.billNumber]).toEqual(['COUNTER', 'TAKEAWAY', '']);
    expect(early.token).toBe(2);
    d = await save(w.adminA1, d, [
      { menuItemId: w.items.dosa, quantity: 2 },
      { menuItemId: w.items.coffee, quantity: 1 },
    ]);
    const res = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', orderType: 'TAKEAWAY', idempotencyKey: key() });
    const { billNumber } = ok<{ transaction: { billNumber: string } }>(res, 201).transaction;
    const mine = (await board(w.adminA1)).filter((t) => t.draftId === d.id);
    expect(mine.map((t) => [lines(t), t.orderType, t.token, t.billNumber])).toEqual([
      [[['Dosa', 2]], 'TAKEAWAY', 2, billNumber],
      [[['Coffee', 1]], 'TAKEAWAY', 2, billNumber],
    ]);
    [parcel, parcelRest] = mine;
  });

  it('the next counter order gets the next token; New Bill is always a parcel, even if an older app says Dine In', async () => {
    let d = ok<Draft>(await w.adminA1.get('/api/v1/bills/counter'));
    d = await save(w.adminA1, d, [{ menuItemId: w.items.idly, quantity: 1 }]);
    const res = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'UPI', orderType: 'DINE_IN', idempotencyKey: key() });
    expect(res.status).toBe(201);
    const t = (await board(w.adminA1)).find((x) => x.draftId === d.id)!;
    expect([t.orderType, t.token, t.billNumber]).toEqual(['TAKEAWAY', 3, res.body.data.transaction.billNumber]);
  });

  it('when Ready, only the counter hands it over – then it leaves every board', async () => {
    for (const from of ['NEW', 'PREPARING']) ok(await cook.post(`/api/v1/kitchen/tickets/${parcel.id}/advance`, { from }));
    expect((await cook.post(`/api/v1/kitchen/tickets/${parcel.id}/advance`, { from: 'READY' })).status).toBe(403);
    expect((await cook.post(`/api/v1/kitchen/tickets/${parcel.id}/handed-over`)).status).toBe(403);
    expect((await cook.get('/api/v1/kitchen/parcels')).status).toBe(403);
    // Part of it is still being made: not ready to hand over yet.
    expect(ok<Ticket[]>(await w.adminA1.get('/api/v1/kitchen/parcels'))).toEqual([]);
    const early = await w.adminA1.post(`/api/v1/kitchen/tickets/${parcel.id}/handed-over`);
    expect([early.status, early.body.error.code]).toEqual([409, 'PARCEL_NOT_READY']);
    for (const from of ['NEW', 'PREPARING']) ok(await cook.post(`/api/v1/kitchen/tickets/${parcelRest.id}/advance`, { from }));
    expect(ok<Ticket[]>(await w.adminA1.get('/api/v1/kitchen/parcels')).map((t) => t.id)).toEqual([parcel.id, parcelRest.id]);

    const done = ok<Ticket>(await w.adminA1.post(`/api/v1/kitchen/tickets/${parcel.id}/handed-over`));
    expect([done.status, done.servedByName]).toEqual(['SERVED', 'a1@test.local']);
    ok(await w.adminA1.post(`/api/v1/kitchen/tickets/${parcelRest.id}/handed-over`)); // New Bill hands over both together
    expect(ok<Ticket[]>(await w.adminA1.get('/api/v1/kitchen/parcels'))).toEqual([]);
    expect((await board(w.adminA1)).some((t) => t.id === parcel.id)).toBe(false);
    expect((await w.adminA1.post(`/api/v1/kitchen/tickets/${parcel.id}/handed-over`)).status).toBe(409);

    // It now shows under Served, for the counter and the kitchen alike – latest first.
    for (const client of [w.adminA1, cook]) {
      const served = ok<Ticket[]>(await client.get('/api/v1/kitchen/served'));
      expect(served.slice(0, 2).map((t) => t.id)).toEqual([parcelRest.id, parcel.id]);
      expect(served[1]).toMatchObject({ status: 'SERVED', servedByName: 'a1@test.local' });
    }
    expect(ok<Ticket[]>(await w.adminA1.get('/api/v1/kitchen/served?date=2020-01-01'))).toEqual([]);
    expect((await w.adminA1.get('/api/v1/kitchen/served?date=today')).status).toBe(400);
  });

  it('a table order is served, not handed over', async () => {
    const t = (await board(w.adminA1)).find((x) => x.tableLabel)!;
    const res = await w.adminA1.post(`/api/v1/kitchen/tickets/${t.id}/handed-over`);
    expect([res.status, res.body.error.code]).toEqual([409, 'NOT_PARCEL']);
  });

  it('another branch never sees or hands over the parcel', async () => {
    expect(ok<Ticket[]>(await w.adminA2.get('/api/v1/kitchen/parcels'))).toEqual([]);
    expect((await w.adminA2.post(`/api/v1/kitchen/tickets/${parcel.id}/handed-over`)).status).toBe(404);
    expect((await w.adminB1.post(`/api/v1/kitchen/tickets/${parcel.id}/handed-over`)).status).toBe(404);
  });
});

describe('dish notes', () => {
  type Line = { menuItemId: string; quantity: number; note?: string };
  const notes = (d: { items: { name: string; note: string }[] }) => d.items.map((i) => [i.name, i.note]);

  it('a note goes to the kitchen with the dish, and stays when a screen leaves it out', async () => {
    let g = ok<Draft & { items: { name: string; note: string }[] }>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId: w.tables.t3, guestCount: 2 }), 201);
    const put = async (items: Line[]) => (g = ok(await w.adminA1.put(`/api/v1/bills/${g.id}`, { version: g.version, items })));
    await put([
      { menuItemId: w.items.dosa, quantity: 1, note: '  no onion ' },
      { menuItemId: w.items.coffee, quantity: 1 },
    ]);
    expect(notes(g)).toEqual([
      ['Dosa', 'no onion'],
      ['Coffee', ''],
    ]);
    const t1 = ok<(Ticket & { items: { name: string; note: string }[] })[]>(await w.adminA1.post(`/api/v1/bills/${g.id}/kitchen`))[0];
    expect(notes(t1)).toEqual([
      ['Dosa', 'no onion'],
      ['Coffee', ''],
    ]);
    // An older screen sends no notes: they are kept, and go with the next portion too.
    await put([
      { menuItemId: w.items.dosa, quantity: 2 },
      { menuItemId: w.items.coffee, quantity: 1 },
    ]);
    expect(notes(g)[0]).toEqual(['Dosa', 'no onion']);
    const t2 = ok<(Ticket & { items: { name: string; note: string }[] })[]>(await w.adminA1.post(`/api/v1/bills/${g.id}/kitchen`))[0];
    expect(notes(t2)).toEqual([['Dosa', 'no onion']]);
    // An empty note clears it.
    await put([
      { menuItemId: w.items.dosa, quantity: 2, note: '' },
      { menuItemId: w.items.coffee, quantity: 1 },
    ]);
    expect(notes(g)[0]).toEqual(['Dosa', '']);
    expect((await w.adminA1.put(`/api/v1/bills/${g.id}`, { version: g.version, items: [{ menuItemId: w.items.dosa, quantity: 2, note: 'x'.repeat(61) }] })).status).toBe(400);
  });

  it('merging keeps the notes', async () => {
    const mk = async (items: Line[]) => {
      const d = ok<Draft>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId: w.tables.t4, guestCount: 1 }), 201);
      return ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items }));
    };
    const a = await mk([{ menuItemId: w.items.vada, quantity: 1, note: 'extra chutney' }]);
    const b = await mk([{ menuItemId: w.items.idly, quantity: 2, note: 'less spicy' }]);
    const merged = ok<Draft & { items: { name: string; note: string }[] }>(await w.adminA1.post(`/api/v1/bills/${b.id}/merge`, { version: b.version, intoDraftId: a.id }));
    expect(notes(merged)).toEqual([
      ['Vada', 'extra chutney'],
      ['Idly', 'less spicy'],
    ]);
  });
});

describe('ticking dishes', () => {
  type Item = { menuItemId: string; name: string; quantity: number; ready: boolean; served: boolean };
  type T = Omit<Ticket, 'items'> & { items: Item[] };
  let t: T;
  const tick = (c: Client, menuItemId: string, ready = true) => c.post(`/api/v1/kitchen/tickets/${t.id}/dish-ready`, { menuItemId, ready });
  const waiterBoard = async () => ok<T[]>(await w.adminA1.get('/api/v1/waiter/tickets'));
  const marks = (x: T) => x.items.map((i) => [i.name, i.ready, i.served]);

  it('nothing can be ticked until the kitchen starts preparing', async () => {
    let g = ok<Draft>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId: w.tables.t1, guestCount: 2, groupName: 'Tick' }), 201);
    g = await save(w.adminA1, g, [
      { menuItemId: w.items.idly, quantity: 2 },
      { menuItemId: w.items.dosa, quantity: 1 },
      { menuItemId: w.items.coffee, quantity: 1 },
    ]);
    t = ok<T[]>(await w.adminA1.post(`/api/v1/bills/${g.id}/kitchen`))[0];
    expect((await tick(cook, w.items.dosa)).status).toBe(409);
    ok(await cook.post(`/api/v1/kitchen/tickets/${t.id}/advance`, { from: 'NEW' }));
  });

  it('a ticked dish goes to the waiter now; the ticket stays in Preparing', async () => {
    const after = ok<T>(await tick(cook, w.items.dosa));
    expect(after.status).toBe('PREPARING');
    expect(marks(after)).toEqual([
      ['Idly', false, false],
      ['Dosa', true, false],
      ['Coffee', false, false],
    ]);
    expect((await waiterBoard()).find((x) => x.id === t.id)).toBeTruthy();
    // Untick while not served yet: it leaves the waiter's board again.
    ok(await tick(cook, w.items.dosa, false));
    expect((await waiterBoard()).some((x) => x.id === t.id)).toBe(false);
    ok(await tick(cook, w.items.dosa));
  });

  it('the waiter serves the ticked dish; the rest keeps cooking', async () => {
    const served = ok<T>(await w.adminA1.post(`/api/v1/waiter/tickets/${t.id}/served`));
    expect(served.status).toBe('PREPARING');
    expect(marks(served)[1]).toEqual(['Dosa', true, true]);
    expect((await waiterBoard()).some((x) => x.id === t.id)).toBe(false);
    expect((await w.adminA1.post(`/api/v1/waiter/tickets/${t.id}/served`)).status).toBe(409); // nothing ticked now
    expect((await tick(cook, w.items.dosa, false)).status).toBe(409); // served: cannot be unticked
    // The table shows the Dosa as served.
    const { tables } = ok<{ tables: { groups: { draftId: string; kitchenServed: { menuItemId: string; quantity: number }[] }[] }[] }>(await w.adminA1.get('/api/v1/tables'));
    expect(tables.flatMap((x) => x.groups).find((g) => g.draftId === t.draftId)!.kitchenServed).toEqual([{ menuItemId: w.items.dosa, quantity: 1 }]);
  });

  it('the last tick moves the whole ticket to Ready; serving it finishes the order', async () => {
    expect(ok<T>(await tick(cook, w.items.idly)).status).toBe('PREPARING');
    const ready = ok<T>(await tick(cook, w.items.coffee));
    expect(ready.status).toBe('READY');
    expect(ready.number).toBe(t.number); // one ticket all along
    const done = ok<T>(await w.adminA1.post(`/api/v1/waiter/tickets/${t.id}/served`));
    expect([done.status, marks(done)]).toEqual([
      'SERVED',
      [
        ['Idly', true, true],
        ['Dosa', true, true],
        ['Coffee', true, true],
      ],
    ]);
  });

  it('another branch cannot tick its dishes', async () => {
    expect((await w.adminA2.post(`/api/v1/kitchen/tickets/${t.id}/dish-ready`, { menuItemId: w.items.idly, ready: true })).status).toBe(404);
  });
});

describe('order numbers', () => {
  it('every KOT of one table order shows the same Order no.; the next customer at that table gets the next one; parcels keep their own Tokens', async () => {
    const order = async (tableId: string, items: { menuItemId: string; quantity: number }[]) => {
      let g = ok<Draft>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId, guestCount: 1 }), 201);
      g = await save(w.adminA1, g, items);
      return g;
    };
    let a = await order(w.tables.t2, [{ menuItemId: w.items.idly, quantity: 1 }]);
    const a1 = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${a.id}/kitchen`))[0];
    const b = await order(w.tables.t2, [{ menuItemId: w.items.vada, quantity: 1 }]);
    const b1 = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${b.id}/kitchen`))[0];
    // More for the first order later: a new KOT number, the same Order no.
    a = await save(w.adminA1, a, [
      { menuItemId: w.items.idly, quantity: 1 },
      { menuItemId: w.items.dosa, quantity: 1 },
    ]);
    const a2 = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${a.id}/kitchen`))[0];
    expect(a1.token).toBeGreaterThan(0);
    expect(a2.number).not.toBe(a1.number);
    expect(a2.token).toBe(a1.token);
    expect(b1.token).toBe(a1.token! + 1);
    // Every table counts its own customers: a new table starts at 1, shown as "Order T9-1".
    const t9 = ok<{ id: string }>(await w.adminA1.post('/api/v1/tables', { label: 'T9', seats: 4, shape: 'SQUARE', floor: 'Ground Floor' }), 201).id;
    const c1 = await order(t9, [{ menuItemId: w.items.idly, quantity: 1 }]);
    const k1 = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${c1.id}/kitchen`))[0];
    expect([k1.tableLabel, k1.token]).toEqual(['T9', 1]);
    expect(ticketPlace(k1 as Parameters<typeof ticketPlace>[0])).toBe('Table T9 · Group 1 · Order T9-1');
    // The family after them at T9 (once the first has paid) is customer 2.
    expect((await finalize(w.adminA1, ok<Draft>(await w.adminA1.get(`/api/v1/bills/${c1.id}`)))).status).toBe(201);
    const c2 = await order(t9, [{ menuItemId: w.items.vada, quantity: 1 }]);
    expect(ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${c2.id}/kitchen`))[0].token).toBe(2);

    // A parcel's Token is counted on its own.
    const tokensBefore = (await board(w.adminA1)).filter((t) => t.orderType === 'TAKEAWAY').map((t) => t.token ?? 0);
    let c = ok<Draft>(await w.adminA1.get('/api/v1/bills/counter'));
    c = await save(w.adminA1, c, [{ menuItemId: w.items.coffee, quantity: 1 }]);
    const p = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${c.id}/kitchen`))[0];
    expect(p.token).toBe(Math.max(0, ...tokensBefore) + 1);
  });
});
