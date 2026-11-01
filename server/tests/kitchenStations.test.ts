import { beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, Client, ok, PASSWORD, useTestDatabase, type World } from './helpers.js';

useTestDatabase();

interface Draft {
  id: string;
  version: number;
}
interface Ticket {
  id: string;
  draftId: string;
  status: string;
  stationId: string | null;
  stationName: string;
  items: { name: string; quantity: number }[];
}
interface Station {
  id: string;
  name: string;
  categoryIds: string[];
}

let w: World;
let juiceCat: string;
let tiffin: Station;
let juice: Station;
let tiffinCook: Client;
let juiceCook: Client;
let headCook: Client; // a Kitchen login with no counter sees them all

const names = (t: Ticket) => t.items.map((i) => `${i.quantity}× ${i.name}`);
const board = async (c: Client) => ok<Ticket[]>(await c.get('/api/v1/kitchen/tickets'));
const stations = (body: object) => w.sa.put(`/api/v1/admin/branches/${w.branchA1}/kitchen-stations`, body);

async function kitchenLogin(email: string, kitchenStationId: string | null) {
  ok(await w.sa.post('/api/v1/admin/users', { name: email, email, password: PASSWORD, branchIds: [w.branchA1], role: 'KITCHEN', kitchenStationId }), 201);
  return (await new Client().login(email)).useBranch(w.branchA1);
}

async function tableOrder(table: string, items: { menuItemId: string; quantity: number }[]) {
  let g = ok<Draft>(await w.adminA1.post('/api/v1/bills/table-groups', { tableId: table, guestCount: 2 }), 201);
  g = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${g.id}`, { version: g.version, items }));
  return { draft: g, tickets: ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${g.id}/kitchen`)) };
}

beforeAll(async () => {
  w = await buildWorld();
  ok(await w.sa.patch(`/api/v1/admin/branches/${w.branchA1}`, { kitchenDisplay: true }));
  juiceCat = ok<{ id: string }>(await w.sa.post(`/api/v1/menu/categories?restaurantId=${w.restaurantA}`, { name: 'Juices', icon: '🥤' }), 201).id;
  ok(await w.sa.patch(`/api/v1/menu/items/${w.items.juice}?restaurantId=${w.restaurantA}`, { categoryId: juiceCat }));
});

describe('kitchen counters', () => {
  it('the Super Admin sets up the counters of a branch', async () => {
    // A category goes to one counter only, and only this restaurant's categories.
    const twice = await stations({ stations: [{ name: 'Tiffin', categoryIds: [juiceCat] }, { name: 'Juice', categoryIds: [juiceCat] }] });
    expect([twice.status, twice.body.error.code]).toEqual([400, 'DUPLICATE_CATEGORY']);
    expect((await stations({ stations: [{ name: 'Juice', categoryIds: [] }, { name: 'juice ', categoryIds: [] }] })).status).toBe(409);
    expect((await w.adminA1.put(`/api/v1/admin/branches/${w.branchA1}/kitchen-stations`, { stations: [] })).status).toBe(403);

    const branch = ok<{ kitchenStations: Station[] }>(await stations({ stations: [{ name: 'Tiffin', categoryIds: [] }, { name: 'Juice', categoryIds: [juiceCat] }] }));
    [tiffin, juice] = branch.kitchenStations;
    expect([tiffin.name, juice.name, juice.categoryIds]).toEqual(['Tiffin', 'Juice', [juiceCat]]);

    // Signed-in accounts learn the counters with their restaurant.
    const me = ok<{ branches: { id: string; kitchenStations: { name: string }[] }[] }>(await w.adminA1.get('/api/v1/auth/me'));
    expect(me.branches.find((b) => b.id === w.branchA1)!.kitchenStations.map((s) => s.name)).toEqual(['Tiffin', 'Juice']);
  });

  it('a Kitchen login can be given one counter of its own restaurant', async () => {
    tiffinCook = await kitchenLogin('tiffin.a1@test.local', tiffin.id);
    juiceCook = await kitchenLogin('juice.a1@test.local', juice.id);
    headCook = await kitchenLogin('head.a1@test.local', null);
    const res = await w.sa.post('/api/v1/admin/users', { name: 'x', email: 'x.a2@test.local', password: PASSWORD, branchIds: [w.branchA2], role: 'KITCHEN', kitchenStationId: juice.id });
    expect([res.status, res.body.error.code]).toEqual([400, 'INVALID_STATION']);
    const waiter = await w.sa.post('/api/v1/admin/users', { name: 'y', email: 'y.a1@test.local', password: PASSWORD, branchIds: [w.branchA1], role: 'WAITER', kitchenStationId: juice.id });
    expect(waiter.status).toBe(400);
  });

  it('an order is split into one ticket per counter; other dishes go to the first counter', async () => {
    const { tickets } = await tableOrder(w.tables.t1, [
      { menuItemId: w.items.dosa, quantity: 2 },
      { menuItemId: w.items.juice, quantity: 1 },
      { menuItemId: w.items.coffee, quantity: 1 },
    ]);
    expect(tickets.map((t) => [t.stationName, names(t)])).toEqual([
      ['Tiffin', ['2× Dosa', '1× Coffee']],
      ['Juice', ['1× Fresh Juice']],
    ]);
  });

  it('each counter sees and moves only its own tickets', async () => {
    const juiceBoard = await board(juiceCook);
    expect(juiceBoard.map((t) => t.stationName)).toEqual(['Juice']);
    expect((await board(tiffinCook)).map((t) => t.stationName)).toEqual(['Tiffin']);
    expect((await board(headCook)).length).toBe(2);
    expect((await board(w.adminA1)).length).toBe(2);

    const tiffinTicket = (await board(tiffinCook))[0];
    expect((await juiceCook.post(`/api/v1/kitchen/tickets/${tiffinTicket.id}/advance`, { from: 'NEW' })).status).toBe(403);
    expect((await juiceCook.post(`/api/v1/kitchen/tickets/${tiffinTicket.id}/priority`, { priority: true })).status).toBe(403);

    // The juice is ready first and reaches the waiter board on its own.
    for (const from of ['NEW', 'PREPARING']) ok(await juiceCook.post(`/api/v1/kitchen/tickets/${juiceBoard[0].id}/advance`, { from }));
    const ready = ok<Ticket[]>(await w.adminA1.get('/api/v1/waiter/tickets'));
    expect(ready.map((t) => [t.stationName, names(t)])).toEqual([['Juice', ['1× Fresh Juice']]]);
    ok(await w.adminA1.post(`/api/v1/waiter/tickets/${juiceBoard[0].id}/served`));

    // Served lists follow the counter too.
    expect(ok<Ticket[]>(await juiceCook.get('/api/v1/kitchen/served')).map((t) => t.stationName)).toEqual(['Juice']);
    expect(ok<Ticket[]>(await tiffinCook.get('/api/v1/kitchen/served'))).toEqual([]);
  });

  it('a parcel goes out only when every counter has its part Ready', async () => {
    let d = ok<Draft>(await w.adminA1.get('/api/v1/bills/counter'));
    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.idly, quantity: 1 }, { menuItemId: w.items.juice, quantity: 2 }] }));
    const [food, drink] = ok<Ticket[]>(await w.adminA1.post(`/api/v1/bills/${d.id}/kitchen`, { orderType: 'TAKEAWAY' }));
    expect([food.stationName, drink.stationName]).toEqual(['Tiffin', 'Juice']);

    for (const from of ['NEW', 'PREPARING']) ok(await juiceCook.post(`/api/v1/kitchen/tickets/${drink.id}/advance`, { from }));
    expect(ok<Ticket[]>(await w.adminA1.get('/api/v1/kitchen/parcels'))).toEqual([]);
    expect((await w.adminA1.post(`/api/v1/kitchen/tickets/${drink.id}/handed-over`)).status).toBe(409);

    for (const from of ['NEW', 'PREPARING']) ok(await tiffinCook.post(`/api/v1/kitchen/tickets/${food.id}/advance`, { from }));
    expect(ok<Ticket[]>(await w.adminA1.get('/api/v1/kitchen/parcels')).map((t) => t.id).sort()).toEqual([food.id, drink.id].sort());
  });

  it('a counter a login works cannot be removed; moving the login frees it', async () => {
    const res = await stations({ stations: [{ id: tiffin.id, name: 'Tiffin', categoryIds: [] }] });
    expect([res.status, res.body.error.code]).toEqual([409, 'STATION_IN_USE']);

    const users = ok<{ id: string; email: string }[]>(await w.sa.get('/api/v1/admin/users'));
    const juiceLogin = users.find((u) => u.email === 'juice.a1@test.local')!;
    const moved = ok<{ kitchenStationId: string | null }>(await w.sa.patch(`/api/v1/admin/users/${juiceLogin.id}`, { kitchenStationId: null }));
    expect(moved.kitchenStationId).toBeNull();

    // Renaming keeps the counter (its id), so its logins stay with it.
    const after = ok<{ kitchenStations: Station[] }>(await stations({ stations: [{ id: tiffin.id, name: 'Tiffin & Meals', categoryIds: [] }] }));
    expect(after.kitchenStations.map((s) => [s.id, s.name])).toEqual([[tiffin.id, 'Tiffin & Meals']]);
  });

  it('with no counters everything is one ticket again', async () => {
    const users = ok<{ id: string; email: string }[]>(await w.sa.get('/api/v1/admin/users'));
    ok(await w.sa.patch(`/api/v1/admin/users/${users.find((u) => u.email === 'tiffin.a1@test.local')!.id}`, { kitchenStationId: null }));
    ok(await stations({ stations: [] }));
    const { tickets } = await tableOrder(w.tables.t2, [
      { menuItemId: w.items.dosa, quantity: 1 },
      { menuItemId: w.items.juice, quantity: 1 },
    ]);
    expect(tickets.map((t) => [t.stationId, names(t)])).toEqual([[null, ['1× Dosa', '1× Fresh Juice']]]);
  });
});
