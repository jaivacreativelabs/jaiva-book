import type { DraftDTO } from '@rb/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../services/api';
import { DraftSync, type DraftSaveBody, type DraftTransport, type LocalBill } from './draftSync';

function draft(version: number, items: [string, number][] = []): DraftDTO {
  return {
    id: 'd1',
    restaurantId: 'r',
    branchId: 'b',
    type: 'TABLE',
    tableId: 't',
    tableLabel: 'T1',
    groupName: 'Group 1',
    guestCount: 2,
    groupTag: '',
    customerName: '',
    items: items.map(([id, quantity]) => ({ menuItemId: id, name: id, imageUrl: null, unitPrice: 1000, taxable: true, taxRateBps: null, extraTaxes: [], quantity, unavailable: false, note: '' })),
    discount: null,
    totals: { subtotal: 0, discountAmount: 0, taxes: [], taxTotal: 0, grandTotal: 0 },
    status: 'ACTIVE',
    version,
    transactionId: null,
    kitchenSent: [],
    updatedAt: '',
    updatedByName: '',
  };
}

/** In-memory server with the same version rules as the real API. */
function fakeServer() {
  let stored = draft(0);
  let failNext = 0;
  const transport: DraftTransport & { saves: DraftSaveBody[] } = {
    saves: [],
    load: async () => structuredClone(stored),
    save: async (_id, _b, body) => {
      transport.saves.push(body);
      if (failNext > 0) {
        failNext -= 1;
        throw new ApiError(0, 'NETWORK', 'offline');
      }
      if (body.version !== stored.version) throw new ApiError(409, 'CONFLICT', 'changed by Asha', { current: structuredClone(stored) });
      stored = draft(stored.version + 1, body.items.map((i) => [i.menuItemId, i.quantity]));
      return structuredClone(stored);
    },
  };
  return {
    transport,
    get stored() {
      return stored;
    },
    externalEdit(items: [string, number][]) {
      stored = draft(stored.version + 1, items);
    },
    failNext(n: number) {
      failNext = n;
    },
  };
}

const add =
  (id: string) =>
  (bill: LocalBill): LocalBill => {
    const existing = bill.items.find((i) => i.menuItemId === id);
    return {
      ...bill,
      items: existing
        ? bill.items.map((i) => (i.menuItemId === id ? { ...i, quantity: i.quantity + 1 } : i))
        : [...bill.items, { menuItemId: id, name: id, imageUrl: null, unitPrice: 1000, taxable: true, taxRateBps: null, extraTaxes: [], quantity: 1, unavailable: false, note: '' }],
    };
  };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('DraftSync', () => {
  it('debounces rapid edits into one save and persists them', async () => {
    const server = fakeServer();
    const sync = new DraftSync('d1', 'b', server.transport, 300);
    await sync.load();
    sync.update(add('idly'));
    sync.update(add('idly'));
    sync.update(add('dosa'));
    expect(sync.getState().status).toBe('pending');
    await vi.advanceTimersByTimeAsync(300);
    expect(server.transport.saves).toHaveLength(1);
    expect(server.stored.items.map((i) => [i.menuItemId, i.quantity])).toEqual([
      ['idly', 2],
      ['dosa', 1],
    ]);
    expect(sync.getState()).toMatchObject({ status: 'saved', dirty: false });
  });

  it('flushNow saves immediately (used before finalising and when leaving a table)', async () => {
    const server = fakeServer();
    const sync = new DraftSync('d1', 'b', server.transport, 10_000);
    await sync.load();
    sync.update(add('vada'));
    await sync.flushNow();
    expect(server.stored.items).toHaveLength(1);
    expect(sync.busy).toBe(false);
  });

  it('flushSync saves within the call (Generate Bill prints from the same tap)', async () => {
    const server = fakeServer();
    const sync = new DraftSync('d1', 'b', server.transport, 10_000);
    await sync.load();
    // A synchronous save with the same rules as the server.
    let stored = server.stored;
    const saveSync = (_id: string, _b: string, body: DraftSaveBody) => {
      if (body.version !== stored.version) throw new ApiError(409, 'CONFLICT', 'changed by Asha', { current: stored });
      stored = draft(stored.version + 1, body.items.map((i) => [i.menuItemId, i.quantity]));
      return stored;
    };
    expect(sync.flushSync(saveSync)).toBe(true); // nothing to save
    sync.update(add('vada'));
    expect(sync.flushSync(saveSync)).toBe(true);
    expect(stored.items.map((i) => i.menuItemId)).toEqual(['vada']);
    expect(sync.getState()).toMatchObject({ status: 'saved', dirty: false });
    expect(sync.busy).toBe(false); // the debounced save was cancelled
    // A refused save is reported, not swallowed.
    sync.update(add('idly'));
    stored = draft(stored.version + 5);
    expect(() => sync.flushSync(saveSync)).toThrow('changed by Asha');
    expect(sync.getState().status).toBe('conflict');
  });

  it('flushSync leaves a save that is already on its way to flushNow', async () => {
    const server = fakeServer();
    // The server answers only when told to.
    let answer = () => {};
    const slow: DraftTransport = {
      load: server.transport.load,
      save: (...args) => new Promise((resolve, reject) => (answer = () => server.transport.save(...args).then(resolve, reject))),
    };
    const sync = new DraftSync('d1', 'b', slow, 0);
    await sync.load();
    sync.update(add('vada'));
    await vi.advanceTimersByTimeAsync(0); // the save has started, not finished
    const saveSync = vi.fn();
    expect(sync.flushSync(saveSync)).toBe(false);
    expect(saveSync).not.toHaveBeenCalled();
    const done = sync.flushNow();
    answer();
    await done;
    expect(server.stored.items).toHaveLength(1);
  });

  it('shows the other user’s version on conflict instead of overwriting it', async () => {
    const server = fakeServer();
    const sync = new DraftSync('d1', 'b', server.transport, 10);
    await sync.load();
    server.externalEdit([['coffee', 2]]);
    sync.update(add('idly'));
    await vi.advanceTimersByTimeAsync(10);
    const s = sync.getState();
    expect(s.status).toBe('conflict');
    expect(s.message).toContain('Asha');
    expect(s.local?.items.map((i) => i.menuItemId)).toEqual(['coffee']);
    expect(server.stored.items.map((i) => i.menuItemId)).toEqual(['coffee']);
  });

  it('keeps unsaved edits while offline and retries until saved', async () => {
    const server = fakeServer();
    const sync = new DraftSync('d1', 'b', server.transport, 10);
    await sync.load();
    server.failNext(2);
    sync.update(add('idly'));
    await vi.advanceTimersByTimeAsync(10);
    expect(sync.getState().status).toBe('error');
    expect(sync.getState().local?.items).toHaveLength(1);
    await expect(sync.flushNow()).rejects.toThrow(/retrying/);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sync.getState().status).toBe('saved');
    expect(server.stored.items).toHaveLength(1);
  });

  it('does not let a reload clobber unsaved edits', async () => {
    const server = fakeServer();
    const sync = new DraftSync('d1', 'b', server.transport, 1000);
    await sync.load();
    sync.update(add('idly'));
    await sync.load();
    expect(sync.getState().local?.items).toHaveLength(1);
  });

  it('keeps edits made while a save is in flight', async () => {
    const server = fakeServer();
    const sync = new DraftSync('d1', 'b', server.transport, 5);
    await sync.load();
    sync.update(add('idly'));
    await vi.advanceTimersByTimeAsync(5); // first save starts and resolves within this tick
    sync.update(add('dosa'));
    await vi.advanceTimersByTimeAsync(50);
    expect(server.stored.items.map((i) => i.menuItemId)).toEqual(['idly', 'dosa']);
    expect(sync.getState().status).toBe('saved');
  });
});
