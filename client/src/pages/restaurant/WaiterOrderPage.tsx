/**
 * Waiter › Take Order (phone first): tables → a table's groups → dishes → Send KOT.
 * Each group shows what it has in the kitchen (Sent / Preparing / Ready). Later dishes go as a
 * new KOT with only those dishes. Waiters never bill – the Restaurant Admin does, from Tables.
 */
import { kitchenPending, type DraftDTO, type DraftItemDTO, type KitchenQty, type TableDTO, type TableGroupSummaryDTO, type TablesResponseDTO } from '@rb/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChefHat, ChevronUp, ConciergeBell, Minus, Plus, Trash2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router-dom';
import { DishNote } from '../../components/DishNote';
import { addItemToBill, FoodGrid, setBillNote, setBillQuantity } from '../../components/FoodGrid';
import { FoodImage } from '../../components/FoodImage';
import { useSendToKitchen } from '../../components/KitchenSend';
import { Empty, Loading, SidePanel, Spinner, Stepper } from '../../components/ui';
import { useDraftSync } from '../../hooks/useDraftSync';
import { useRootClass } from '../../hooks/useRootClass';
import { api, errorMessage } from '../../services/api';
import { tableKeys } from '../../services/queries';
import { useAuth } from '../../store/auth';
import { useToast } from '../../store/toast';
import { usePageSearch } from '../../store/topbar';
import { cx, formatMoney } from '../../utils/format';
import { splitVariant } from '../../utils/menu';

/** Take Order | Ready to Serve – a waiter's phone has no sidebar, so the two pages link here. */
export function WaiterTabs() {
  const { user } = useAuth();
  if (user?.role !== 'WAITER') return null;
  return (
    <nav className="tabs waiter-tabs" aria-label="Waiter pages">
      <NavLink to="/waiter/order" className={({ isActive }) => cx('tab', isActive && 'active')}>
        Take Order
      </NavLink>
      <NavLink to="/waiter" end className={({ isActive }) => cx('tab', isActive && 'active')}>
        Ready to Serve
      </NavLink>
    </nav>
  );
}

const KITCHEN_LABEL: Record<NonNullable<TableGroupSummaryDTO['kitchenStatus']>, [string, string]> = {
  NEW: ['Sent', 'badge-blue'],
  PREPARING: ['Preparing', 'badge-amber'],
  READY: ['Ready', 'badge-green'],
};

/** A group's kitchen state: what is cooking or ready, and what has not been sent yet. */
function KitchenBadges({ group }: { group: Pick<TableGroupSummaryDTO, 'kitchenStatus' | 'kitchenPending'> }) {
  return (
    <span className="waiter-badges">
      {group.kitchenStatus && <span className={cx('badge badge-sm', KITCHEN_LABEL[group.kitchenStatus][1])}>{KITCHEN_LABEL[group.kitchenStatus][0]}</span>}
      {group.kitchenPending > 0 && <span className="badge badge-sm badge-gray">{group.kitchenPending} not sent</span>}
    </span>
  );
}

function useWaiterTables(branchId: string) {
  return useQuery({
    queryKey: tableKeys.list(branchId),
    queryFn: () => api.get<TablesResponseDTO>('/tables', { branchId }),
    // The kitchen moves orders along; keep the Preparing / Ready badges current.
    refetchInterval: 5_000,
  });
}

export function WaiterOrderPage() {
  const { activeBranch } = useAuth();
  const [params, setParams] = useSearchParams();
  const tableId = params.get('table');
  const orderId = params.get('order');
  if (!activeBranch!.kitchenDisplay) {
    return (
      <div className="page">
        <WaiterTabs />
        <Empty icon={<ConciergeBell />} title="Taking orders needs the Kitchen Display">
          The Super Admin can switch the Kitchen Display on under Restaurants › Bills &amp; Kitchen.
        </Empty>
      </div>
    );
  }
  const show = (next: { table?: string; order?: string }) => setParams(next as Record<string, string>);
  if (orderId) return <WaiterOrder key={orderId} draftId={orderId} onBack={() => show(tableId ? { table: tableId } : {})} />;
  if (tableId) return <WaiterTable tableId={tableId} onBack={() => show({})} onOrder={(order) => show({ table: tableId, order })} />;
  return <WaiterTables onPick={(table) => show({ table })} />;
}

// ---------------- Tables ----------------

function WaiterTables({ onPick }: { onPick: (tableId: string) => void }) {
  const { activeBranch } = useAuth();
  const tables = useWaiterTables(activeBranch!.id);
  return (
    <div className="page">
      <WaiterTabs />
      {tables.isLoading ? (
        <Loading label="Loading tables…" />
      ) : tables.isError ? (
        <Empty title="Could not load tables">{errorMessage(tables.error)}</Empty>
      ) : (
        <div className="waiter-tables">
          {tables.data!.tables.map((t) => (
            <button key={t.id} className={cx('waiter-table', t.occupancy)} onClick={() => onPick(t.id)} aria-label={`Table ${t.label}`}>
              <span className="waiter-table-head">
                <span className="table-label">{t.label}</span>
                <span className="muted">
                  {t.seatsUsed}/{t.seats}
                </span>
              </span>
              {t.groups.length === 0 ? (
                <span className="muted">{t.occupancy === 'RESERVED' ? 'Reserved' : 'Free'}</span>
              ) : (
                t.groups.map((g) => (
                  <span key={g.draftId} className="waiter-table-group">
                    <span className="waiter-group-name">{g.groupName}</span>
                    <KitchenBadges group={g} />
                  </span>
                ))
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- One table: its groups, seating a new one ----------------

function WaiterTable({ tableId, onBack, onOrder }: { tableId: string; onBack: () => void; onOrder: (draftId: string) => void }) {
  const { activeBranch } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const tables = useWaiterTables(activeBranch!.id);
  const table: TableDTO | undefined = tables.data?.tables.find((t) => t.id === tableId);
  const free = table ? Math.max(0, table.seats - table.seatsUsed) : 0;
  const [guests, setGuests] = useState(2);
  const [busy, setBusy] = useState(false);

  const seat = async () => {
    setBusy(true);
    try {
      const d = await api.post<DraftDTO>('/bills/table-groups', { tableId, guestCount: Math.min(guests, free) });
      void queryClient.invalidateQueries({ queryKey: tableKeys.list(activeBranch!.id) });
      onOrder(d.id);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="ordering-head">
        <button className="link-btn" onClick={onBack}>
          <ArrowLeft size={16} /> Tables
        </button>
        <h1 className="page-title">{table ? `Table ${table.label}` : 'Table'}</h1>
      </div>
      {tables.isLoading ? (
        <Loading />
      ) : !table ? (
        <Empty title="This table is no longer here" />
      ) : (
        <div className="waiter-groups">
          {table.groups.map((g) => (
            <button key={g.draftId} className="group-card waiter-group" onClick={() => onOrder(g.draftId)}>
              <span className="group-head">
                <span className="group-icon">
                  <Users />
                </span>
                <span style={{ minWidth: 0, textAlign: 'left' }}>
                  <span className="group-name">{g.groupName}</span>
                  <span className="muted">
                    {g.guestCount} {g.guestCount === 1 ? 'person' : 'people'} · {g.itemCount} item{g.itemCount === 1 ? '' : 's'}
                  </span>
                </span>
              </span>
              <KitchenBadges group={g} />
              <span className="btn btn-outline-primary btn-block">Add dishes</span>
            </button>
          ))}
          {free > 0 && table.status !== 'RESERVED' ? (
            <div className="group-card">
              <div className="group-name">Seat a new group</div>
              <div className="field">
                <span className="field-label">Guests</span>
                <Stepper label="guests" value={Math.min(guests, free)} min={1} max={free} onChange={setGuests} />
              </div>
              <button className="btn btn-primary btn-lg btn-block" onClick={() => void seat()} disabled={busy}>
                {busy && <Spinner />} Seat &amp; take order
              </button>
            </div>
          ) : (
            table.groups.length === 0 && <Empty title={table.status === 'RESERVED' ? 'This table is reserved' : 'No free seats'} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- Taking the order ----------------

function WaiterOrder({ draftId, onBack }: { draftId: string; onBack: () => void }) {
  const { activeBranch } = useAuth();
  const branchId = activeBranch!.id;
  const queryClient = useQueryClient();
  const search = usePageSearch('Search food items...');
  const { sync, state } = useDraftSync(draftId, branchId);
  const { send, sending } = useSendToKitchen();
  const [panelOnPhone, setPanelOnPhone] = useState(false);
  useRootClass('has-bill-bar');

  const local = state.local;
  const draft = state.draft;
  const lines = local?.items ?? [];
  const editable = Boolean(sync && local && draft?.status === 'ACTIVE' && state.status !== 'closed');
  const qtyById = useMemo(() => new Map((local?.items ?? []).map((i) => [i.menuItemId, i.quantity])), [local]);
  // What the kitchen already has; updated here after sending (the draft itself is not reloaded).
  const [sentNow, setSentNow] = useState<KitchenQty[] | null>(null);
  const sent = sentNow ?? draft?.kitchenSent ?? [];
  const sentById = new Map(sent.map((s) => [s.menuItemId, s.quantity]));
  const pending = kitchenPending(lines, sent);
  const count = lines.reduce((a, l) => a + l.quantity, 0);
  const total = lines.reduce((a, l) => a + l.unitPrice * l.quantity, 0);
  const title = draft ? `${draft.tableLabel} · ${draft.groupName}` : 'Order';

  const sendKot = async () => {
    const most = new Map(sent.map((s) => [s.menuItemId, s.quantity]));
    for (const l of lines) most.set(l.menuItemId, Math.max(most.get(l.menuItemId) ?? 0, l.quantity));
    const ok = await send(draftId, sync);
    if (ok) {
      setSentNow([...most].map(([menuItemId, quantity]) => ({ menuItemId, quantity })));
      void queryClient.invalidateQueries({ queryKey: tableKeys.list(branchId) });
    }
    return ok;
  };
  // Leaving the order sends what is new, as on the Tables page.
  const leave = async () => {
    if (pending > 0 && editable && !(await sendKot())) return;
    onBack();
  };
  const setQty = (id: string, quantity: number) => sync?.update((b) => setBillQuantity(b, id, quantity));

  return (
    <>
      <div className="page">
        <div className="ordering-head">
          <button className="link-btn" onClick={() => void leave()} disabled={sending}>
            <ArrowLeft size={16} /> Table
          </button>
          <h1 className="page-title">{title}</h1>
        </div>
        {state.status === 'closed' ? (
          <div className="alert alert-info">{state.message}</div>
        ) : (
          <FoodGrid branchId={branchId} search={search} qtyById={qtyById} editable={editable} onAdd={(item) => sync?.update((b) => addItemToBill(b, item))} />
        )}
      </div>

      <button type="button" className="bill-mobile-bar" onClick={() => setPanelOnPhone(true)} aria-label="View order">
        <span className="count">
          {count} item{count === 1 ? '' : 's'}
        </span>
        <span className="total num">{pending > 0 ? `${pending} new` : formatMoney(total)}</span>
        <span className="view">
          View order <ChevronUp size={18} />
        </span>
      </button>

      <SidePanel
        className={panelOnPhone ? undefined : 'phone-hidden'}
        title={draft ? `Table ${title}` : 'Order'}
        subtitle={draft && `${draft.guestCount} guest${draft.guestCount === 1 ? '' : 's'} · ${formatMoney(total)}`}
        onClose={() => (panelOnPhone ? setPanelOnPhone(false) : void leave())}
        footer={
          pending > 0 ? (
            <button className="btn btn-primary btn-lg btn-block" onClick={() => void sendKot()} disabled={!editable || sending}>
              {sending ? <Spinner /> : <ChefHat />} Send KOT ({pending} new)
            </button>
          ) : (
            <div className="kitchen-sent">
              <ChefHat size={15} /> {count > 0 ? 'Everything is in the kitchen' : 'Tap a dish to add it'}
            </div>
          )
        }
      >
        {state.message && (state.status === 'conflict' || state.status === 'rejected' || state.status === 'error') && <div className="alert alert-warning">{state.message}</div>}
        {!local ? <Loading label="Loading order…" /> : <WaiterLines lines={lines} sentById={sentById} editable={editable} onQty={setQty} onNote={(id, note) => sync?.update((b) => setBillNote(b, id, note))} />}
      </SidePanel>
    </>
  );
}

/** The order's dishes. What the kitchen already has cannot be lowered here – the admin removes it. */
function WaiterLines({
  lines,
  sentById,
  editable,
  onQty,
  onNote,
}: {
  lines: DraftItemDTO[];
  sentById: Map<string, number>;
  editable: boolean;
  onQty: (id: string, quantity: number) => void;
  onNote: (id: string, note: string) => void;
}) {
  if (lines.length === 0) return <span className="muted">No dishes yet</span>;
  return (
    <div className="group-lines">
      {lines.map((l) => {
        const inKitchen = Math.min(sentById.get(l.menuItemId) ?? 0, l.quantity);
        return (
          <div key={l.menuItemId} className={cx('group-line', l.unavailable && 'unavailable')}>
            <div className="thumb thumb-xs">
              <FoodImage src={l.imageUrl} alt={l.name} />
            </div>
            <span className="group-line-name" title={l.name}>
              {splitVariant(l.name).dish}
              {splitVariant(l.name).variant && <small className="line-variant">{splitVariant(l.name).variant}</small>}
              <small>
                {formatMoney(l.unitPrice * l.quantity)}
                {inKitchen > 0 && <span className="waiter-in-kitchen"> · {inKitchen} in kitchen</span>}
              </small>
              {/* A note reaches the kitchen with the dish's next KOT, so it is fixed once all of it is there. */}
              <DishNote dish={l.name} note={l.note} onChange={(n) => onNote(l.menuItemId, n)} disabled={!editable || inKitchen >= l.quantity} />
            </span>
            <div className="qty">
              <button onClick={() => onQty(l.menuItemId, l.quantity - 1)} disabled={!editable || l.quantity <= inKitchen} aria-label={`Decrease ${l.name}`}>
                <Minus size={15} />
              </button>
              <output>{l.quantity}</output>
              <button onClick={() => onQty(l.menuItemId, l.quantity + 1)} disabled={!editable || l.unavailable} aria-label={`Increase ${l.name}`}>
                <Plus size={15} />
              </button>
            </div>
            <button className="icon-btn plain danger-text" onClick={() => onQty(l.menuItemId, 0)} disabled={!editable || inKitchen > 0} aria-label={`Remove ${l.name}`}>
              <Trash2 />
            </button>
          </div>
        );
      })}
    </div>
  );
}
