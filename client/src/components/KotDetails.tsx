/**
 * KOT details: a small "KOTs" button beside the order's title that opens a mini popup with every
 * kitchen ticket of the order, oldest first – what went to the kitchen when, to which counter, by
 * whom, and where it is now (Sent → Served).
 */
import { isParcel, type KitchenStatus, type KitchenTicketDTO } from '@rb/shared';
import { useQuery } from '@tanstack/react-query';
import { ChefHat, Star } from 'lucide-react';
import { useState } from 'react';
import { api } from '../services/api';
import { cx, formatMoney, formatTime } from '../utils/format';
import { Modal } from './ui';

export const kotKey = (draftId: string) => ['kot', draftId] as const;

const STATUS: Record<KitchenStatus, [string, string]> = {
  NEW: ['Sent', 'badge-blue'],
  PREPARING: ['Preparing', 'badge-amber'],
  READY: ['Ready', 'badge-green'],
  SERVED: ['Served', 'badge-gray'],
  CANCELLED: ['Cancelled', 'badge-red'],
};

function KotCard({ ticket, index, prices }: { ticket: KitchenTicketDTO; index: number; prices: Map<string, number> }) {
  const [label, tone] = STATUS[ticket.status];
  const priced = ticket.items.every((i) => prices.has(i.menuItemId));
  const total = ticket.items.reduce((a, i) => a + (prices.get(i.menuItemId) ?? 0) * i.quantity, 0);
  return (
    <article className={cx('kot-card', ticket.priority && 'priority')} aria-label={`KOT ${index}`}>
      <header className="kot-head">
        <span className="kot-title">KOT {index}</span>
        <span className="kot-no">#{ticket.number}</span>
        {ticket.priority && <Star size={14} className="kds-star-on" aria-label="Priority" />}
        {ticket.stationName && <span className="kds-station">{ticket.stationName}</span>}
        <span className={cx('badge badge-sm kot-status', tone)}>{label}</span>
      </header>
      <ul className="kot-items">
        {ticket.items.map((i) => (
          <li key={i.menuItemId}>
            <span>
              <strong>{i.quantity}×</strong> {i.name}
              {i.note && <span className="kds-note">{i.note}</span>}
            </span>
            {prices.has(i.menuItemId) && <span className="num">{formatMoney(prices.get(i.menuItemId)! * i.quantity)}</span>}
          </li>
        ))}
      </ul>
      <footer className="kot-meta">
        <span>
          Sent {formatTime(ticket.createdAt)}
          {ticket.createdByName && ` by ${ticket.createdByName}`}
          {ticket.status === 'SERVED' && (
            <>
              {' · '}
              {isParcel(ticket) ? 'Handed over' : 'Served'} {formatTime(ticket.statusAt)}
              {ticket.servedByName && ` by ${ticket.servedByName}`}
            </>
          )}
        </span>
        {priced && <strong className="num">{formatMoney(total)}</strong>}
      </footer>
    </article>
  );
}

/** `prices`: the bill's current price per dish, to show what each KOT comes to. */
export function KotButton({ draftId, branchId, title, prices }: { draftId: string; branchId: string; title: string; prices: Map<string, number> }) {
  const [open, setOpen] = useState(false);
  const kots = useQuery({
    queryKey: kotKey(draftId),
    queryFn: () => api.get<KitchenTicketDTO[]>(`/bills/${draftId}/kitchen`, { branchId }),
    refetchInterval: 10_000,
  });
  const tickets = kots.data ?? [];
  return (
    <>
      <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => setOpen(true)}>
        <ChefHat size={16} /> KOT Details{tickets.length > 0 && ` (${tickets.length})`}
      </button>
      {open && (
        <Modal title={`KOTs · ${title}`} onClose={() => setOpen(false)} width={420}>
          {kots.isLoading ? (
            <p className="muted">Loading KOTs…</p>
          ) : kots.isError ? (
            <p className="muted">Could not load the KOTs.</p>
          ) : tickets.length === 0 ? (
            <p className="muted">Nothing sent to the kitchen yet. Each Send to Kitchen shows here as its own KOT.</p>
          ) : (
            <div className="kot-list">
              {tickets.map((t, i) => (
                <KotCard key={t.id} ticket={t} index={i + 1} prices={prices} />
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
