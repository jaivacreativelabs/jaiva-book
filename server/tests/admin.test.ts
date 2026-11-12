import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/models/index.js';
import { buildWorld, Client, ok, PASSWORD, useTestDatabase, type World } from './helpers.js';

useTestDatabase();

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

describe('Super Admin – restaurants and branches', () => {
  it('lists restaurants with branch counts', async () => {
    const list = ok<{ name: string; branchCount: number }[]>(await w.sa.get('/api/v1/admin/restaurants'));
    // Main Branch (created automatically) + A1 + A2
    expect(list.find((r) => r.name === 'Restaurant A')?.branchCount).toBe(3);
  });

  it('creates its one branch (same name, bill code from the initials) with the restaurant', async () => {
    const r = ok<{ id: string; branchCount: number; mainBranchId: string }>(
      await w.sa.post('/api/v1/admin/restaurants', { name: 'Restaurant C', phone: '+91 99999 00000', address: 'Madurai' }),
      201,
    );
    expect(r.branchCount).toBe(1);
    const d = ok<{ branches: { id: string; name: string; code: string; phone: string; address: string; status: string }[] }>(
      await w.sa.get(`/api/v1/admin/restaurants/${r.id}`),
    );
    expect(d.branches).toEqual([
      expect.objectContaining({ id: r.mainBranchId, name: 'Restaurant C', code: 'RC', phone: '+91 99999 00000', address: 'Madurai', status: 'ACTIVE' }),
    ]);
    // Ready to use straight away: an admin can be assigned to it.
    ok(await w.sa.post('/api/v1/admin/users', { name: 'C Admin', email: 'c@test.local', password: 'Passw0rd!', branchIds: [r.mainBranchId] }), 201);
  });

  it('takes a given bill code, and keeps its one branch in step when the restaurant is edited', async () => {
    const r = ok<{ id: string; mainBranchId: string }>(
      await w.sa.post('/api/v1/admin/restaurants', { name: 'Keda Kari Virundhu', billCode: 'kkv2', address: 'Thisayanvillai' }),
      201,
    );
    ok(await w.sa.patch(`/api/v1/admin/restaurants/${r.id}`, { name: 'Keda Kari', phone: '98765 43210', address: 'Tirunelveli' }));
    const d = ok<{ branches: { name: string; code: string; phone: string; address: string }[] }>(await w.sa.get(`/api/v1/admin/restaurants/${r.id}`));
    expect(d.branches).toEqual([expect.objectContaining({ name: 'Keda Kari', code: 'KKV2', phone: '98765 43210', address: 'Tirunelveli' })]);
  });

  it('rejects duplicate restaurant names (case-insensitive)', async () => {
    const res = await w.sa.post('/api/v1/admin/restaurants', { name: 'restaurant a' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Restaurant with this name already exists.');
    // Extra spaces count as the same name; renaming another restaurant to it is refused too.
    const spaced = await w.sa.post('/api/v1/admin/restaurants', { name: '  Restaurant   A ' });
    expect(spaced.status).toBe(409);
    const rename = await w.sa.patch(`/api/v1/admin/restaurants/${w.restaurantB}`, { name: 'RESTAURANT A' });
    expect(rename.status).toBe(409);
    expect(rename.body.error.message).toBe('Restaurant with this name already exists.');
  });

  it('rejects duplicate branch codes in the same restaurant', async () => {
    const res = await w.sa.post('/api/v1/admin/branches', { restaurantId: w.restaurantA, name: 'Other', code: 'a1' });
    expect(res.status).toBe(409);
  });

  it('edits a restaurant and its tax settings', async () => {
    const r = ok<{ address: string }>(await w.sa.patch(`/api/v1/admin/restaurants/${w.restaurantB}`, { address: 'New St' }));
    expect(r.address).toBe('New St');
    const s = ok<{ settings: { taxes: unknown[] } }>(
      await w.sa.patch(`/api/v1/admin/restaurants/${w.restaurantB}/settings`, {
        taxes: [{ name: 'GST', rateBps: 500 }],
        pricesIncludeTax: false,
        receiptFooter: 'Thanks',
      }),
    );
    expect(s.settings.taxes).toHaveLength(1);
  });

  it('shows restaurant detail with branches and admins', async () => {
    const d = ok<{ branches: unknown[]; admins: { email: string }[] }>(await w.sa.get(`/api/v1/admin/restaurants/${w.restaurantA}`));
    expect(d.branches).toHaveLength(3);
    expect(d.admins.map((a) => a.email).sort()).toEqual(['a1@test.local', 'a2@test.local']);
  });

  it('deactivating a branch blocks its Restaurant Admin', async () => {
    ok(await w.sa.patch(`/api/v1/admin/branches/${w.branchA2}/status`, { status: 'INACTIVE' }));
    expect((await w.adminA2.get('/api/v1/tables')).status).toBe(403);
    ok(await w.sa.patch(`/api/v1/admin/branches/${w.branchA2}/status`, { status: 'ACTIVE' }));
    expect((await w.adminA2.get('/api/v1/tables')).status).toBe(200);
  });

  it('deactivating a restaurant blocks all of its branches', async () => {
    ok(await w.sa.patch(`/api/v1/admin/restaurants/${w.restaurantB}/status`, { status: 'INACTIVE' }));
    expect((await w.adminB1.get('/api/v1/tables')).status).toBe(403);
    ok(await w.sa.patch(`/api/v1/admin/restaurants/${w.restaurantB}/status`, { status: 'ACTIVE' }));
  });

  it('deletes a restaurant with everything in it, leaving the others untouched', async () => {
    const r = ok<{ id: string; mainBranchId: string }>(await w.sa.post('/api/v1/admin/restaurants', { name: 'Closing Down' }), 201);
    ok(await w.sa.post('/api/v1/admin/users', { name: 'Gone', email: 'gone@test.local', password: PASSWORD, branchIds: [r.mainBranchId] }), 201);
    const admin = (await new Client().login('gone@test.local')).useBranch(r.mainBranchId);
    const cat = ok<{ id: string }>(await admin.post('/api/v1/menu/categories', { name: 'Meals' }), 201);
    const item = ok<{ id: string }>(await admin.post('/api/v1/menu/items', { categoryId: cat.id, name: 'Thali', price: 12000 }), 201);
    const bill = ok<{ id: string; version: number }>(await admin.get('/api/v1/bills/counter'));
    ok(await admin.put(`/api/v1/bills/${bill.id}`, { version: bill.version, items: [{ menuItemId: item.id, quantity: 1 }] }));

    // Restaurant Admins cannot delete restaurants.
    expect((await w.adminA1.delete(`/api/v1/admin/restaurants/${r.id}`)).status).toBe(403);
    ok(await w.sa.delete(`/api/v1/admin/restaurants/${r.id}`));

    expect((await w.sa.get(`/api/v1/admin/restaurants/${r.id}`)).status).toBe(404);
    expect(ok<{ id: string }[]>(await w.sa.get('/api/v1/admin/restaurants')).map((x) => x.id)).not.toContain(r.id);
    expect((await new Client().post('/api/v1/auth/login', { email: 'gone@test.local', password: PASSWORD })).status).toBe(401);
    expect(await AuditLogModel.exists({ action: 'RESTAURANT_DELETED', entityId: r.id })).toBeTruthy();
    // Other restaurants keep their menu.
    expect(ok<unknown[]>(await w.adminA1.get('/api/v1/menu/items')).length).toBeGreaterThan(0);
    expect((await w.sa.delete(`/api/v1/admin/restaurants/${r.id}`)).status).toBe(404);
  });
});

describe('Super Admin – Restaurant Admin accounts', () => {
  it('creates, reassigns and isolates a Restaurant Admin', async () => {
    const created = ok<{ id: string; restaurantIds: string[]; role: string }>(
      await w.sa.post('/api/v1/admin/users', { name: 'Moving', email: 'move@test.local', password: PASSWORD, branchIds: [w.branchA1] }),
      201,
    );
    expect(created.role).toBe('RESTAURANT_ADMIN');
    expect(created.restaurantIds).toEqual([w.restaurantA]);

    const ra = (await new Client().login('move@test.local')).useBranch(w.branchA1);
    expect((await ra.get('/api/v1/tables')).status).toBe(200);
    expect((await ra.useBranch(w.branchB1).get('/api/v1/tables')).status).toBe(403);

    const moved = ok<{ restaurantIds: string[] }>(await w.sa.patch(`/api/v1/admin/users/${created.id}`, { branchIds: [w.branchB1] }));
    expect(moved.restaurantIds).toEqual([w.restaurantB]);
    expect((await ra.useBranch(w.branchB1).get('/api/v1/tables')).status).toBe(200);
    expect((await ra.useBranch(w.branchA1).get('/api/v1/tables')).status).toBe(403);
  });

  it('keeps branches isolated: a Restaurant Admin can be assigned to only one branch', async () => {
    const two = await w.sa.post('/api/v1/admin/users', {
      name: 'Two',
      email: 'two@test.local',
      password: PASSWORD,
      branchIds: [w.branchA1, w.branchA2],
    });
    expect(two.status).toBe(400);
    expect(two.body.error.message).toMatch(/only one branch/);
    const users = ok<{ id: string; email: string }[]>(await w.sa.get('/api/v1/admin/users'));
    const a1 = users.find((u) => u.email === 'a1@test.local')!;
    expect((await w.sa.patch(`/api/v1/admin/users/${a1.id}`, { branchIds: [w.branchA1, w.branchB1] })).status).toBe(400);
    expect((await w.sa.patch(`/api/v1/admin/users/${a1.id}`, { branchIds: [] })).status).toBe(400);
  });

  it('rejects duplicate emails and unknown branches', async () => {
    const dup = await w.sa.post('/api/v1/admin/users', { name: 'D', email: 'a1@test.local', password: PASSWORD, branchIds: [w.branchA1] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('An employee with this email already exists.');
    // Capitals and spaces do not make it a different email; any role (here a waiter) is refused.
    const upper = await w.sa.post('/api/v1/admin/users', { name: 'D', email: '  A1@Test.Local ', password: PASSWORD, branchIds: [w.branchA1], role: 'WAITER' });
    expect(upper.status).toBe(409);
    expect(upper.body.error.message).toBe('An employee with this email already exists.');
    expect(
      (await w.sa.post('/api/v1/admin/users', { name: 'D', email: 'd@test.local', password: PASSWORD, branchIds: ['0123456789abcdef01234567'] })).status,
    ).toBe(400);
  });

  it('enforces the password policy', async () => {
    const res = await w.sa.post('/api/v1/admin/users', { name: 'W', email: 'weak@test.local', password: 'short', branchIds: [w.branchA1] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('deletes a login for good: signed out at once, email free again, others untouched', async () => {
    const u = ok<{ id: string }>(
      await w.sa.post('/api/v1/admin/users', { name: 'Leaving', email: 'leaving@test.local', password: PASSWORD, branchIds: [w.branchA1] }),
      201,
    );
    const ra = (await new Client().login('leaving@test.local')).useBranch(w.branchA1);
    ok(await ra.get('/api/v1/bills/counter'));

    // Restaurant Admins cannot delete logins.
    expect((await w.adminA1.delete(`/api/v1/admin/users/${u.id}`)).status).toBe(403);
    ok(await w.sa.delete(`/api/v1/admin/users/${u.id}`));

    expect((await ra.get('/api/v1/tables')).status).toBe(401);
    expect((await new Client().post('/api/v1/auth/login', { email: 'leaving@test.local', password: PASSWORD })).status).toBe(401);
    expect(ok<{ email: string }[]>(await w.sa.get('/api/v1/admin/users')).map((x) => x.email)).not.toContain('leaving@test.local');
    expect(await AuditLogModel.exists({ action: 'RESTAURANT_ADMIN_DELETED', entityId: u.id })).toBeTruthy();
    expect((await w.sa.delete(`/api/v1/admin/users/${u.id}`)).status).toBe(404);
    expect((await w.adminA1.get('/api/v1/tables')).status).toBe(200);
    // The email can be used for a new login.
    ok(await w.sa.post('/api/v1/admin/users', { name: 'Back', email: 'leaving@test.local', password: PASSWORD, branchIds: [w.branchA1] }), 201);
  });

  it('writes audit logs for administrative actions', async () => {
    expect(await AuditLogModel.countDocuments({ action: 'RESTAURANT_CREATED' })).toBe(5); // A, B, C, Keda Kari and the deleted one
    expect(await AuditLogModel.countDocuments({ action: 'RESTAURANT_ADMIN_REASSIGNED' })).toBe(1);
    const logs = ok<unknown[]>(await w.sa.get('/api/v1/admin/audit-logs?limit=5'));
    expect(logs).toHaveLength(5);
  });
});

describe('Restaurant Admin cannot use Super Admin APIs', () => {
  it.each([
    ['get', '/api/v1/admin/restaurants'],
    ['post', '/api/v1/admin/restaurants'],
    ['post', '/api/v1/admin/branches'],
    ['post', '/api/v1/admin/users'],
    ['get', '/api/v1/admin/users'],
    ['get', '/api/v1/admin/analytics/overview?from=2026-01-01&to=2026-01-31'],
    ['get', '/api/v1/admin/reports/sales.csv?from=2026-01-01&to=2026-01-31'],
    ['get', '/api/v1/admin/audit-logs'],
  ] as const)('%s %s → 403', async (method, url) => {
    const res =
      method === 'get'
        ? await w.adminA1.get(url)
        : await w.adminA1.post(url, { name: 'X', restaurantId: w.restaurantA, code: 'X', email: 'x@x.io', password: PASSWORD, branchIds: [w.branchA1] });
    expect(res.status).toBe(403);
  });
});
