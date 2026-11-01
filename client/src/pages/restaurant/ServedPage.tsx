/**
 * Served Orders: kitchen tickets served at a table or handed over at the counter, one day at a
 * time (today first). Every login of the branch sees it; the Super Admin picks a restaurant.
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

/** "25m" or "1h 05m" from ordering to serving. */
function took(t: KitchenTicketDTO): string {
  const m = Math.max(0, Math.round((new Date(t.statusAt).getTime() - new Date(t.createdAt).getTime()) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function ServedCard({ ticket }: { ticket: KitchenTicketDTO }) {
  const parcel = isParcel(ticket);
  return (
    <article className={cx('kds-ticket served-ticket', parcel && 'parcel')} aria-label={`Ticket ${ticket.number}`}>
      <header className="kds-ticket-head">
        <div style={{ minWidth: 0 }}>
          <div className={cx('waiter-where', parcel && 'parcel')}>
            {parcel && <Package size={16} aria-hidden />} {ticketPlace(ticket)}
          </div>
          <div className="kds-ticket-no">
            #{ticket.number}
            {ticket.priority && <Star size={15} className="kds-star-on" aria-label="Priority" />}
          </div>
          {ticket.billNumber && <div className="kds-ticket-by">Bill {ticket.billNumber}</div>}
        </div>
        <span className="served-at" title={`Served ${formatDate(ticket.statusAt)}, ${formatTime(ticket.statusAt)}`}>
          {formatTime(ticket.statusAt)}
        </span>
      </header>
      <ul className="kds-items">
        {ticket.items.map((i) => (
          <li key={i.menuItemId}>
            <strong>{i.quantity}×</strong> {i.name}
            {i.note && <span className="kds-note">{i.note}</span>}
          </li>
        ))}
      </ul>
      <footer className="served-meta">
        <span>
          {parcel ? 'Handed over' : 'Served'} by <strong>{ticket.servedByName || '—'}</strong>
        </span>
        <span>
          Ordered {formatTime(ticket.createdAt)}
          {ticket.createdByName && ` by ${ticket.createdByName}`} · took {took(ticket)}
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
            <strong>{tickets.length}</strong> order{tickets.length > 1 ? 's' : ''} · <strong>{dishes}</strong> dish{dishes > 1 ? 'es' : ''} · latest first
          </p>
          <div className="waiter-grid">
            {tickets.map((t) => (
              <ServedCard key={t.id} ticket={t} />
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
