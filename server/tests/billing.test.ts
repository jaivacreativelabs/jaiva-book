import { beforeAll, describe, expect, it } from 'vitest';
import { DraftModel, TransactionModel } from '../src/models/index.js';
import { buildWorld, key, ok, useTestDatabase, type World } from './helpers.js';

useTestDatabase();

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

interface Draft {
  id: string;
  version: number;
  status: string;
  items: { menuItemId: string; name: string; unitPrice: number; quantity: number }[];
  totals: { subtotal: number; taxTotal: number; grandTotal: number; discountAmount: number };
}
interface Tx {
  id: string;
  billNumber: string;
  grandTotal: number;
  subtotal: number;
  taxTotal: number;
  items: { name: string; unitPrice: number; quantity: number; lineTotal: number }[];
  paymentMethod: string;
  status: string;
}

async function freshCounter(): Promise<Draft> {
  return ok<Draft>(await w.adminA1.get('/api/v1/bills/counter'));
}

describe('counter (New Bill) drafts', () => {
  it('returns the same persisted counter draft on every call', async () => {
    const a = await freshCounter();
    const b = await freshCounter();
    expect(a.id).toBe(b.id);
    expect(a.items).toEqual([]);
  });

  it('adds items, changes quantities and removes items with server-side pricing', async () => {
    let d = await freshCounter();
    d = ok<Draft>(
      await w.adminA1.put(`/api/v1/bills/${d.id}`, {
        version: d.version,
        items: [
          { menuItemId: w.items.idly, quantity: 2 },
          { menuItemId: w.items.dosa, quantity: 1 },
        ],
        customerName: 'Ravi',
      }),
    );
    expect(d.items.map((i) => [i.name, i.unitPrice, i.quantity])).toEqual([
      ['Idly', 3000, 2],
      ['Dosa', 5000, 1],
    ]);
    expect(d.totals.grandTotal).toBe(11000);

    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.idly, quantity: 3 }] }));
    expect(d.items).toHaveLength(1);
    expect(d.totals.grandTotal).toBe(9000);
  });

  it('ignores any price or total the client tries to send', async () => {
    const d = await freshCounter();
    const res = await w.adminA1.put(`/api/v1/bills/${d.id}`, {
      version: d.version,
      items: [{ menuItemId: w.items.idly, quantity: 1, unitPrice: 1 }],
    });
    expect(res.status).toBe(400); // unknown field rejected
    const res2 = await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [], grandTotal: 1 });
    expect(res2.status).toBe(400);
  });

  it('rejects stale versions with 409 and the current draft', async () => {
    const d = await freshCounter();
    const res = await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version - 1, items: [] });
    expect(res.status).toBe(409);
    expect(res.body.error.details.current.version).toBe(d.version);
  });

  it('prevents adding unavailable items', async () => {
    ok(await w.adminA1.patch(`/api/v1/menu/items/${w.items.vada}/availability`, { isAvailable: false }));
    const d = await freshCounter();
    const res = await w.adminA1.put(`/api/v1/bills/${d.id}`, {
      version: d.version,
      items: [...d.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })), { menuItemId: w.items.vada, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
    ok(await w.adminA1.patch(`/api/v1/menu/items/${w.items.vada}/availability`, { isAvailable: true }));
  });

  it('applies restaurant tax settings and discounts on the server', async () => {
    ok(
      await w.sa.patch(`/api/v1/admin/restaurants/${w.restaurantA}/settings`, {
        taxes: [
          { name: 'CGST', rateBps: 250 },
          { name: 'SGST', rateBps: 250 },
        ],
        pricesIncludeTax: false,
        receiptFooter: 'Thanks',
      }),
    );
    const d = await freshCounter();
    const updated = ok<Draft>(
      await w.adminA1.put(`/api/v1/bills/${d.id}`, {
        version: d.version,
        items: [{ menuItemId: w.items.biryani, quantity: 1 }],
        discount: { type: 'PERCENT', value: 1000 },
      }),
    );
    expect(updated.totals.subtotal).toBe(8000);
    expect(updated.totals.discountAmount).toBe(800);
    expect(updated.totals.taxTotal).toBe(360);
    expect(updated.totals.grandTotal).toBe(7560);
  });
});

describe('finalising bills', () => {
  it('creates a transaction with snapshots and closes the draft', async () => {
    const d = await freshCounter();
    const res = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'UPI', idempotencyKey: key() });
    expect(res.status).toBe(201);
    const tx = res.body.data.transaction as Tx;
    expect(tx.billNumber).toBe('A1-0001'); // branch code A1 (ends in a digit → dash)
    expect(tx.grandTotal).toBe(7560);
    expect(tx.items[0]).toMatchObject({ name: 'Biryani', unitPrice: 8000, quantity: 1, lineTotal: 8000 });
    const draft = await DraftModel.findById(d.id).lean();
    expect(draft?.status).toBe('FINALIZED');
    // A new counter draft is opened for the next customer.
    const next = await freshCounter();
    expect(next.id).not.toBe(d.id);
    expect(next.items).toEqual([]);
  });

  it('New Bill is always Take Away, even when an older app says Dine In', async () => {
    const bill = async (orderType?: string) => {
      let d = await freshCounter();
      d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.idly, quantity: 1 }] }));
      return w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', orderType, idempotencyKey: key() });
    };
    expect((await bill('DINE_IN')).body.data.transaction.orderType).toBe('TAKEAWAY');
    expect((await bill('TAKEAWAY')).body.data.transaction.orderType).toBe('TAKEAWAY');
    expect((await bill('PARCEL')).status).toBe(400);
    expect((await bill()).body.data.transaction.orderType).toBe('TAKEAWAY'); // also closes the PARCEL try's bill
  });

  it('rejects an empty bill', async () => {
    const d = await freshCounter();
    const res = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', idempotencyKey: key() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMPTY_BILL');
  });

  it('is idempotent for repeated clicks with the same key', async () => {
    let d = await freshCounter();
    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.coffee, quantity: 2 }] }));
    const k = key();
    const first = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', idempotencyKey: k });
    const second = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', idempotencyKey: k });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.transaction.id).toBe(first.body.data.transaction.id);
    expect(await TransactionModel.countDocuments({ sourceDraftId: d.id })).toBe(1);
  });

  it('creates exactly one transaction under concurrent finalise calls', async () => {
    let d = await freshCounter();
    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.dosa, quantity: 1 }] }));
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CARD', idempotencyKey: key() }),
      ),
    );
    const okResults = results.filter((r) => r.status === 200 || r.status === 201);
    expect(okResults.length).toBeGreaterThanOrEqual(1);
    expect(new Set(okResults.map((r) => r.body.data.transaction.id)).size).toBe(1);
    for (const r of results) expect([200, 201, 409]).toContain(r.status);
    expect(await TransactionModel.countDocuments({ sourceDraftId: d.id })).toBe(1);
  });

  it('keeps historical prices after the menu price changes', async () => {
    let d = await freshCounter();
    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.juice, quantity: 1 }] }));
    const tx = (await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', idempotencyKey: key() })).body
      .data.transaction as Tx;
    ok(await w.sa.patch(`/api/v1/menu/items/${w.items.juice}?restaurantId=${w.restaurantA}`, { price: 9900, name: 'Juice Deluxe' }));
    const again = ok<Tx>(await w.adminA1.get(`/api/v1/transactions/${tx.id}`));
    expect(again.items[0]).toMatchObject({ name: 'Fresh Juice', unitPrice: 5000 });
    expect(again.grandTotal).toBe(tx.grandTotal);
  });

  it('refuses to finalise a draft containing an item that became unavailable', async () => {
    let d = await freshCounter();
    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.vada, quantity: 1 }] }));
    ok(await w.adminA1.patch(`/api/v1/menu/items/${w.items.vada}/availability`, { isAvailable: false }));
    const res = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', idempotencyKey: key() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
    // Lowering the quantity / removing it is still allowed.
    ok(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [] }));
    ok(await w.adminA1.patch(`/api/v1/menu/items/${w.items.vada}/availability`, { isAvailable: true }));
  });

  it('blocks rewriting completed transactions at the model level', async () => {
    const tx = await TransactionModel.findOne();
    await expect(TransactionModel.updateOne({ _id: tx!._id }, { $set: { grandTotal: 1 } })).rejects.toThrow(/immutable/);
    await expect(TransactionModel.deleteOne({ _id: tx!._id })).rejects.toThrow(/cannot be deleted/);
  });
});

describe('bill number series', () => {
  it('numbers bills by branch code and starts a new series when the code changes', async () => {
    const bill = async () => {
      let d = ok<{ id: string; version: number }>(await w.adminA2.get('/api/v1/bills/counter'));
      d = ok(await w.adminA2.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.idly, quantity: 1 }] }));
      const res = await w.adminA2.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', idempotencyKey: key() });
      return (res.body.data.transaction as Tx).billNumber;
    };
    expect(await bill()).toBe('A2-0001'); // each branch has its own series
    ok(await w.sa.patch(`/api/v1/admin/branches/${w.branchA2}`, { code: 'ith' }));
    expect(await bill()).toBe('ITH0001');
    expect(await bill()).toBe('ITH0002');
  });
});

describe('GST per item', () => {
  it("bills an item's own GST % next to the restaurant's taxes", async () => {
    // Restaurant A has CGST + SGST 2.5 % from the tests above; Cola gets its own 18 %.
    const cola = ok<{ id: string; taxRateBps: number; taxable: boolean }>(
      await w.adminA1.post('/api/v1/menu/items', { categoryId: w.categoryId, name: 'Cola', price: 10000, taxRateBps: 1800 }),
      201,
    );
    expect([cola.taxRateBps, cola.taxable]).toEqual([1800, true]);

    let d = await freshCounter();
    d = ok<Draft>(
      await w.adminA1.put(`/api/v1/bills/${d.id}`, {
        version: d.version,
        items: [
          { menuItemId: w.items.idly, quantity: 1 },
          { menuItemId: cola.id, quantity: 1 },
        ],
        discount: null,
      }),
    );
    const taxes = (d.totals as unknown as { taxes: { name: string; rateBps: number; amount: number }[] }).taxes;
    expect(taxes).toEqual([
      // each line says what it was charged on: Idly ₹30, Cola ₹100
      { name: 'CGST', rateBps: 250, amount: 75, base: 3000 },
      { name: 'SGST', rateBps: 250, amount: 75, base: 3000 },
      { name: 'GST', rateBps: 1800, amount: 1800, base: 10000 },
    ]);
    expect(d.totals.grandTotal).toBe(13000 + 1950);

    const res = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', idempotencyKey: key() });
    const tx = res.body.data.transaction as { grandTotal: number; items: { name: string; taxRateBps: number | null }[] };
    expect(tx.grandTotal).toBe(14950);
    expect(tx.items.find((i) => i.name === 'Cola')?.taxRateBps).toBe(1800);

    // 0 % means no GST at all.
    const none = ok<{ taxRateBps: number; taxable: boolean }>(await w.adminA1.patch(`/api/v1/menu/items/${cola.id}`, { taxRateBps: 0 }));
    expect([none.taxRateBps, none.taxable]).toEqual([0, false]);
  });

  it('lets a branch set its own GST for a main-menu item', async () => {
    type Item = { id: string; taxRateBps: number | null };
    // Idly is on the main menu; branch A1 sets 12 %, branch A2 keeps the main-menu taxes.
    ok(await w.adminA1.patch(`/api/v1/menu/items/${w.items.idly}`, { taxRateBps: 1200 }));
    const inA1 = ok<Item[]>(await w.adminA1.get('/api/v1/menu/items')).find((i) => i.id === w.items.idly);
    const inA2 = ok<Item[]>(await w.adminA2.get('/api/v1/menu/items')).find((i) => i.id === w.items.idly);
    expect([inA1?.taxRateBps, inA2?.taxRateBps]).toEqual([1200, null]);

    let d = await freshCounter();
    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.idly, quantity: 1 }] }));
    const taxes = (d.totals as unknown as { taxes: { name: string; rateBps: number; amount: number }[] }).taxes;
    expect(taxes.filter((t) => t.amount > 0)).toEqual([
      { name: 'GST', rateBps: 1200, amount: 360, base: 3000 },
    ]);

    // Other taxes: Dosa (main menu) gets a service charge; a branch pin must not drop it.
    type Tax = { name: string; rateBps: number };
    ok(await w.sa.patch(`/api/v1/menu/items/${w.items.dosa}?restaurantId=${w.restaurantA}`, { extraTaxes: [{ name: 'Service charge', rateBps: 1000 }] }));
    ok(await w.adminA1.patch(`/api/v1/menu/items/${w.items.dosa}/pin`, { pinned: true }));
    const dosaA1 = ok<(Item & { extraTaxes: Tax[] })[]>(await w.adminA1.get('/api/v1/menu/items')).find((i) => i.id === w.items.dosa);
    expect(dosaA1?.extraTaxes).toEqual([{ name: 'Service charge', rateBps: 1000 }]);
    // Branch A2 sets its own: no service charge there.
    ok(await w.adminA2.patch(`/api/v1/menu/items/${w.items.dosa}`, { extraTaxes: [] }));
    const dosaA2 = ok<(Item & { extraTaxes: Tax[] })[]>(await w.adminA2.get('/api/v1/menu/items')).find((i) => i.id === w.items.dosa);
    expect(dosaA2?.extraTaxes).toEqual([]);

    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.dosa, quantity: 1 }] }));
    const dosaTaxes = (d.totals as unknown as { taxes: (Tax & { amount: number })[] }).taxes.filter((t) => t.amount > 0);
    expect(dosaTaxes.map((t) => [t.name, t.rateBps, t.amount])).toEqual([
      ['CGST', 250, 125],
      ['SGST', 250, 125],
      ['Service charge', 1000, 500],
    ]);
  });
});

describe('manual sale (New Bill › Add Sale)', () => {
  it('records just an amount as a numbered bill with one untaxed line', async () => {
    const k = key();
    const res = await w.adminA1.post('/api/v1/bills/manual-sale', { amount: 25000, paymentMethod: 'UPI', idempotencyKey: k });
    expect(res.status).toBe(201);
    const tx = res.body.data.transaction as Tx & { manual: boolean; editableUntil: string | null };
    expect(tx.billNumber).toMatch(/^A1-\d{4}$/);
    expect(tx.manual).toBe(true);
    expect(tx).toMatchObject({ subtotal: 25000, taxTotal: 0, grandTotal: 25000, paymentMethod: 'UPI', status: 'COMPLETED' });
    expect(tx.items).toEqual([expect.objectContaining({ name: 'Manual sale', unitPrice: 25000, quantity: 1, lineTotal: 25000 })]);
    expect(tx.editableUntil).toBeNull();

    // The same tap again returns the same sale.
    const again = await w.adminA1.post('/api/v1/bills/manual-sale', { amount: 25000, paymentMethod: 'UPI', idempotencyKey: k });
    expect(again.status).toBe(200);
    expect(again.body.data.transaction.id).toBe(tx.id);
    expect(await TransactionModel.countDocuments({ idempotencyKey: k })).toBe(1);

    // It cannot be edited into a dish bill.
    const edit = await w.adminA1.put(`/api/v1/transactions/${tx.id}`, { editCount: 0, items: [{ menuItemId: w.items.idly, quantity: 1 }], paymentMethod: 'CASH' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('MANUAL_SALE');
  });

  it('needs an amount of at least ₹1 and a payment mode', async () => {
    expect((await w.adminA1.post('/api/v1/bills/manual-sale', { amount: 0, paymentMethod: 'CASH', idempotencyKey: key() })).status).toBe(400);
    expect((await w.adminA1.post('/api/v1/bills/manual-sale', { amount: 5000, idempotencyKey: key() })).status).toBe(400);
  });
});

describe('split payment (part cash, part UPI)', () => {
  const fill = async () => {
    let d = await freshCounter();
    d = ok<Draft>(await w.adminA1.put(`/api/v1/bills/${d.id}`, { version: d.version, items: [{ menuItemId: w.items.dosa, quantity: 5 }] }));
    return d; // ₹250 (+ tax as configured)
  };

  it('stores each part; the main mode is the bigger part; the parts must add up to the bill', async () => {
    const d = await fill();
    const total = d.totals.grandTotal;
    const wrong = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, {
      version: d.version,
      paymentMethod: 'CASH',
      payments: [{ method: 'UPI', amount: 5000 }, { method: 'CASH', amount: 100 }],
      idempotencyKey: key(),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('SPLIT_MISMATCH');

    const res = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, {
      version: d.version,
      paymentMethod: 'UPI',
      payments: [{ method: 'UPI', amount: 5000 }, { method: 'CASH', amount: total - 5000 }],
      idempotencyKey: key(),
    });
    expect(res.status).toBe(201);
    const tx = res.body.data.transaction as Tx & { payments: { method: string; amount: number }[] };
    expect(tx.paymentMethod).toBe('CASH');
    expect(tx.payments).toEqual([{ method: 'UPI', amount: 5000 }, { method: 'CASH', amount: total - 5000 }]);

    // Listed under both modes.
    for (const mode of ['UPI', 'CASH']) {
      const list = ok<{ id: string }[]>(await w.adminA1.get(`/api/v1/transactions?paymentMethod=${mode}&limit=100`));
      expect(list.map((t) => t.id)).toContain(tx.id);
    }
    const card = ok<{ id: string }[]>(await w.adminA1.get('/api/v1/transactions?paymentMethod=CARD&limit=100'));
    expect(card.map((t) => t.id)).not.toContain(tx.id);
  });

  it('a bill paid one way reads as one part', async () => {
    const d = await fill();
    const tx = (await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CARD', idempotencyKey: key() })).body.data
      .transaction as Tx & { payments: { method: string; amount: number }[] };
    expect(tx.payments).toEqual([{ method: 'CARD', amount: tx.grandTotal }]);
  });

  it('rejects a mode used twice', async () => {
    const d = await fill();
    const res = await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, {
      version: d.version,
      paymentMethod: 'CASH',
      payments: [{ method: 'CASH', amount: 100 }, { method: 'CASH', amount: d.totals.grandTotal - 100 }],
      idempotencyKey: key(),
    });
    expect(res.status).toBe(400);
    // leave no open bill with items behind for later tests
    await w.adminA1.post(`/api/v1/bills/${d.id}/finalize`, { version: d.version, paymentMethod: 'CASH', idempotencyKey: key() });
  });
});
