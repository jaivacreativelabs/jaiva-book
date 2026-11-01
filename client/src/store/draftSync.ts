/**
 * Draft synchronisation engine – keeps every open bill persisted in MongoDB.
 *
 * - Edits are applied locally at once (optimistic UI) and saved after a short debounce.
 * - Each save sends the version it was based on; the server answers 409 if someone else
 *   changed the bill, and we load their version instead of overwriting it.
 * - Network/server failures are retried with back-off and shown as "Not saved".
 * - Engines live outside React (one per draft id), so switching tables or pages never
 *   cancels a pending save; they are dropped only once everything is saved.
 */
import type { DiscountInput, DraftDTO, DraftItemDTO } from '@rb/shared';
import { api, ApiError, apiSync } from '../services/api';

export type SyncStatus =
  | 'loading'
  | 'load-failed'
  | 'saved'
  | 'pending'
  | 'saving'
  | 'error' // could not reach the server – retrying
  | 'rejected' // server refused the change (e.g. item unavailable) – reverted
  | 'conflict' // someone else changed the bill – their version is shown
  | 'closed'; // finalised or deleted elsewhere

export interface LocalBill {
  items: DraftItemDTO[];
  customerName: string;
  discount: DiscountInput | null;
}

export interface DraftSyncState {
  draft: DraftDTO | null;
  local: LocalBill | null;
  status: SyncStatus;
  message: string | null;
  dirty: boolean;
}

export interface DraftSaveBody {
  version: number;
  items: { menuItemId: string; quantity: number; note: string }[];
  customerName: string;
  discount: DiscountInput | null;
}

export interface DraftTransport {
  load(id: string, branchId: string): Promise<DraftDTO>;
  save(id: string, branchId: string, body: DraftSaveBody): Promise<DraftDTO>;
}

export const httpTransport: DraftTransport = {
  load: (id, branchId) => api.get<DraftDTO>(`/bills/${id}`, { branchId }),
  save: (id, branchId, body) => api.put<DraftDTO>(`/bills/${id}`, body, { branchId }),
};

/** Saves a draft synchronously (see DraftSync.flushSync). */
export const saveDraftSync = (id: string, branchId: string, body: DraftSaveBody) => apiSync.put<DraftDTO>(`/bills/${id}`, body, { branchId });

const toBody = (draft: DraftDTO, local: LocalBill): DraftSaveBody => ({
  version: draft.version,
  items: local.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity, note: i.note ?? '' })),
  customerName: local.customerName,
  discount: local.discount,
});

const toLocal = (d: DraftDTO): LocalBill => ({ items: d.items, customerName: d.customerName, discount: d.discount });

/** Keeps local quantities but refreshes server-owned fields (price, name, availability). */
function mergeServerFields(local: LocalBill, saved: DraftDTO): LocalBill {
  const byId = new Map(saved.items.map((i) => [i.menuItemId, i]));
  return {
    ...local,
    items: local.items.map((i) => {
      const s = byId.get(i.menuItemId);
      return s ? { ...i, name: s.name, unitPrice: s.unitPrice, imageUrl: s.imageUrl, taxable: s.taxable, taxRateBps: s.taxRateBps, extraTaxes: s.extraTaxes, unavailable: s.unavailable } : i;
    }),
  };
}

const globalListeners = new Set<() => void>();
const notifyGlobal = () => globalListeners.forEach((fn) => fn());

export class DraftSync {
  private state: DraftSyncState = { draft: null, local: null, status: 'loading', message: null, dirty: false };
  private listeners = new Set<() => void>();
  private revision = 0;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  refCount = 0;

  constructor(
    readonly id: string,
    readonly branchId: string,
    private transport: DraftTransport = httpTransport,
    private debounceMs = 350,
  ) {}

  getState = (): DraftSyncState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Unsaved local edits or a save in progress. */
  get busy(): boolean {
    return this.state.dirty || this.inFlight || this.timer !== null;
  }

  private set(patch: Partial<DraftSyncState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
    notifyGlobal();
  }

  async load(): Promise<void> {
    if (this.busy) return; // never clobber unsaved edits
    try {
      const d = await this.transport.load(this.id, this.branchId);
      if (this.busy) return;
      this.set({
        draft: d,
        local: toLocal(d),
        status: d.status === 'ACTIVE' ? 'saved' : 'closed',
        message: d.status === 'ACTIVE' ? null : `This bill was already ${d.status === 'FINALIZED' ? 'generated' : 'deleted'}.`,
      });
    } catch (err) {
      if (!this.state.draft) this.set({ status: 'load-failed', message: (err as Error).message });
    }
  }

  /** Applies an edit locally and schedules a save. */
  update(mutate: (bill: LocalBill) => LocalBill): void {
    const { local, status } = this.state;
    if (!local || status === 'closed' || status === 'loading' || status === 'load-failed') return;
    this.revision += 1;
    this.set({ local: mutate(local), dirty: true, status: this.inFlight ? 'saving' : 'pending', message: null });
    this.schedule(this.debounceMs);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private async flush(): Promise<void> {
    if (this.inFlight) return; // the finally-block reschedules if still dirty
    const { draft, local, dirty } = this.state;
    if (!dirty || !draft || !local) return this.settleWaiters();

    const sentRevision = this.revision;
    this.inFlight = true;
    this.set({ status: 'saving' });
    try {
      const saved = await this.transport.save(this.id, this.branchId, toBody(draft, local));
      this.retryDelay = 0;
      if (this.revision === sentRevision) {
        this.set({ draft: saved, local: toLocal(saved), dirty: false, status: 'saved', message: null });
      } else {
        // More edits happened meanwhile: keep them, adopt the new version and save again.
        this.set({ draft: saved, local: mergeServerFields(this.state.local!, saved), status: 'pending' });
      }
    } catch (err) {
      this.handleSaveError(err, draft);
    } finally {
      this.inFlight = false;
      if (this.state.dirty && this.state.status === 'pending' && !this.timer) this.schedule(0);
      this.settleWaiters();
      notifyGlobal();
    }
  }

  private handleSaveError(err: unknown, basedOn: DraftDTO) {
    const e = err instanceof ApiError ? err : new ApiError(0, 'NETWORK', (err as Error)?.message ?? 'Network error');
    const current = (e.details as { current?: DraftDTO } | undefined)?.current;
    if (e.status === 409 && e.code === 'CONFLICT' && current) {
      this.set({ draft: current, local: toLocal(current), dirty: false, status: 'conflict', message: e.message });
    } else if (e.status === 409 && (e.code === 'BILL_FINALIZED' || e.code === 'BILL_DELETED')) {
      this.set({ dirty: false, status: 'closed', message: e.message });
    } else if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
      // The server refused the change: return to the last saved state.
      this.set({ local: toLocal(basedOn), dirty: false, status: 'rejected', message: e.message });
    } else {
      this.retryDelay = Math.min(Math.max(1000, this.retryDelay * 2), 15_000);
      this.set({ status: 'error', message: `Not saved – retrying (${e.message})` });
      this.schedule(this.retryDelay);
    }
  }

  /** Retries immediately (e.g. when the browser comes back online). */
  retryNow() {
    if (this.state.dirty && !this.inFlight) this.schedule(0);
  }

  /**
   * Saves pending edits right now with a synchronous request, so a print can stay inside the tap
   * that asked for it. Returns false when a save is already on its way (then use flushNow);
   * throws when the bill could not be saved.
   */
  flushSync(save: (id: string, branchId: string, body: DraftSaveBody) => DraftDTO = saveDraftSync): boolean {
    if (this.inFlight) return false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const { draft, local, dirty } = this.state;
    if (!dirty || !draft || !local) return true;
    try {
      const saved = save(this.id, this.branchId, toBody(draft, local));
      this.retryDelay = 0;
      this.set({ draft: saved, local: toLocal(saved), dirty: false, status: 'saved', message: null });
      return true;
    } catch (err) {
      this.handleSaveError(err, draft);
      throw new Error(this.state.message ?? 'The bill could not be saved');
    } finally {
      this.settleWaiters();
    }
  }

  /** Saves pending edits now; resolves when everything is persisted, rejects otherwise. */
  flushNow(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      void this.flush();
    });
  }

  private settleWaiters() {
    if (this.inFlight || this.waiters.length === 0) return;
    const { status, dirty, message } = this.state;
    const failed = status === 'error' || status === 'conflict' || status === 'rejected' || status === 'closed' || status === 'load-failed';
    if (!failed && dirty) return; // another save is coming
    const waiters = this.waiters.splice(0);
    for (const w of waiters) {
      if (failed) w.reject(new Error(message ?? 'The bill could not be saved'));
      else w.resolve();
    }
  }

  /** Clears a transient message (conflict / rejected) after the user has seen it. */
  acknowledge() {
    if (this.state.status === 'conflict' || this.state.status === 'rejected') this.set({ status: 'saved', message: null });
  }
}

// ---------------- Registry ----------------

const registry = new Map<string, DraftSync>();

export function acquireDraftSync(id: string, branchId: string, transport?: DraftTransport): DraftSync {
  let sync = registry.get(id);
  if (!sync) {
    sync = new DraftSync(id, branchId, transport);
    registry.set(id, sync);
    const s = sync;
    // Drop the engine once nobody uses it and nothing is left to save.
    s.subscribe(() => {
      if (s.refCount <= 0 && !s.busy) registry.delete(s.id);
    });
  }
  sync.refCount += 1;
  void sync.load();
  return sync;
}

export function releaseDraftSync(sync: DraftSync) {
  sync.refCount -= 1;
  if (sync.refCount > 0) return;
  if (sync.busy) {
    sync.flushNow().catch(() => undefined); // keeps retrying in the background
  } else {
    registry.delete(sync.id);
  }
}

export function syncSummary(): { pending: number; failing: number } {
  let pending = 0;
  let failing = 0;
  for (const s of registry.values()) {
    if (s.busy) pending += 1;
    if (s.getState().status === 'error') failing += 1;
  }
  return { pending, failing };
}

let summaryCache = syncSummary();
export const subscribeSyncSummary = (fn: () => void) => {
  const wrapped = () => {
    const next = syncSummary();
    if (next.pending !== summaryCache.pending || next.failing !== summaryCache.failing) {
      summaryCache = next;
      fn();
    }
  };
  globalListeners.add(wrapped);
  return () => globalListeners.delete(wrapped);
};
export const getSyncSummary = () => summaryCache;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (syncSummary().pending > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('online', () => registry.forEach((s) => s.retryNow()));
}
