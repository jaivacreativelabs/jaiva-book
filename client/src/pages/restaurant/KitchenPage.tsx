/**
 * Kitchen Display: live order tickets of the branch in three columns – New, Preparing,
 * Ready. Tickets arrive when an order is sent from a table ("Add Items") or a bill is generated.
 * Parcels (take away) are marked as such; when Ready the counter hands them over.
 */
import { isParcel, KITCHEN_BOARD_STATUSES, ticketPlace, type KitchenTicketDTO } from '@rb/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefHat, Package, Printer, Star, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { StaffTabs } from '../../components/StaffTabs';
import { markOwnAction, playReadyDone } from '../../hooks/useOrderChime';
import { Empty, Loading, PageHeader, Spinner } from '../../components/ui';
import { ApiError, api, errorMessage } from '../../services/api';
import { useAuth } from '../../store/auth';
import { useToast } from '../../store/toast';
import { cx, formatDateTime } from '../../utils/format';

type BoardStatus = (typeof KITCHEN_BOARD_STATUSES)[number];

const COLUMN: Record<BoardStatus, { title: string; action: string; tone: string }> = {
  NEW: { title: 'New', action: 'Start preparing', tone: 'new' },
  PREPARING: { title: 'Preparing', action: 'Mark ready', tone: 'preparing' },
  READY: { title: 'Ready', action: 'Served', tone: 'ready' },
};

const boardKey = (branchId: string) => ['kitchen', branchId] as const;

/** Where the food goes ("Table T13 · Group 1", no Order no.), and for a billed counter order its bill number. */
function TicketPlace({ ticket, className }: { ticket: KitchenTicketDTO; className: string }) {
  return (
    <div className={cx(className, isParcel(ticket) && 'parcel')}>
      {isParcel(ticket) && <Package size={14} aria-hidden />}
      {ticketPlace(ticket, false)}
      {ticket.billNumber && !ticket.tableLabel && <span className="kds-bill-no">Bill {ticket.billNumber}</span>}
    </div>
  );
}

/** Re-renders every 30 s so the waiting times stay current. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function openKitchenSlip(ticketId: string, branchId: string) {
  window.open(`/print/kitchen/${ticketId}?branch=${branchId}&autoprint=1`, '_blank', 'noopener,width=420,height=640');
}

function TicketCard({
  ticket,
  branchId,
  now,
  viewOnly,
  showStation,
}: {
  ticket: KitchenTicketDTO;
  branchId: string;
  now: number;
  /** The Restaurant Admin's board: see every ticket, change none (only the slip can be printed). */
  viewOnly: boolean;
  showStation: boolean;
}) {
  const queryClient = useQueryClient();
  // The "done" sound is for Kitchen logins only (the admin's dashboard has no sound).
  const isKitchen = useAuth().user?.role === 'KITCHEN';
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const status = ticket.status as BoardStatus;
  const minutes = Math.max(0, Math.floor((now - new Date(ticket.createdAt).getTime()) / 60_000));

  const replace = (next: KitchenTicketDTO | null) =>
    queryClient.setQueryData<KitchenTicketDTO[]>(boardKey(branchId), (list) =>
      (list ?? []).flatMap((t) => (t.id !== ticket.id ? [t] : next && KITCHEN_BOARD_STATUSES.includes(next.status as BoardStatus) ? [next] : [])),
    );

  const run = async (call: () => Promise<KitchenTicketDTO>) => {
    setBusy(true);
    try {
      replace(await call());
    } catch (err) {
      toast.error(err);
      if (err instanceof ApiError && err.code === 'CONFLICT') void queryClient.invalidateQueries({ queryKey: boardKey(branchId) });
    } finally {
      setBusy(false);
    }
  };
  // Serving / handing over from this screen: no "served" sound here for its own tap.
  const advance = () => {
    if (status === 'READY') markOwnAction(ticket.id);
    return run(async () => {
      const next = await api.post<KitchenTicketDTO>(`/kitchen/tickets/${ticket.id}/advance`, { from: ticket.status });
      if (next.status === 'READY' && isKitchen) playReadyDone([next.id]); // "Mark ready": the kitchen's own "done" sound
      return next;
    });
  };
  // Preparing: tick a dish done – it goes to the waiter's Ready to Serve now; the ticket moves to
  // Ready (as a whole) once every dish is ticked. Untick a mistake while it is not served yet.
  // The tick shows at once; the server's answer then confirms it (or it springs back on an error).
  const [ticking, setTicking] = useState<Record<string, boolean>>({});
  const tickDish = async (menuItemId: string, ready: boolean) => {
    setTicking((m) => ({ ...m, [menuItemId]: ready }));
    try {
      const next = await api.post<KitchenTicketDTO>(`/kitchen/tickets/${ticket.id}/dish-ready`, { menuItemId, ready });
      replace(next);
      if (ready && isKitchen) playReadyDone([`${ticket.id}:${menuItemId}`]);
    } catch (err) {
      toast.error(err);
      if (err instanceof ApiError && err.code === 'CONFLICT') void queryClient.invalidateQueries({ queryKey: boardKey(branchId) });
    } finally {
      setTicking((m) => {
        const rest = { ...m };
        delete rest[menuItemId];
        return rest;
      });
    }
  };
  // Checkboxes only while Preparing, and only when there is more than one dish (one dish: Mark ready).
  const perDish = !viewOnly && status === 'PREPARING' && ticket.items.length > 1;
  const togglePriority = () => run(() => api.post<KitchenTicketDTO>(`/kitchen/tickets/${ticket.id}/priority`, { priority: !ticket.priority }));
  // A Ready parcel waits for the counter, which hands it over on New Bill.
  const parcelWaiting = status === 'READY' && isParcel(ticket);
  const viewText =
    status === 'NEW' ? 'Waiting for the kitchen' : status === 'PREPARING' ? 'Being prepared' : parcelWaiting ? 'Waiting at the counter' : 'Waiting for the waiter';

  return (
    <article className={cx('kds-ticket', ticket.priority && 'priority')} aria-label={`Ticket ${ticket.number}`}>
      <header className="kds-ticket-head">
        <div style={{ minWidth: 0 }}>
          <div className="kds-ticket-no">
            #{ticket.number}
            {ticket.priority && <Star size={15} className="kds-star-on" aria-label="Priority" />}
            {ticket.editedAt && (
              <span className="kds-edited" title={`Changed by the waiter at ${formatDateTime(ticket.editedAt)}`}>
                Edited
              </span>
            )}
          </div>
          <TicketPlace ticket={ticket} className="kds-ticket-where" />
          {ticket.createdByName && <div className="kds-ticket-by">by {ticket.createdByName}</div>}
          {showStation && ticket.stationName && <span className="kds-station">{ticket.stationName}</span>}
        </div>
        <span className={cx('kds-timer', minutes >= 20 ? 'late' : minutes >= 10 && 'slow')} title={`Ordered ${formatDateTime(ticket.createdAt)}`}>
          <Timer size={13} /> {minutes < 1 ? 'now' : `${minutes}m`}
        </span>
      </header>
      <ul className="kds-items">
        {ticket.items.map((i) => (
          <li key={i.menuItemId} className={cx(perDish && 'kds-dish', perDish && (ticking[i.menuItemId] ?? i.ready) && 'ticked')}>
            {perDish ? (
              <label className="kds-dish-check" title={i.served ? 'Already served' : i.ready ? 'Ready – sent to the waiter (tap to undo)' : 'Tick when ready – it goes to the waiter'}>
                <input
                  type="checkbox"
                  checked={ticking[i.menuItemId] ?? i.ready}
                  disabled={busy || i.served || i.menuItemId in ticking}
                  onChange={(e) => void tickDish(i.menuItemId, e.target.checked)}
                />
                <span style={{ minWidth: 0 }}>
                  <strong>{i.quantity}×</strong> {i.name}
                  {i.note && <span className="kds-note">{i.note}</span>}
                </span>
                {i.ready && <span className={cx('kds-dish-state', i.served && 'served')}>{i.served ? 'Served' : 'Ready'}</span>}
              </label>
            ) : (
              <div style={{ minWidth: 0 }}>
                <strong>{i.quantity}×</strong> {i.name}
                {i.note && <span className="kds-note">{i.note}</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <footer className="kds-ticket-actions">
        {viewOnly ? (
          <span className="kds-at-counter kds-view-status">{viewText}</span>
        ) : !parcelWaiting ? (
          <button className={cx('btn btn-sm', status === 'READY' ? 'btn-outline-primary' : 'btn-primary')} onClick={advance} disabled={busy}>
            {busy && <Spinner />} {COLUMN[status].action}
          </button>
        ) : (
          <span className="kds-at-counter">Waiting at the counter</span>
        )}
        {!viewOnly && (
          <button className={cx('icon-btn', ticket.priority && 'active')} onClick={togglePriority} disabled={busy} title={ticket.priority ? 'Remove priority' : 'Mark as priority'} aria-pressed={ticket.priority}>
            <Star size={17} className={ticket.priority ? 'kds-star-on' : undefined} />
          </button>
        )}
        <button className="icon-btn" onClick={() => openKitchenSlip(ticket.id, branchId)} title="Print kitchen slip" aria-label="Print kitchen slip">
          <Printer size={17} />
        </button>
      </footer>
    </article>
  );
}

export function KitchenPage() {
  const { activeBranch, user } = useAuth();
  const branchId = activeBranch!.id;
  // Only Kitchen logins move tickets; the Restaurant Admin's Kitchen page is to watch.
  const viewOnly = user?.role !== 'KITCHEN';
  const now = useNow();
  // Kitchen counters: a counter's login only gets its own tickets (from the server); everyone
  // else can narrow the board to one counter.
  const stations = activeBranch!.kitchenStations;
  const myStation = user?.role === 'KITCHEN' ? stations.find((s) => s.id === user.kitchenStationId) : undefined;
  const [station, setStation] = useState('');
  // Phones show one column at a time: New, Preparing or Ready (larger screens show all three).
  const [stage, setStage] = useState<BoardStatus>('NEW');
  const board = useQuery({
    queryKey: boardKey(branchId),
    queryFn: () => api.get<KitchenTicketDTO[]>('/kitchen/tickets'),
    enabled: activeBranch!.kitchenDisplay,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
  });

  if (!activeBranch!.kitchenDisplay) {
    return (
      <div className="page">
        <Empty icon={<ChefHat />} title="Kitchen Display is off for this restaurant">
          The Super Admin can switch it on under Restaurants › Bills &amp; Kitchen.
        </Empty>
      </div>
    );
  }

  const tickets = (board.data ?? []).filter((t) => !station || t.stationId === station);
  const showStation = !myStation && stations.length > 0;
  return (
    <div className="page kds-page">
      <StaffTabs />
      <PageHeader
        title={myStation ? `Kitchen Display · ${myStation.name}` : 'Kitchen Display'}
        subtitle={
          myStation
            ? `Orders for the ${myStation.name} counter · New → Preparing → Ready`
            : viewOnly
              ? 'View only · the kitchen moves orders New → Preparing → Ready'
              : 'Live order tickets · New → Preparing → Ready'
        }
      />
      {showStation && stations.length > 1 && (
        <div className="chips kds-stations" role="radiogroup" aria-label="Kitchen counter">
          {[{ id: '', name: 'All counters' }, ...stations].map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={station === s.id} className={cx('chip chip-sm', station === s.id && 'active')} onClick={() => setStation(s.id)}>
              {s.name}
              {s.id && <span className="kds-count">{(board.data ?? []).filter((t) => t.stationId === s.id).length}</span>}
            </button>
          ))}
        </div>
      )}
      {board.isLoading ? (
        <Loading label="Loading tickets…" />
      ) : board.isError ? (
        <Empty title="Could not load tickets">{errorMessage(board.error)}</Empty>
      ) : (
        <>
        <div className="kds-stage-tabs" role="tablist" aria-label="Column">
          {KITCHEN_BOARD_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={stage === status}
              className={cx('kds-stage-tab', COLUMN[status].tone, stage === status && 'active')}
              onClick={() => setStage(status)}
            >
              <span className="kds-dot" />
              {COLUMN[status].title}
              <span className="kds-count">{tickets.filter((t) => t.status === status).length}</span>
            </button>
          ))}
        </div>
        <div className="kds-board">
          {KITCHEN_BOARD_STATUSES.map((status) => {
            const list = tickets.filter((t) => t.status === status);
            return (
              <section key={status} className={cx('kds-column', COLUMN[status].tone, stage === status && 'shown')} aria-label={COLUMN[status].title}>
                <h2 className="kds-column-head">
                  <span className="kds-dot" />
                  {COLUMN[status].title}
                  <span className="kds-count">{list.length}</span>
                </h2>
                <div className="kds-column-body">
                  {list.length === 0 ? (
                    <p className="kds-empty">No tickets</p>
                  ) : (
                    list.map((t) => <TicketCard key={t.id} ticket={t} branchId={branchId} now={now} viewOnly={viewOnly} showStation={showStation} />)
                  )}
                </div>
              </section>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}

const slipCss = `
@page { size: 80mm auto; margin: 4mm; }
body { background: #fff !important; }
.slip { width: 72mm; margin: 0 auto; padding: 8px 0; font-family: 'Courier New', ui-monospace, monospace; font-size: 13px; color: #000; line-height: 1.4; }
.slip h1 { font-size: 16px; text-align: center; margin: 0 0 4px; font-family: inherit; }
.slip .c { text-align: center; }
.slip .rule { border-top: 1px dashed #000; margin: 6px 0; }
.slip .big { font-size: 15px; font-weight: bold; }
.slip li { list-style: none; font-size: 15px; padding: 2px 0; }
.slip .note { display: block; padding-left: 2.2em; font-size: 13px; font-weight: bold; }
.slip ul { margin: 0; padding: 0; }
.print-actions { text-align: center; margin: 16px; font-family: var(--font-family); }
@media print { .print-actions { display: none; } }
`;

/** 80 mm kitchen slip (KOT). Printing never changes the ticket. */
export function PrintKitchenTicketPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const branchId = params.get('branch');
  const ticket = useQuery({
    queryKey: ['kitchen-ticket', id],
    queryFn: () => api.get<KitchenTicketDTO>(`/kitchen/tickets/${id}`, { branchId }),
    enabled: Boolean(branchId),
  });

  useEffect(() => {
    if (ticket.data && params.get('autoprint') === '1') {
      const t = setTimeout(() => window.print(), 300);
      return () => clearTimeout(t);
    }
  }, [ticket.data, params]);

  if (!branchId) return <p style={{ padding: 20 }}>Missing branch.</p>;
  if (ticket.isLoading) return <p style={{ padding: 20 }}>Loading ticket…</p>;
  if (ticket.isError) return <p style={{ padding: 20 }}>Could not load this ticket: {errorMessage(ticket.error)}</p>;
  const t = ticket.data!;
  return (
    <>
      <style>{slipCss}</style>
      <div className="slip">
        <h1>KITCHEN ORDER</h1>
        <div className="c">#{t.number}</div>
        {t.stationName && <div className="c big">{t.stationName} counter</div>}
        <div className="rule" />
        <div className="big">{ticketPlace(t)}</div>
        {t.billNumber && !t.tableLabel && <div>Bill: {t.billNumber}</div>}
        <div>{formatDateTime(t.createdAt)}</div>
        <div>By: {t.createdByName}</div>
        {t.priority && <div className="big">*** PRIORITY ***</div>}
        <div className="rule" />
        <ul>
          {t.items.map((i) => (
            <li key={i.menuItemId}>
              {i.quantity} x {i.name}
              {i.note && <span className="note">** {i.note}</span>}
            </li>
          ))}
        </ul>
        <div className="rule" />
      </div>
      <div className="print-actions">
        <button className="btn btn-primary" onClick={() => window.print()}>
          Print
        </button>
      </div>
    </>
  );
}
