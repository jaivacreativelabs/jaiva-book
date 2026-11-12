import { beforeAll, describe, expect, it } from 'vitest';
import { MenuItemModel } from '../src/models/index.js';
import { buildWorld, ok, useTestDatabase, type World } from './helpers.js';

useTestDatabase();

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

interface Item {
  id: string;
  name: string;
  price: number;
  basePrice: number;
  isAvailable: boolean;
  isShared: boolean;
  editable: boolean;
  imageUrl: string | null;
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

describe('categories', () => {
  it('Restaurant Admin creates branch categories and sees shared ones', async () => {
    const c = ok<{ branchId: string; editable: boolean }>(await w.adminA1.post('/api/v1/menu/categories', { name: 'Specials' }), 201);
    expect(c.branchId).toBe(w.branchA1);
    expect(c.editable).toBe(true);
    const list = ok<{ name: string; editable: boolean }[]>(await w.adminA1.get('/api/v1/menu/categories'));
    expect(list.map((x) => x.name)).toEqual(expect.arrayContaining(['Main', 'Specials']));
    // A branch can manage a shared category too (for itself only); it stays marked as shared.
    expect(list.find((x) => x.name === 'Main')).toMatchObject({ editable: true, isShared: true });
    // Another branch does not see A1's category.
    const a2 = ok<{ name: string }[]>(await w.adminA2.get('/api/v1/menu/categories'));
    expect(a2.map((x) => x.name)).not.toContain('Specials');
  });

  it('rejects duplicates in the same scope and against shared names', async () => {
    const dup = await w.adminA1.post('/api/v1/menu/categories', { name: 'specials' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('Category already exists.');
    expect((await w.adminA1.post('/api/v1/menu/categories', { name: 'MAIN' })).status).toBe(409);
    // The Super Admin's main-menu (global) category: same message.
    const global = await w.sa.post(`/api/v1/menu/categories?restaurantId=${w.restaurantA}`, { name: '  main ' });
    expect(global.status).toBe(409);
    expect(global.body.error.message).toBe('Category already exists.');
    // A different branch may reuse a branch-only name.
    expect((await w.adminA2.post('/api/v1/menu/categories', { name: 'Specials' })).status).toBe(201);
  });

  it('renames and hides a shared category for one branch only', async () => {
    const names = async (c: typeof w.adminA1) => ok<{ name: string; status: string }[]>(await c.get('/api/v1/menu/categories?includeInactive=true'));
    const main = ok<{ id: string; name: string }[]>(await w.adminA1.get('/api/v1/menu/categories')).find((x) => x.name === 'Main')!;
    ok(await w.adminA1.patch(`/api/v1/menu/categories/${main.id}`, { name: 'Meals', icon: '🍛' }));
    ok(await w.adminA1.patch(`/api/v1/menu/categories/${main.id}/status`, { status: 'INACTIVE' }));
    expect((await names(w.adminA1)).find((x) => x.name === 'Meals')?.status).toBe('INACTIVE');
    expect((await names(w.adminA2)).find((x) => x.name === 'Main')?.status).toBe('ACTIVE'); // other branch untouched
    // A name another category already has is refused.
    expect((await w.adminA1.patch(`/api/v1/menu/categories/${main.id}`, { name: 'Specials' })).status).toBe(409);
    // Back to normal for the tests below.
    ok(await w.adminA1.patch(`/api/v1/menu/categories/${main.id}`, { name: 'Main' }));
    ok(await w.adminA1.patch(`/api/v1/menu/categories/${main.id}/status`, { status: 'ACTIVE' }));
  });

  it('deactivates and reorders own categories', async () => {
    const extra = ok<{ id: string }>(await w.adminA1.post('/api/v1/menu/categories', { name: 'Drinks' }), 201);
    const list = ok<{ id: string; editable: boolean }[]>(await w.adminA1.get('/api/v1/menu/categories'));
    const own = list.filter((c) => c.editable).map((c) => c.id).reverse();
    ok(await w.adminA1.post('/api/v1/menu/categories/reorder', { ids: own }));
    ok(await w.adminA1.patch(`/api/v1/menu/categories/${extra.id}/status`, { status: 'INACTIVE' }));
    const active = ok<{ id: string }[]>(await w.adminA1.get('/api/v1/menu/categories'));
    expect(active.map((c) => c.id)).not.toContain(extra.id);
    const all = ok<{ id: string }[]>(await w.adminA1.get('/api/v1/menu/categories?includeInactive=true'));
    expect(all.map((c) => c.id)).toContain(extra.id);
  });
});

describe('menu items', () => {
  it('validates required fields and prices', async () => {
    expect((await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: '', price: 100 })).status).toBe(400);
    expect((await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Neg', price: -1 })).status).toBe(400);
    expect((await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Frac', price: 10.5 })).status).toBe(400);
    expect((await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'NoPrice' })).status).toBe(400);
  });

  it('creates a branch item without an image and edits it', async () => {
    const item = ok<Item>(
      await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Rava Dosa', price: 6000, description: 'Crispy' }),
      201,
    );
    expect(item.imageUrl).toBeNull();
    expect(item.editable).toBe(true);
    const edited = ok<Item>(await w.adminA1.patch(`/api/v1/menu/items/${item.id}`, { name: 'Rava Masala Dosa', price: 6500 }));
    expect(edited.name).toBe('Rava Masala Dosa');
    expect(edited.price).toBe(6500);
    // Not visible to another branch.
    const a2 = ok<Item[]>(await w.adminA2.get('/api/v1/menu/items'));
    expect(a2.map((i) => i.name)).not.toContain('Rava Masala Dosa');
  });

  it('renames, describes and removes a shared item for one branch only', async () => {
    const cat = ok<{ id: string }>(await w.adminA1.post('/api/v1/menu/categories', { name: 'Tiffin' }), 201);
    const o = ok<Item & { description: string; categoryId: string }>(
      await w.adminA1.patch(`/api/v1/menu/items/${w.items.idly}`, { name: 'Mini Idly', description: 'Soft', categoryId: cat.id }),
    );
    expect(o).toMatchObject({ name: 'Mini Idly', description: 'Soft', categoryId: cat.id, editable: true, isShared: true });
    // The other branch and the main menu keep the dish as it was.
    const a2 = ok<Item[]>(await w.adminA2.get('/api/v1/menu/items'));
    expect(a2.find((i) => i.id === w.items.idly)?.name).toBe('Idly');
    const main = ok<Item[]>(await w.sa.get(`/api/v1/menu/items?restaurantId=${w.restaurantA}`));
    expect(main.find((i) => i.id === w.items.idly)?.name).toBe('Idly');
    // A name another dish of this branch already has is refused.
    expect((await w.adminA1.patch(`/api/v1/menu/items/${w.items.idly}`, { name: 'Vada' })).status).toBe(409);
    // Bills use the branch's name.
    const bill = ok<{ id: string; version: number }>(await w.adminA1.get('/api/v1/bills/counter'));
    const saved = ok<{ items: { name: string }[] }>(
      await w.adminA1.put(`/api/v1/bills/${bill.id}`, { version: bill.version, items: [{ menuItemId: w.items.idly, quantity: 1 }] }),
    );
    expect(saved.items[0].name).toBe('Mini Idly');
    ok(await w.adminA1.put(`/api/v1/bills/${bill.id}`, { version: bill.version + 1, items: [] }));

    // Removing it hides it in this branch only; restoring brings it back.
    ok(await w.adminA1.post(`/api/v1/menu/items/${w.items.idly}/archive`));
    expect(ok<Item[]>(await w.adminA1.get('/api/v1/menu/items')).map((i) => i.id)).not.toContain(w.items.idly);
    expect(ok<Item[]>(await w.adminA2.get('/api/v1/menu/items')).map((i) => i.id)).toContain(w.items.idly);
    ok(await w.adminA1.post(`/api/v1/menu/items/${w.items.idly}/restore`));
    // Back to the main menu's name and category for the tests below.
    ok(await w.adminA1.patch(`/api/v1/menu/items/${w.items.idly}`, { name: 'Idly', description: '', categoryId: w.categoryId }));
    expect(ok<Item[]>(await w.adminA1.get('/api/v1/menu/items')).find((i) => i.id === w.items.idly)?.name).toBe('Idly');
  });

  it('turns branch edits of shared items into overrides', async () => {
    const o = ok<Item>(await w.adminA1.patch(`/api/v1/menu/items/${w.items.idly}`, { price: 3300 }));
    expect(o.price).toBe(3300);
    expect(o.basePrice).toBe(3000);
    // Branch A2 still sees the shared price.
    const a2 = ok<Item[]>(await w.adminA2.get('/api/v1/menu/items'));
    expect(a2.find((i) => i.id === w.items.idly)?.price).toBe(3000);
    const reset = ok<Item>(await w.adminA1.delete(`/api/v1/menu/items/${w.items.idly}/override`));
    expect(reset.price).toBe(3000);
  });

  it('updates availability per branch', async () => {
    const off = ok<Item>(await w.adminA1.patch(`/api/v1/menu/items/${w.items.vada}/availability`, { isAvailable: false }));
    expect(off.isAvailable).toBe(false);
    const a2 = ok<Item[]>(await w.adminA2.get('/api/v1/menu/items'));
    expect(a2.find((i) => i.id === w.items.vada)?.isAvailable).toBe(true);
    ok(await w.adminA1.patch(`/api/v1/menu/items/${w.items.vada}/availability`, { isAvailable: true }));
  });

  it('pins a dish to the top for one branch only', async () => {
    const before = ok<(Item & { pinned: boolean })[]>(await w.adminA1.get('/api/v1/menu/items'));
    const last = before[before.length - 1];
    expect(last.pinned).toBe(false);
    const pinned = ok<Item & { pinned: boolean }>(await w.adminA1.patch(`/api/v1/menu/items/${last.id}/pin`, { pinned: true }));
    expect(pinned.pinned).toBe(true);
    const after = ok<(Item & { pinned: boolean })[]>(await w.adminA1.get('/api/v1/menu/items'));
    expect(after[0].id).toBe(last.id);
    // Branch A2 keeps its own order.
    const a2 = ok<(Item & { pinned: boolean })[]>(await w.adminA2.get('/api/v1/menu/items'));
    expect(a2.find((i) => i.id === last.id)?.pinned ?? false).toBe(false);
    // Pinning needs a branch (the restaurant-wide menu has none).
    expect((await w.sa.patch(`/api/v1/menu/items/${w.items.idly}/pin?restaurantId=${w.restaurantA}`, { pinned: true })).status).toBe(400);
    ok(await w.adminA1.patch(`/api/v1/menu/items/${last.id}/pin`, { pinned: false }));
  });

  it('archives instead of deleting', async () => {
    const item = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Temp', price: 100 }), 201);
    ok(await w.adminA1.post(`/api/v1/menu/items/${item.id}/archive`));
    const list = ok<Item[]>(await w.adminA1.get('/api/v1/menu/items'));
    expect(list.map((i) => i.id)).not.toContain(item.id);
    const all = ok<Item[]>(await w.adminA1.get('/api/v1/menu/items?includeArchived=true'));
    expect(all.map((i) => i.id)).toContain(item.id);
  });

  it('a removed dish (and its variants) does not block adding it again', async () => {
    const q = `?restaurantId=${w.restaurantA}`;
    const old = ok<Item>(await w.sa.post(`/api/v1/menu/items${q}`, { categoryId: w.categoryId, name: 'Pongal', price: 5000 }), 201);
    ok(await w.sa.put(`/api/v1/menu/items/${old.id}/variants${q}`, { variants: [{ name: 'Half', price: 3000 }, { name: 'Full', price: 5000 }] }));
    ok(await w.sa.post(`/api/v1/menu/items/${old.id}/archive${q}`));
    // The main menu adds a new Pongal with the same variants.
    const again = ok<Item>(await w.sa.post(`/api/v1/menu/items${q}`, { categoryId: w.categoryId, name: 'pongal', price: 5000 }), 201);
    ok(await w.sa.put(`/api/v1/menu/items/${again.id}/variants${q}`, { variants: [{ name: 'Half', price: 3000 }, { name: 'Full', price: 5000 }] }));
    // The old one cannot come back while the name is taken.
    expect((await w.sa.post(`/api/v1/menu/items/${old.id}/restore${q}`)).status).toBe(409);
    // A branch's own dish, removed and added again.
    const own = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Rava Dosa', price: 6000 }), 201);
    ok(await w.adminA1.post(`/api/v1/menu/items/${own.id}/archive`));
    ok(await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Rava Dosa', price: 6500 }), 201);
  });

  it('frees the name of a dish removed before names were freed on removal', async () => {
    const old = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Upma', price: 4000 }), 201);
    await MenuItemModel.updateOne({ _id: old.id }, { $set: { status: 'ARCHIVED' } }); // the name key stays "upma"
    ok(await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Upma', price: 4500 }), 201);
  });

  it('Super Admin manages the shared menu, visible in every branch', async () => {
    const item = ok<Item>(
      await w.sa.post(`/api/v1/menu/items?restaurantId=${w.restaurantA}`, { categoryId: w.categoryId, name: 'Kesari', price: 4000 }),
      201,
    );
    expect(item.isShared).toBe(false); // in restaurant scope it is "own"
    const a2 = ok<Item[]>(await w.adminA2.get('/api/v1/menu/items'));
    expect(a2.find((i) => i.id === item.id)?.isShared).toBe(true);
    // Restaurant B never sees it.
    const b = ok<Item[]>(await w.adminB1.get('/api/v1/menu/items'));
    expect(b.map((i) => i.id)).not.toContain(item.id);
  });
});

describe('deleting a category', () => {
  const names = async (c: typeof w.adminA1) => ok<{ name: string }[]>(await c.get('/api/v1/menu/categories?includeInactive=true')).map((x) => x.name);

  it('deletes a branch’s own empty category for good, and frees its name', async () => {
    const c = ok<{ id: string }>(await w.adminA1.post('/api/v1/menu/categories', { name: 'Old Offers' }), 201);
    ok(await w.adminA1.delete(`/api/v1/menu/categories/${c.id}`));
    expect(await names(w.adminA1)).not.toContain('Old Offers');
    ok(await w.adminA1.post('/api/v1/menu/categories', { name: 'Old Offers' }), 201);
  });

  it('refuses while dishes are in it', async () => {
    const res = await w.adminA1.delete(`/api/v1/menu/categories/${w.categoryId}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_IN_USE');
    expect((await w.sa.delete(`/api/v1/menu/categories/${w.categoryId}?restaurantId=${w.restaurantA}`)).status).toBe(409);
  });

  it('a shared category deleted in a branch leaves that branch only', async () => {
    const shared = ok<{ id: string }>(await w.sa.post(`/api/v1/menu/categories?restaurantId=${w.restaurantA}`, { name: 'Sweets' }), 201);
    ok(await w.adminA1.delete(`/api/v1/menu/categories/${shared.id}`));
    expect(await names(w.adminA1)).not.toContain('Sweets');
    expect(await names(w.adminA2)).toContain('Sweets');
    // Gone for A1: it cannot be edited there, and A1 may make its own "Sweets".
    expect((await w.adminA1.patch(`/api/v1/menu/categories/${shared.id}`, { name: 'Desserts' })).status).toBe(404);
    ok(await w.adminA1.post('/api/v1/menu/categories', { name: 'Sweets' }), 201);
  });
});

describe('dragging dishes into a new order', () => {
  type Dish = Item & { pinned: boolean; parentId: string | null };
  const dishIds = async (c: typeof w.adminA1, q = '') =>
    ok<Dish[]>(await c.get(`/api/v1/menu/items${q}`))
      .filter((i) => !i.parentId && !i.pinned)
      .map((i) => i.id);

  it('a branch orders shared and its own dishes for itself only', async () => {
    const before = await dishIds(w.adminA1);
    const reversed = [...before].reverse();
    ok(await w.adminA1.post('/api/v1/menu/items/reorder', { ids: reversed }));
    expect(await dishIds(w.adminA1)).toEqual(reversed);
    // Branch A2 keeps the main menu's order for the shared dishes.
    const a2 = await dishIds(w.adminA2);
    const shared = before.filter((id) => a2.includes(id));
    expect(a2.filter((id) => shared.includes(id))).toEqual(shared);
    // A new dish goes to the end.
    const added = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Kara Bath', price: 4000 }), 201);
    expect((await dishIds(w.adminA1)).at(-1)).toBe(added.id);
  });

  it('refuses dishes of another branch or restaurant', async () => {
    const bCat = ok<{ id: string }>(await w.adminB1.post('/api/v1/menu/categories', { name: 'B dishes' }), 201);
    const bDish = ok<Item>(await w.adminB1.post('/api/v1/menu/items', { categoryId: bCat.id, name: 'B Dosa', price: 5000 }), 201);
    const a2Dish = ok<Item>(await w.adminA2.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'A2 Special', price: 5000 }), 201);
    expect((await w.adminA1.post('/api/v1/menu/items/reorder', { ids: [w.items.idly, bDish.id] })).status).toBe(403);
    expect((await w.adminA1.post('/api/v1/menu/items/reorder', { ids: [w.items.idly, a2Dish.id] })).status).toBe(403);
    expect((await w.adminA1.post('/api/v1/menu/items/reorder', { ids: [w.items.idly, w.items.idly] })).status).toBe(400);
  });

  it('the Super Admin orders the main menu', async () => {
    const q = `?restaurantId=${w.restaurantA}`;
    const main = await dishIds(w.sa, q);
    const moved = [main[main.length - 1], ...main.slice(0, -1)];
    ok(await w.sa.post(`/api/v1/menu/items/reorder${q}`, { ids: moved }));
    expect(await dishIds(w.sa, q)).toEqual(moved);
  });
});

describe('images', () => {
  it('accepts a real PNG and serves it', async () => {
    const item = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Pic', price: 100 }), 201);
    const res = await w.adminA1.agent
      .post(`/api/v1/menu/items/${item.id}/image`)
      .set('X-Requested-With', 'rb-client')
      .set('X-Branch-Id', w.branchA1)
      .attach('image', PNG, { filename: 'pic.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.data.imageUrl).toMatch(/^\/uploads\/menu\/[0-9a-f-]+\.png$/);
    const served = await w.adminA1.agent.get(res.body.data.imageUrl);
    expect(served.status).toBe(200);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
  });

  it('lets a branch use its own photo for a shared item without changing other branches', async () => {
    const res = await w.adminA1.agent
      .post(`/api/v1/menu/items/${w.items.dosa}/image`)
      .set('X-Requested-With', 'rb-client')
      .set('X-Branch-Id', w.branchA1)
      .attach('image', PNG, { filename: 'dosa.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ imageOverridden: true, isShared: true });
    expect(res.body.data.imageUrl).toMatch(/^\/uploads\/menu\//);
    // The other branch and the main menu are untouched.
    const a2 = ok<(Item & { imageOverridden: boolean })[]>(await w.adminA2.get('/api/v1/menu/items'));
    expect(a2.find((i) => i.id === w.items.dosa)?.imageUrl).toBeNull();
    const main = ok<Item[]>(await w.sa.get(`/api/v1/menu/items?restaurantId=${w.restaurantA}`));
    expect(main.find((i) => i.id === w.items.dosa)?.imageUrl).toBeNull();
    // Resetting the branch price keeps the branch photo; removing the photo restores the main one.
    ok(await w.adminA1.patch(`/api/v1/menu/items/${w.items.dosa}`, { price: 5500 }));
    const reset = ok<Item & { imageOverridden: boolean }>(await w.adminA1.delete(`/api/v1/menu/items/${w.items.dosa}/override`));
    expect(reset).toMatchObject({ price: 5000, imageOverridden: true });
    const removed = ok<Item & { imageOverridden: boolean }>(await w.adminA1.delete(`/api/v1/menu/items/${w.items.dosa}/image`));
    expect(removed).toMatchObject({ imageUrl: null, imageOverridden: false });
  });

  it('rejects files that are not really images', async () => {
    const item = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Fake', price: 100 }), 201);
    const res = await w.adminA1.agent
      .post(`/api/v1/menu/items/${item.id}/image`)
      .set('X-Requested-With', 'rb-client')
      .set('X-Branch-Id', w.branchA1)
      .attach('image', Buffer.from('<svg onload="alert(1)"></svg>'), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMAGE');
  });

  it('rejects oversized uploads', async () => {
    const item = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Huge', price: 100 }), 201);
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    const res = await w.adminA1.agent
      .post(`/api/v1/menu/items/${item.id}/image`)
      .set('X-Requested-With', 'rb-client')
      .set('X-Branch-Id', w.branchA1)
      .attach('image', big, { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
  });
});
