import { beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, ok, useTestDatabase, type World } from './helpers.js';

useTestDatabase();

interface Item {
  id: string;
  name: string;
  taxable: boolean;
  taxRateBps: number | null;
}
interface Cat {
  id: string;
  taxRateBps: number | null;
}

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

const gstOf = async (c: World['adminA1'], id: string) => ok<Item[]>(await c.get('/api/v1/menu/items')).find((i) => i.id === id)!.taxRateBps;

describe('one GST for a whole category', () => {
  let cat: Cat;
  let lassi: string;
  let soda: string;

  it('gives every dish in the category the GST when it is set', async () => {
    cat = ok<Cat>(await w.adminA1.post('/api/v1/menu/categories', { name: 'Drinks' }), 201);
    expect(cat.taxRateBps).toBeNull();
    lassi = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: cat.id, name: 'Lassi', price: 4000, taxRateBps: 500 }), 201).id;
    soda = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: cat.id, name: 'Soda', price: 2000, taxRateBps: 0, taxable: false }), 201).id;

    cat = ok<Cat>(await w.adminA1.patch(`/api/v1/menu/categories/${cat.id}`, { taxRateBps: 1200 }));
    expect(cat.taxRateBps).toBe(1200);
    expect([await gstOf(w.adminA1, lassi), await gstOf(w.adminA1, soda)]).toEqual([1200, 1200]);
    // Taxed again, now that it has a GST %.
    expect(ok<Item[]>(await w.adminA1.get('/api/v1/menu/items')).find((i) => i.id === soda)!.taxable).toBe(true);
  });

  it('one dish can still have its own GST; renaming the category keeps it', async () => {
    ok(await w.adminA1.patch(`/api/v1/menu/items/${lassi}`, { taxRateBps: 1800 }));
    ok(await w.adminA1.patch(`/api/v1/menu/categories/${cat.id}`, { name: 'Cool Drinks', taxRateBps: 1200 }));
    expect([await gstOf(w.adminA1, lassi), await gstOf(w.adminA1, soda)]).toEqual([1800, 1200]);
  });

  it('a new dish in the category starts with its GST unless it is given one', async () => {
    const tea = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: cat.id, name: 'Tea', price: 1500 }), 201);
    expect(tea.taxRateBps).toBe(1200);
    const water = ok<Item>(await w.adminA1.post('/api/v1/menu/items', { categoryId: cat.id, name: 'Water', price: 1000, taxRateBps: 0 }), 201);
    expect(water.taxRateBps).toBe(0);
  });

  it('changing it again gives every dish the new GST; "No GST" works too', async () => {
    ok(await w.adminA1.patch(`/api/v1/menu/categories/${cat.id}`, { taxRateBps: 0 }));
    const items = ok<Item[]>(await w.adminA1.get('/api/v1/menu/items')).filter((i) => [lassi, soda].includes(i.id));
    expect(items.map((i) => [i.taxRateBps, i.taxable])).toEqual([
      [0, false],
      [0, false],
    ]);
  });

  it('a shared category set in one branch changes that branch only', async () => {
    const main = ok<Cat[]>(await w.adminA1.get('/api/v1/menu/categories')).find((c) => c.id === w.categoryId)!;
    expect(main.taxRateBps).toBeNull();
    ok(await w.adminA1.patch(`/api/v1/menu/categories/${w.categoryId}`, { taxRateBps: 500 }));
    expect(ok<Cat[]>(await w.adminA1.get('/api/v1/menu/categories')).find((c) => c.id === w.categoryId)!.taxRateBps).toBe(500);
    expect(ok<Cat[]>(await w.adminA2.get('/api/v1/menu/categories')).find((c) => c.id === w.categoryId)!.taxRateBps).toBeNull();
    expect(await gstOf(w.adminA1, w.items.idly)).toBe(500);
    expect(await gstOf(w.adminA2, w.items.idly)).toBeNull();
  });

  it('rejects a GST over 100%', async () => {
    expect((await w.adminA1.patch(`/api/v1/menu/categories/${cat.id}`, { taxRateBps: 10_001 })).status).toBe(400);
  });
});
