/**
 * Served Orders: what was served at a table or handed over at the counter, one day at a time
 * (today first) – one card per order, with the KOTs it went to the kitchen in. Every login of the branch sees it; the Super Admin picks a restaurant.
 */
import { isParcel, ticketPlace, type KitchenTicketDTO } from '@rb/shared';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Package, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { StaffTabs } from '../../components/StaffTabs';
import { Empty, Loading, PageHeader } from '../../components/ui';
import { api, errorMessage } from '../../services/api';
import { useAuth } from '../../store/auth';
import { cx, formatDate, formatTime, isoDay } from '../../utils/format';

/** "25m" or "1h 05m" between two moments. */
function took(from: string, to: string): string {
  const m = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * One order's served KOTs (an order goes to the kitchen in parts: each send, each kitchen counter,
 * each dish sent early), oldest first.
 */
type ServedOrder = { key: string; tickets: KitchenTicketDTO[] };

function groupByOrder(tickets: KitchenTicketDTO[]): ServedOrder[] {
  const byOrder = new Map<string, KitchenTicketDTO[]>();
  for (const t of tickets) byOrder.set(t.draftId, [...(byOrder.get(t.draftId) ?? []), t]);
  const last = (o: KitchenTicketDTO[]) => Math.max(...o.map((t) => new Date(t.statusAt).getTime()));
  return [...byOrder]
    .map(([key, list]) => ({ key, tickets: [...list].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.number.localeCompare(y.number)) }))
    .sort((x, y) => last(y.tickets) - last(x.tickets)); // latest served first
}

function ServedCard({ order }: { order: ServedOrder }) {
  const { tickets } = order;
  const first = tickets[0];
  const parcel = isParcel(first);
  const servedAt = tickets.reduce((m, t) => (t.statusAt > m ? t.statusAt : m), first.statusAt);
  // The order's dishes, added up over its KOTs (notes kept).
  const dishes = new Map<string, { name: string; quantity: number; notes: Set<string> }>();
  for (const t of tickets) {
    for (const i of t.items) {
      const d = dishes.get(i.menuItemId) ?? { name: i.name, quantity: 0, notes: new Set<string>() };
      d.quantity += i.quantity;
      if (i.note) d.notes.add(i.note);
      dishes.set(i.menuItemId, d);
    }
  }
  const servedBy = [...new Set(tickets.map((t) => t.servedByName).filter(Boolean))];
  const stations = [...new Set(tickets.map((t) => t.stationName).filter(Boolean))];
  const billNumber = tickets.find((t) => t.billNumber)?.billNumber;
  return (
    <article className={cx('kds-ticket served-ticket', parcel && 'parcel')} aria-label={ticketPlace(first)}>
      <header className="kds-ticket-head">
        <div style={{ minWidth: 0 }}>
          <div className={cx('waiter-where', parcel && 'parcel')}>
            {parcel && <Package size={16} aria-hidden />} {ticketPlace(first)}
            {tickets.some((t) => t.priority) && <Star size={15} className="kds-star-on" aria-label="Priority" />}
          </div>
          {billNumber && <div className="kds-ticket-by">Bill {billNumber}</div>}
          {stations.map((name) => (
            <span key={name} className="kds-station">
              {name}
            </span>
          ))}
        </div>
        <span className="served-at" title={`Last served ${formatDate(servedAt)}, ${formatTime(servedAt)}`}>
          {formatTime(servedAt)}
        </span>
      </header>
      <ul className="kds-items">
        {[...dishes].map(([id, d]) => (
          <li key={id}>
            <strong>{d.quantity}×</strong> {d.name}
            {[...d.notes].map((n) => (
              <span key={n} className="kds-note">
                {n}
              </span>
            ))}
          </li>
        ))}
      </ul>
      {/* Each part that went to the kitchen: its KOT number and when it was served */}
      <ul className="served-kots">
        {tickets.map((t) => (
          <li key={t.id}>
            <span className="served-kot-no">#{t.number}</span>
            <span title={`${parcel ? 'Handed over' : 'Served'} ${formatTime(t.statusAt)}`}>
              {t.items.reduce((n, i) => n + i.quantity, 0)}× · {formatTime(t.statusAt)}
            </span>
          </li>
        ))}
      </ul>
      <footer className="served-meta">
        <span>
          {parcel ? 'Handed over' : 'Served'} by <strong>{servedBy.join(', ') || '—'}</strong>
        </span>
        <span>
          Ordered {formatTime(first.createdAt)}
          {first.createdByName && ` by ${first.createdByName}`} · took {took(first.createdAt, servedAt)}
        </span>
      </footer>
    </article>
  );
}

/** The day's served orders of one branch. */
export function ServedView({ branchId, filters }: { branchId: string | null; filters?: ReactNode }) {
  const { user } = useAuth();
  const today = isoDay(new Date());
  const [date, setDate] = useState(today);
  // Waiter logins only reach the waiter routes; everyone else reads it from the kitchen.
  const path = user?.role === 'WAITER' ? '/waiter/served' : '/kitchen/served';
  const served = useQuery({
    queryKey: ['served', branchId, date],
    queryFn: () => api.get<KitchenTicketDTO[]>(path, { query: { date }, branchId }),
    enabled: Boolean(branchId),
    refetchInterval: date === today ? 10_000 : false,
  });

  const tickets = served.data ?? [];
  const orders = groupByOrder(tickets);
  const dishes = tickets.reduce((n, t) => n + t.items.reduce((s, i) => s + i.quantity, 0), 0);
  return (
    <div className="page">
      <StaffTabs />
      <PageHeader
        title="Served Orders"
        subtitle="Orders served at the table or handed over at the counter"
        actions={
          <>
            {filters}
            <input type="date" className="input input-sm" value={date} max={today} onChange={(e) => setDate(e.target.value || today)} aria-label="Day" />
          </>
        }
      />
      {!branchId ? (
        <Empty icon={<CheckCheck />} title="Select a restaurant to see its served orders" />
      ) : served.isLoading ? (
        <Loading label="Loading served orders…" />
      ) : served.isError ? (
        <Empty title="Could not load served orders">{errorMessage(served.error)}</Empty>
      ) : tickets.length === 0 ? (
        <Empty icon={<CheckCheck />} title={date === today ? 'Nothing served yet today' : `Nothing served on ${formatDate(`${date}T00:00:00`)}`}>
          Orders show here once a waiter taps Served or the counter hands a parcel over.
        </Empty>
      ) : (
        <>
          <p className="served-summary">
            <strong>{orders.length}</strong> order{orders.length > 1 ? 's' : ''} · <strong>{tickets.length}</strong> KOT{tickets.length > 1 ? 's' : ''} ·{' '}
            <strong>{dishes}</strong> dish{dishes > 1 ? 'es' : ''} · latest first
          </p>
          <div className="waiter-grid">
            {orders.map((o) => (
              <ServedCard key={o.key} order={o} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ServedPage() {
  const { activeBranch } = useAuth();
  return <ServedView branchId={activeBranch!.id} />;
}
