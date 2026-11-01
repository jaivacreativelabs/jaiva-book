import {
  calculateBill,
  LIMITS,
  TABLE_SHAPES,
  kitchenPending,
  type DiscountInput,
  type DraftDTO,
  type DraftItemDTO,
  type KitchenQty,
  type KitchenTicketDTO,
  type PaymentMethod,
  type PaymentPart,
  type TableDTO,
  type TableGroupSummaryDTO,
  type TableShape,
  type TablesResponseDTO,
  type TableStatus,
  type TransactionDTO,
} from '@rb/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRightLeft, ChevronUp, CirclePlus, FileText, Merge, Minus, Pencil, Plus, Split, Trash2, Users, Utensils } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TableIcon } from '../../components/badges';
import { DiscountEditor } from '../../components/DiscountEditor';
import { FoodImage } from '../../components/FoodImage';
import { PaymentModal, printReceipt } from '../../components/PaymentButtons';
import { TableIllustration } from '../../components/TableIllustration';
import { CancelButton, ConfirmButton, ConfirmDialog, Empty, Field, Loading, PageHeader, SidePanel, Spinner, Stepper } from '../../components/ui';
import { api, ApiError, apiSync, errorMessage } from '../../services/api';
import { tableKeys, useTables } from '../../services/queries';
import { useAuth } from '../../store/auth';
import { acquireDraftSync, releaseDraftSync, type DraftSync } from '../../store/draftSync';
import { useToast } from '../../store/toast';
import { usePageSearch } from '../../store/topbar';
import { cx, formatMoney, newIdempotencyKey } from '../../utils/format';
import { splitVariant } from '../../utils/menu';
import { DishNote } from '../../components/DishNote';
import { addItemToBill, FoodGrid, setBillNote, setBillQuantity } from '../../components/FoodGrid';
import { KitchenSendButton, useSendToKitchen } from '../../components/KitchenSend';
import { useDraftSync } from '../../hooks/useDraftSync';
import { useRootClass } from '../../hooks/useRootClass';
import { MergeGroupModal, MoveGroupModal, SplitGroupModal, type GroupAction, type SplitChoice } from './TableGroupActions';

/** Same default naming as the server: the first free "Group N". */
function nextGroupName(existing: string[]): string {
  const used = new Set(existing);
  for (let n = 1; ; n++) if (!used.has(`Group ${n}`)) return `Group ${n}`;
}
const GROUP_COLORS = [
  ['#fff1cc', '#e5a800'],
  ['#fde4e4', '#e04848'],
  ['#e3eefc', '#2f6fdb'],
  ['#e5f4e9', '#1e9e45'],
];

function pillText(t: TableDTO) {
  switch (t.occupancy) {
    case 'AVAILABLE':
      return 'Available';
    case 'FULL':
      return 'Full';
    case 'RESERVED':
      return 'Reserved';
    default:
      return `${t.seatsUsed} / ${t.seats} Seats`;
  }
}

function TableCard({ table, selected, onClick }: { table: TableDTO; selected: boolean; onClick: () => void }) {
  return (
    <button className={cx('table-card', table.occupancy, selected && 'selected')} onClick={onClick} aria-pressed={selected}>
      <span className="table-label">{table.label}</span>
      <span className="table-seats">{table.seats} Seats</span>
      <TableIllustration shape={table.shape} seats={table.seats} tone={table.occupancy} />
      <span className={cx('status-pill', table.occupancy)}>{pillText(table)}</span>
    </button>
  );
}

// ---------------- Add / edit table ----------------

function TableForm({
  initial,
  floors,
  defaultFloor,
  suggestedLabel,
  onClose,
  onSaved,
}: {
  initial?: TableDTO;
  floors: string[];
  defaultFloor: string;
  suggestedLabel: string;
  onClose: () => void;
  onSaved: (t: TableDTO) => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(initial?.label ?? '');
  const [seats, setSeats] = useState(initial?.seats ?? 4);
  const [shape, setShape] = useState<TableShape>(initial?.shape ?? 'SQUARE');
  const [floor, setFloor] = useState(initial?.floor ?? defaultFloor);
  const [status, setStatus] = useState<TableStatus>(initial?.status ?? 'AVAILABLE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const minSeats = Math.max(1, initial?.seatsUsed ?? 1);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { label: label.trim(), seats, shape, floor: floor.trim() || 'Ground Floor', status };
      const saved = initial ? await api.patch<TableDTO>(`/tables/${initial.id}`, body) : await api.post<TableDTO>('/tables', body);
      toast.success(initial ? `Table ${saved.label} updated` : `Table ${saved.label} added`);
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.delete(`/tables/${initial!.id}`);
      toast.success(`Table ${initial!.label} removed`);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setConfirmRemove(false);
    }
  };

  return (
    <SidePanel title={initial ? `Edit ${initial.label}` : 'Add Table'} onClose={onClose}>
      <form className="stack" style={{ gap: 22 }} onSubmit={submit}>
        <Field label="Table Number" error={error}>
          {(id) => (
            <input id={id} className="input" placeholder={`e.g. ${suggestedLabel}`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={10} required autoFocus />
          )}
        </Field>
        <div className="field">
          <span className="field-label">Number of Seats</span>
          <Stepper label="seats" value={seats} min={minSeats} max={LIMITS.maxSeats} onChange={setSeats} />
          {initial && initial.seatsUsed > 0 && <span className="field-hint">{initial.seatsUsed} seats are in use right now.</span>}
        </div>
        <div className="field">
          <span className="field-label">Table Shape</span>
          <div className="shape-options" role="radiogroup" aria-label="Table shape">
            {TABLE_SHAPES.map((s) => (
              <button type="button" key={s} role="radio" aria-checked={shape === s} className={cx('shape-option', shape === s && 'active')} onClick={() => setShape(s)}>
                <TableIllustration shape={s} seats={4} tone="WOOD" />
                {s === 'SQUARE' ? 'Square' : 'Round'}
              </button>
            ))}
          </div>
        </div>
        <Field label="Floor">
          {(id) => (
            <>
              <input id={id} className="input" list="floor-options" value={floor} onChange={(e) => setFloor(e.target.value)} maxLength={40} required />
              <datalist id="floor-options">
                {floors.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <div className="input-icon">
              <span className="dot" style={{ position: 'absolute', left: 16, top: 16, background: status === 'AVAILABLE' ? 'var(--status-available)' : 'var(--status-reserved)' }} />
              <select id={id} className="select" style={{ paddingLeft: 46 }} value={status} onChange={(e) => setStatus(e.target.value as TableStatus)}>
                <option value="AVAILABLE">Available</option>
                <option value="RESERVED">Reserved</option>
              </select>
            </div>
          )}
        </Field>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !label.trim()}>
          {busy ? <Spinner /> : <CirclePlus />} {initial ? 'Save Changes' : 'Add Table'}
        </button>
        {initial && (
          <button type="button" className="btn btn-danger-soft btn-block" onClick={() => setConfirmRemove(true)} disabled={initial.groups.length > 0}>
            <Trash2 /> Remove table
          </button>
        )}
      </form>
      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${initial!.label}?`}
          message="The table disappears from the floor plan. Past bills keep their table number."
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmRemove(false)}
          onConfirm={remove}
        />
      )}
    </SidePanel>
  );
}

// ---------------- Table detail (groups) ----------------

/**
 * A group's dishes with − qty + and remove – on the card and while adding food. With the Kitchen
 * Display, each dish can carry a note for the kitchen until all of it has been sent (`sent`).
 */
function GroupLines({
  lines,
  onQty,
  onNote,
  sent = [],
}: {
  lines: DraftItemDTO[];
  onQty: (id: string, quantity: number) => void;
  onNote?: (id: string, note: string) => void;
  sent?: KitchenQty[];
}) {
  if (lines.length === 0) return <span className="muted">No items yet</span>;
  const sentById = new Map(sent.map((s) => [s.menuItemId, s.quantity]));
  return (
    <div className="group-lines">
      {lines.map((l) => (
        <div key={l.menuItemId} className={cx('group-line', l.unavailable && 'unavailable')}>
          <div className="thumb thumb-xs">
            <FoodImage src={l.imageUrl} alt={l.name} />
          </div>
          <span className="group-line-name" title={l.name}>
            {splitVariant(l.name).dish}
            {splitVariant(l.name).variant && <small className="line-variant">{splitVariant(l.name).variant}</small>}
            <small>{formatMoney(l.unitPrice * l.quantity)}</small>
            {onNote && <DishNote dish={l.name} note={l.note} onChange={(n) => onNote(l.menuItemId, n)} disabled={(sentById.get(l.menuItemId) ?? 0) >= l.quantity} />}
          </span>
          <div className="qty">
            <button onClick={() => onQty(l.menuItemId, l.quantity - 1)} aria-label={`Decrease ${l.name}`}>
              <Minus size={15} />
            </button>
            <output>{l.quantity}</output>
            <button onClick={() => onQty(l.menuItemId, l.quantity + 1)} disabled={l.unavailable} aria-label={`Increase ${l.name}`}>
              <Plus size={15} />
            </button>
          </div>
          <button className="icon-btn plain danger-text" onClick={() => onQty(l.menuItemId, 0)} aria-label={`Remove ${l.name}`}>
            <Trash2 />
          </button>
        </div>
      ))}
    </div>
  );
}

/** What of a group's live bill the kitchen still needs, and sending it (unsaved edits are flushed first). */
function useGroupKitchen(draftId: string, sync: DraftSync | null, lines: DraftItemDTO[], draft: DraftDTO | null, onSent: () => void) {
  const { send, sending } = useSendToKitchen();
  // What the kitchen already has; updated here after sending (the draft itself is not reloaded).
  const [sentNow, setSentNow] = useState<KitchenQty[] | null>(null);
  const sent = sentNow ?? draft?.kitchenSent ?? [];
  const pending = kitchenPending(lines, sent);
  const sendToKitchen = async () => {
    const most = new Map(sent.map((s) => [s.menuItemId, s.quantity]));
    for (const l of lines) most.set(l.menuItemId, Math.max(most.get(l.menuItemId) ?? 0, l.quantity));
    if (await send(draftId, sync)) {
      setSentNow([...most].map(([menuItemId, quantity]) => ({ menuItemId, quantity })));
      onSent();
    }
  };
  return { pending, sending, sendToKitchen, sent };
}

/** Left side while ordering: the branch menu; tapping a dish adds it to the active group. */
function OrderingMenu({
  draftId,
  branchId,
  title,
  search,
  onDone,
}: {
  draftId: string;
  branchId: string;
  title: string;
  search: string;
  onDone: () => void;
}) {
  const { sync, state } = useDraftSync(draftId, branchId);
  const qtyById = useMemo(() => new Map((state.local?.items ?? []).map((i) => [i.menuItemId, i.quantity])), [state.local]);
  const editable = Boolean(sync && state.local && state.draft?.status === 'ACTIVE');
  return (
    <div className="page">
      <div className="ordering-head">
        <button className="link-btn" onClick={onDone}>
          <ArrowLeft size={16} /> Tables
        </button>
        <h1 className="page-title">{title}</h1>
      </div>
      {state.status === 'closed' ? (
        <div className="alert alert-info">{state.message}</div>
      ) : (
        <FoodGrid branchId={branchId} search={search} qtyById={qtyById} editable={editable} onAdd={(item) => sync?.update((b) => addItemToBill(b, item))} />
      )}
    </div>
  );
}

/** "Add discount" for a group's bill, with the amount it takes off. */
function GroupDiscount({ draftId, sync, discount, amount }: { draftId: string; sync: DraftSync; discount: DiscountInput | null; amount: number }) {
  return (
    <div className="group-discount">
      <DiscountEditor key={draftId} value={discount} onApply={(d) => sync.update((b) => ({ ...b, discount: d }))} />
      {amount > 0 && <span className="group-discount-amount num">Discount − {formatMoney(amount)}</span>}
    </div>
  );
}

/**
 * A group at the table with its dishes, quantities and live total. The same card stays on screen while
 * its menu is open on the left (`active`), sharing the draft's sync engine – so nothing reloads or flickers.
 */
function GroupCard({
  group,
  index,
  branchId,
  active,
  onAddItems,
  onGenerate,
  onDelete,
  onSent,
  onAction,
}: {
  group: TableGroupSummaryDTO;
  index: number;
  branchId: string;
  active: boolean;
  onAddItems: () => void;
  onGenerate: (liveTotal: number) => void;
  onDelete: () => void;
  onSent: () => void;
  onAction: (action: GroupAction) => void;
}) {
  const { activeBranch } = useAuth();
  // The bill itself, so its dishes, quantities and discount can be changed right here.
  const { sync, state } = useDraftSync(group.draftId, branchId);
  const local = state.local;
  const settings = activeBranch!.restaurant.settings;
  const totals = useMemo(() => (local ? calculateBill(local.items, settings, local.discount) : null), [local, settings]);
  const total = totals?.grandTotal ?? group.grandTotal;
  const [bg, fg] = GROUP_COLORS[index % GROUP_COLORS.length];
  const lines = local?.items ?? [];
  const itemCount = local ? lines.reduce((a, l) => a + l.quantity, 0) : group.itemCount;
  const setQty = (id: string, quantity: number) => sync?.update((b) => setBillQuantity(b, id, quantity));
  const kitchen = useGroupKitchen(group.draftId, sync, lines, state.draft, onSent);
  const extra = group.lineCount - group.previewItems.slice(0, 2).length;
  return (
    <div className={cx('group-card', active && 'active')} aria-label={active ? `Adding food to ${group.groupName}` : undefined}>
      <div className="group-head">
        <div className="group-icon" style={{ background: bg, color: fg }}>
          <Users />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="group-name">{group.groupName}</div>
          <div className="muted">
            {group.guestCount} {group.guestCount === 1 ? 'Person' : 'People'}
          </div>
        </div>
        <div className="group-amount num">{formatMoney(total)}</div>
        <button className="icon-btn plain" onClick={onDelete} aria-label={`Delete ${group.groupName}`} title="Delete this group's bill">
          <Trash2 />
        </button>
      </div>
      {state.status === 'error' && <div className="alert alert-warning">Not saved – retrying</div>}
      {state.message && (state.status === 'conflict' || state.status === 'rejected') && <div className="alert alert-warning">{state.message}</div>}
      {local ? (
        <GroupLines
          lines={lines}
          onQty={setQty}
          onNote={activeBranch!.kitchenDisplay ? (id, note) => sync?.update((b) => setBillNote(b, id, note)) : undefined}
          sent={kitchen.sent}
        />
      ) : (
        // Until the bill has loaded: a glimpse of its dishes.
        <div className="group-items">
          {group.previewItems.length === 0 ? (
            <span className="muted">No items yet</span>
          ) : (
            <>
              {group.previewItems.slice(0, 2).map((p, i) => (
                <div className="thumb" key={i} style={{ width: 48, height: 48 }} title={p.name}>
                  <FoodImage src={p.imageUrl} alt={p.name} />
                </div>
              ))}
              {extra > 0 && <span className="group-more">+{extra}</span>}
            </>
          )}
        </div>
      )}
      {sync && local && local.items.length > 0 && <GroupDiscount draftId={group.draftId} sync={sync} discount={local.discount} amount={totals?.discountAmount ?? 0} />}
      <div className="group-actions">
        <button className="btn btn-outline-primary" onClick={onAddItems}>
          <Utensils /> Add Items
        </button>
        <button className="btn btn-primary" onClick={() => onGenerate(total)} disabled={itemCount === 0}>
          <FileText /> Generate Bill
        </button>
      </div>
      {activeBranch!.kitchenDisplay && itemCount > 0 && (
        <KitchenSendButton pending={local ? kitchen.pending : group.kitchenPending} sending={kitchen.sending} onSend={() => void kitchen.sendToKitchen()} />
      )}
      <GroupMoreActions itemCount={itemCount} guestCount={group.guestCount} onAction={onAction} />
    </div>
  );
}

/** Move · Merge · Split under a group (also while adding items to it). */
function GroupMoreActions({ itemCount, guestCount, onAction }: { itemCount: number; guestCount: number; onAction: (action: GroupAction) => void }) {
  return (
    <div className="group-more-actions">
      <button className="link-btn" onClick={() => onAction('move')} title="Move this group to another table">
        <ArrowRightLeft size={15} /> Move
      </button>
      <button className="link-btn" onClick={() => onAction('merge')} title="Add this group's bill to another group's bill">
        <Merge size={15} /> Merge
      </button>
      <button
        className="link-btn"
        onClick={() => onAction('split')}
        disabled={itemCount < 2 || guestCount < 2}
        title={guestCount < 2 ? 'Needs at least 2 guests to split' : 'Move some dishes into a new group at this table'}
      >
        <Split size={15} /> Split
      </button>
    </div>
  );
}

function NewGroupForm({
  free,
  busy,
  nextName,
  onCreate,
  onCancel,
}: {
  free: number;
  busy: boolean;
  nextName: string;
  onCreate: (guests: number, name: string, openBill: boolean) => void;
  onCancel: () => void;
}) {
  const [guests, setGuests] = useState(Math.min(2, free));
  const [name, setName] = useState('');
  return (
    <div className="group-card">
      <div className="group-name">New group</div>
      <Field label="Group name" hint={`Optional – left empty it is called “${nextName}”`}>
        {(id) => <input id={id} className="input" placeholder={`e.g. ${nextName} or Ravi family`} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />}
      </Field>
      <div className="field">
        <span className="field-label">Guests</span>
        <Stepper label="guests" value={guests} min={1} max={free} onChange={setGuests} />
      </div>
      <div className="group-actions">
        <CancelButton onClick={onCancel} disabled={busy} />
        <ConfirmButton onClick={() => onCreate(guests, name.trim(), true)} busy={busy} label="Add food" />
      </div>
      <button className="link-btn" style={{ alignSelf: 'center' }} onClick={() => onCreate(guests, name.trim(), false)} disabled={busy}>
        Just seat the group
      </button>
    </div>
  );
}

function TableDetail({
  table,
  onClose,
  onEdit,
  onOrder,
  activeDraftId,
  onExitOrder,
  onLeaveOrder,
  hiddenOnPhone,
}: {
  table: TableDTO;
  onClose: () => void;
  onEdit: () => void;
  /** Shows the menu for this group's bill inside the Tables page. */
  onOrder: (draftId: string) => void;
  /** The group currently being served (menu open on the left), if any. */
  activeDraftId: string | null;
  onExitOrder: () => void;
  /** Leaves (or moves) the order without sending it to the kitchen – after a move or merge. */
  onLeaveOrder: (next: { table?: string; order: string | null }) => void;
  /** Phones while ordering: the menu takes the screen until the bottom bar is tapped. */
  hiddenOnPhone?: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { activeBranch } = useAuth();
  const branchId = activeBranch!.id;
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState<TableGroupSummaryDTO | null>(null);
  const [deleting, setDeleting] = useState<TableGroupSummaryDTO | null>(null);
  const free = Math.max(0, table.seats - table.seatsUsed);
  const refresh = () => queryClient.invalidateQueries({ queryKey: tableKeys.list(branchId) });
  // Show "All items sent" straight away; the refresh then brings the server's numbers.
  const markSent = (draftId: string) => {
    queryClient.setQueryData<TablesResponseDTO>(tableKeys.list(branchId), (data) =>
      data && {
        ...data,
        tables: data.tables.map((t) => ({ ...t, groups: t.groups.map((g) => (g.draftId === draftId ? { ...g, kitchenPending: 0 } : g)) })),
      },
    );
    void refresh();
  };

  const createGroup = async (guestCount: number, groupName: string, openBill: boolean) => {
    setBusy(true);
    try {
      const d = await api.post<DraftDTO>('/bills/table-groups', { tableId: table.id, guestCount, ...(groupName && { groupName }) });
      setAdding(false);
      await refresh();
      if (openBill) onOrder(d.id);
      else toast.success(`${d.groupName} seated at ${table.label}`);
    } catch (err) {
      toast.error(err);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /** Uses the draft's sync engine so unsaved edits are flushed and the latest version is used. */
  const withLatestDraft = async <T,>(draftId: string, fn: (d: DraftDTO) => Promise<T>): Promise<T> => {
    const sync = acquireDraftSync(draftId, branchId);
    try {
      await sync.load();
      await sync.flushNow();
      const d = sync.getState().draft;
      if (!d) throw new Error(sync.getState().message ?? 'Could not load this bill');
      return await fn(d);
    } finally {
      releaseDraftSync(sync);
    }
  };

  type Payment = { paymentMethod: PaymentMethod; payments?: PaymentPart[] };
  const finalize = (d: DraftDTO, payment: Payment) => ({ version: d.version, ...payment, idempotencyKey: newIdempotencyKey() });

  /**
   * Saves and generates the bill within this tap (synchronous requests – the screen waits a
   * moment), so it prints at once: Safari on an iPad prints only from a tap. While an edit is
   * still being sent the tap cannot wait for it, so then it is done the usual way.
   */
  const generateNow = (draftId: string, payment: Payment): { transaction: TransactionDTO } | null => {
    const sync = acquireDraftSync(draftId, branchId);
    try {
      const savedHere = sync.getState().dirty;
      if (!sync.flushSync()) return null;
      // The latest version: ours if we just saved it, else the server's (another device may have changed it).
      const d = savedHere ? sync.getState().draft! : apiSync.get<DraftDTO>(`/bills/${draftId}`, { branchId });
      return apiSync.post<{ transaction: TransactionDTO }>(`/bills/${d.id}/finalize`, finalize(d, payment));
    } finally {
      releaseDraftSync(sync);
    }
  };

  const generate = async (group: TableGroupSummaryDTO, payment: Payment) => {
    try {
      const res =
        generateNow(group.draftId, payment) ??
        (await withLatestDraft(group.draftId, (d) => api.post<{ transaction: TransactionDTO }>(`/bills/${d.id}/finalize`, finalize(d, payment))));
      setPaying(null);
      printReceipt(res.transaction); // no message: the print itself shows the bill was saved
      if (group.draftId === activeDraftId) onExitOrder();
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
    } catch (err) {
      toast.error(err);
      if (err instanceof ApiError && err.status === 409) setPaying(null);
    } finally {
      await refresh();
    }
  };

  const removeGroup = async (group: TableGroupSummaryDTO) => {
    try {
      await withLatestDraft(group.draftId, (d) => api.delete(`/bills/${d.id}`, { query: { version: d.version } }));
      if (group.draftId === activeDraftId) onExitOrder();
      toast.success(`${group.groupName}'s bill deleted`);
    } catch (err) {
      toast.error(err);
    } finally {
      setDeleting(null);
      await refresh();
    }
  };

  // ---- Move / Merge / Split ----
  const allTables = useTables(branchId).data?.tables ?? [table];
  const [action, setAction] = useState<{ kind: GroupAction; group: TableGroupSummaryDTO } | null>(null);
  /** The bill open on the left was changed by the server: load the new version. */
  const reloadIfOpen = (draftId: string) => {
    if (draftId !== activeDraftId) return;
    releaseDraftSync(acquireDraftSync(draftId, branchId));
  };
  const runAction = async (work: () => Promise<string>) => {
    try {
      toast.success(await work());
      setAction(null);
    } catch (err) {
      toast.error(err);
    } finally {
      await refresh();
    }
  };
  const moveGroup = (g: TableGroupSummaryDTO, tableId: string) =>
    runAction(async () => {
      const moved = await withLatestDraft(g.draftId, (d) => api.post<DraftDTO>(`/bills/${d.id}/move`, { version: d.version, tableId }));
      // Adding items to this group: carry on at its new table.
      if (g.draftId === activeDraftId) onLeaveOrder({ table: tableId, order: moved.id });
      return `${g.groupName} moved to ${moved.tableLabel}${moved.groupName !== g.groupName ? ` as ${moved.groupName}` : ''}`;
    });
  const mergeGroup = (g: TableGroupSummaryDTO, intoDraftId: string) =>
    runAction(async () => {
      const merged = await withLatestDraft(g.draftId, (d) => api.post<DraftDTO>(`/bills/${d.id}/merge`, { version: d.version, intoDraftId }));
      reloadIfOpen(intoDraftId);
      if (g.draftId === activeDraftId) onLeaveOrder({ order: null }); // its bill is closed now
      return `${g.groupName} merged into ${merged.tableLabel} ${merged.groupName} – ${formatMoney(merged.totals.grandTotal)}`;
    });
  const splitGroup = (g: TableGroupSummaryDTO, choice: SplitChoice) =>
    runAction(async () => {
      const { created } = await withLatestDraft(g.draftId, (d) =>
        api.post<{ source: DraftDTO; created: DraftDTO }>(`/bills/${d.id}/split`, {
          version: d.version,
          items: choice.items,
          guestCount: choice.guestCount,
          ...(choice.groupName && { groupName: choice.groupName }),
        }),
      );
      reloadIfOpen(g.draftId);
      return `${created.groupName} now has its own bill – ${formatMoney(created.totals.grandTotal)}`;
    });

  const markAvailable = async () => {
    try {
      await api.patch(`/tables/${table.id}`, { status: 'AVAILABLE' });
      await refresh();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <SidePanel
      className={hiddenOnPhone ? 'phone-hidden' : undefined}
      title={`Table ${table.label}`}
      subtitle={
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="nowrap">
            Capacity: {table.seats} Seats · {table.floor}
          </span>
          <span className="seats-chip" style={{ marginLeft: 0 }}>
            {table.seatsUsed} / {table.seats} Seats Used
          </span>
        </div>
      }
      onClose={onClose}
      footer={
        <div className="row">
          <button className="link-btn" onClick={onEdit}>
            <Pencil size={15} /> Edit table
          </button>
        </div>
      }
    >
      {table.status === 'RESERVED' && table.groups.length === 0 && (
        <div className="alert alert-warning">
          <TableIcon width={18} height={18} />
          <div className="stack" style={{ gap: 8 }}>
            <span>This table is reserved. Mark it available when the guests arrive.</span>
            <button className="btn btn-sm btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={markAvailable}>
              Mark as Available
            </button>
          </div>
        </div>
      )}

      {table.groups.map((g, i) => {
        const active = g.draftId === activeDraftId;
        return (
          <GroupCard
            key={g.draftId}
            group={g}
            index={i}
            branchId={branchId}
            active={active}
            onAddItems={() => (active ? onExitOrder() : onOrder(g.draftId))}
            onGenerate={(liveTotal) => setPaying({ ...g, grandTotal: liveTotal })}
            onDelete={() => setDeleting(g)}
            onSent={() => (active ? void refresh() : markSent(g.draftId))}
            onAction={(kind) => setAction({ kind, group: g })}
          />
        );
      })}

      {adding ? (
        <NewGroupForm free={free} busy={busy} nextName={nextGroupName(table.groups.map((g) => g.groupName))} onCreate={createGroup} onCancel={() => setAdding(false)} />
      ) : (
        <button className="add-group" onClick={() => setAdding(true)} disabled={free === 0 || table.status === 'RESERVED'}>
          <span className="plus">
            <Plus size={30} />
          </span>
          <span>
            <strong>Add New Group</strong>
            <small>
              ({free} seat{free === 1 ? '' : 's'} available)
            </small>
          </span>
        </button>
      )}

      <div className="seat-summary">
        <Users />
        <div>
          <strong>Available Seats: {free}</strong>
          <div className="muted">
            {free === 0 ? 'This table is full.' : `You can add ${free} more ${free === 1 ? 'person' : 'people'} to this table.`}
          </div>
        </div>
      </div>

      {action?.kind === 'move' && (
        <MoveGroupModal group={action.group} table={table} tables={allTables} onClose={() => setAction(null)} onConfirm={(id) => moveGroup(action.group, id)} />
      )}
      {action?.kind === 'merge' && (
        <MergeGroupModal group={action.group} table={table} tables={allTables} onClose={() => setAction(null)} onConfirm={(id) => mergeGroup(action.group, id)} />
      )}
      {action?.kind === 'split' && (
        <SplitGroupModal
          group={action.group}
          branchId={branchId}
          nextName={nextGroupName(table.groups.map((g) => g.groupName))}
          onClose={() => setAction(null)}
          onConfirm={(choice) => splitGroup(action.group, choice)}
        />
      )}
      {paying && (
        <PaymentModal
          title={`Generate bill · ${table.label} ${paying.groupName}`}
          amount={paying.grandTotal}
          onClose={() => setPaying(null)}
          onConfirm={(m) => generate(paying, m)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.groupName}'s bill?`}
          message={
            deleting.itemCount > 0
              ? `This open bill has ${deleting.itemCount} item(s) worth ${formatMoney(deleting.grandTotal)}. Deleting it frees the seats and cannot be undone. Completed bills are not affected.`
              : 'The group will be removed and its seats freed.'
          }
          confirmLabel="Delete bill"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => removeGroup(deleting)}
        />
      )}
    </SidePanel>
  );
}

// ---------------- Page ----------------

const isPhone = () => window.matchMedia('(max-width: 768px)').matches;

/**
 * Tables page. Serving a group (?order=<draftId>) happens right here: the right panel stays as it
 * is and only the left side changes from the tables to the menu.
 */
export function TablesPage() {
  const { activeBranch } = useAuth();
  const branchId = activeBranch!.id;
  const tables = useTables(branchId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('table');
  const panel = params.get('panel'); // 'add' | 'edit'
  const order = params.get('order');
  // Phones: while ordering, the menu fills the screen and the table panel opens from a bottom bar.
  const [panelOnPhone, setPanelOnPhone] = useState(false);

  const selectedTable = tables.data?.tables.find((t) => t.id === selectedId) ?? null;
  const activeGroup = order ? (selectedTable?.groups.find((g) => g.draftId === order) ?? null) : null;
  const ordering = Boolean(order && selectedTable && activeGroup && !panel);
  useRootClass('has-bill-bar', ordering);
  const search = usePageSearch(ordering ? 'Search food items...' : 'Search tables...');
  const live = useDraftSync(ordering ? order : null, branchId);
  const liveCount = live.state.local?.items.reduce((a, i) => a + i.quantity, 0) ?? 0;
  const liveTotal = useMemo(
    () => (live.state.local ? calculateBill(live.state.local.items, activeBranch!.restaurant.settings, live.state.local.discount).grandTotal : 0),
    [live.state.local, activeBranch],
  );

  const floors = tables.data?.floors ?? [];
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (tables.data?.tables ?? []).filter((t) => !q || t.label.toLowerCase().includes(q));
  }, [tables.data, search]);
  const selected = tables.data?.tables.find((t) => t.id === selectedId) ?? null;

  const suggestedLabel = useMemo(() => {
    const nums = (tables.data?.tables ?? []).map((t) => Number(/(\d+)$/.exec(t.label)?.[1] ?? 0));
    return `T${String(Math.max(0, ...nums) + 1).padStart(2, '0')}`;
  }, [tables.data]);

  const setPanel = (next: { table?: string | null; panel?: string | null; order?: string | null }) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: tableKeys.list(branchId) });
  const exitOrder = () => {
    // Kitchen Display branches: "Add Items" saves the order and sends what was added to the kitchen.
    if (activeBranch!.kitchenDisplay && order && live.sync) {
      const draftId = order;
      live.sync
        .flushNow()
        .then(() => api.post<KitchenTicketDTO | null>(`/bills/${draftId}/kitchen`))
        .then((ticket) => {
          if (ticket) toast.success(`Sent to kitchen: ${ticket.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}`);
        })
        .catch((err) => toast.error(err));
    }
    setPanelOnPhone(false);
    setPanel({ order: null });
    void refresh();
  };

  return (
    <>
      {ordering ? (
        <OrderingMenu
          draftId={order!}
          branchId={branchId}
          title={`Table ${selectedTable!.label} · ${activeGroup!.groupName}`}
          search={search}
          onDone={exitOrder}
        />
      ) : (
      <div className="page">
        <PageHeader
          title="Tables"
          subtitle="View and manage restaurant tables"
          actions={
            <button className="btn btn-primary btn-lg" onClick={() => setPanel({ panel: 'add', table: null })}>
              <CirclePlus /> Add Table
            </button>
          }
        />
        <div className="legend">
          <span>
            <i className="dot" style={{ background: 'var(--status-available)' }} /> Available
          </span>
          <span>
            <i className="dot" style={{ background: 'var(--status-partial)' }} /> Partially Occupied
          </span>
          <span>
            <i className="dot" style={{ background: 'var(--status-full)' }} /> Full
          </span>
          <span>
            <i className="dot" style={{ background: 'var(--status-reserved)' }} /> Reserved
          </span>
        </div>
        {tables.isLoading ? (
          <Loading label="Loading tables…" />
        ) : tables.isError ? (
          <Empty title="Could not load tables">{errorMessage(tables.error)}</Empty>
        ) : visible.length === 0 ? (
          <Empty icon={<TableIcon />} title={search ? 'No tables match your search' : 'No tables yet'}>
            {!search && 'Use “Add Table” to build your floor plan.'}
          </Empty>
        ) : (
          <div className="tables-grid">
            {visible.map((t) => (
              <TableCard key={t.id} table={t} selected={t.id === selectedId} onClick={() => setPanel({ table: t.id, panel: null })} />
            ))}
          </div>
        )}
      </div>
      )}

      {ordering && (
        <button type="button" className="bill-mobile-bar" onClick={() => setPanelOnPhone(true)} aria-label="View table bill">
          <span className="count">
            {liveCount} item{liveCount === 1 ? '' : 's'}
          </span>
          <span className="total num">{formatMoney(liveTotal)}</span>
          <span className="view">
            {activeGroup!.groupName} <ChevronUp size={18} />
          </span>
        </button>
      )}

      {panel === 'add' && (
        <TableForm
          floors={floors}
          defaultFloor={floors[0] ?? 'Ground Floor'}
          suggestedLabel={suggestedLabel}
          onClose={() => setPanel({ panel: null })}
          onSaved={(t) => {
            void refresh();
            setPanel({ panel: null, table: t.id });
          }}
        />
      )}
      {panel === 'edit' && selected && (
        <TableForm
          key={selected.id}
          initial={selected}
          floors={floors}
          defaultFloor={selected.floor}
          suggestedLabel={suggestedLabel}
          onClose={() => {
            void refresh();
            setPanel({ panel: null, table: null });
          }}
          onSaved={() => {
            void refresh();
            setPanel({ panel: null });
          }}
        />
      )}
      {!panel && selected && (
        <TableDetail
          key={selected.id}
          table={selected}
          hiddenOnPhone={ordering && !panelOnPhone}
          onClose={() => {
            if (ordering && isPhone()) setPanelOnPhone(false); // back to the menu
            else setPanel({ table: null, order: null });
          }}
          onEdit={() => setPanel({ panel: 'edit', order: null })}
          activeDraftId={ordering ? order : null}
          onExitOrder={exitOrder}
          onLeaveOrder={(next) => setPanel(next)}
          onOrder={(draftId) => {
            setPanelOnPhone(false);
            // A new history entry, so the browser's Back button returns to the table.
            const p = new URLSearchParams(params);
            p.set('order', draftId);
            setParams(p);
          }}
        />
      )}
    </>
  );
}
