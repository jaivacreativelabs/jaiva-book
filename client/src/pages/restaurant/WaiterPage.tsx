/**
 * Waiter board: food the kitchen marked Ready, so waiters know what to carry to which table.
 * Tapping Served clears the ticket and records who served it. Parcels are not here: the
 * counter hands those over.
 */
import { ticketPlace, type KitchenTicketDTO } from '@rb/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, ConciergeBell, Star, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Loading, PageHeader, Spinner } from '../../components/ui';
import { ApiError, api, errorMessage } from '../../services/api';
import { useAuth } from '../../store/auth';
import { useToast } from '../../store/toast';
import { cx, formatDateTime } from '../../utils/format';
import { WaiterTabs } from './WaiterOrderPage';

const boardKey = (branchId: string) => ['waiter', branchId] as const;

/** Re-renders every 30 s so the waiting times stay current. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function ReadyCard({ ticket, branchId, now }: { ticket: KitchenTicketDTO; branchId: string; now: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const minutes = Math.max(0, Math.floor((now - new Date(ticket.statusAt).getTime()) / 60_000));
  const drop = () => queryClient.setQueryData<KitchenTicketDTO[]>(boardKey(branchId), (list) => (list ?? []).filter((t) => t.id !== ticket.id));

  const serve = async () => {
    setBusy(true);
    try {
      await api.post<KitchenTicketDTO>(`/waiter/tickets/${ticket.id}/served`);
      drop();
    } catch (err) {
      // Someone else served it already: it simply leaves the board.
      if (err instanceof ApiError && err.code === 'CONFLICT') drop();
      else toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={cx('kds-ticket waiter-ticket', ticket.priority && 'priority')} aria-label={`Ticket ${ticket.number}`}>
      <header className="kds-ticket-head">
        <div style={{ minWidth: 0 }}>
          <div className="waiter-where">{ticketPlace(ticket)}</div>
          <div className="kds-ticket-no">
            #{ticket.number}
            {ticket.priority && <Star size={15} className="kds-star-on" aria-label="Priority" />}
          </div>
        </div>
        <span className={cx('kds-timer', minutes >= 10 ? 'late' : minutes >= 5 && 'slow')} title={`Ready since ${formatDateTime(ticket.statusAt)}`}>
          <Timer size={13} /> {minutes < 1 ? 'now' : `${minutes}m`}
        </span>
      </header>
      <ul className="kds-items">
        {ticket.items.map((i) => (
          <li key={i.menuItemId}>
            <strong>{i.quantity}×</strong> {i.name}
          </li>
        ))}
      </ul>
      <button className="btn btn-primary btn-lg btn-block" onClick={() => void serve()} disabled={busy}>
        {busy ? <Spinner /> : <Check />} Served
      </button>
    </article>
  );
}

export function WaiterPage() {
  const { activeBranch } = useAuth();
  const branchId = activeBranch!.id;
  const now = useNow();
  const board = useQuery({
    queryKey: boardKey(branchId),
    queryFn: () => api.get<KitchenTicketDTO[]>('/waiter/tickets'),
    enabled: activeBranch!.kitchenDisplay,
    refetchInterval: 4_000,
    refetchIntervalInBackground: true,
  });

  if (!activeBranch!.kitchenDisplay) {
    return (
      <div className="page">
        <Empty icon={<ConciergeBell />} title="The Waiter board needs the Kitchen Display">
          Food shows here when the kitchen marks it Ready. The Super Admin can switch the Kitchen Display on under Restaurants › Bills &amp; Kitchen.
        </Empty>
      </div>
    );
  }

  const tickets = board.data ?? [];
  return (
    <div className="page">
      <WaiterTabs />
      <PageHeader title="Ready to Serve" subtitle="Food the kitchen has marked Ready · tap Served when it reaches the table" />
      {board.isLoading ? (
        <Loading label="Loading…" />
      ) : board.isError ? (
        <Empty title="Could not load the board">{errorMessage(board.error)}</Empty>
      ) : tickets.length === 0 ? (
        <Empty icon={<BellRing />} title="Nothing to serve right now">
          Orders appear here as soon as the kitchen marks them Ready.
        </Empty>
      ) : (
        <div className="waiter-grid">
          {tickets.map((t) => (
            <ReadyCard key={t.id} ticket={t} branchId={branchId} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
