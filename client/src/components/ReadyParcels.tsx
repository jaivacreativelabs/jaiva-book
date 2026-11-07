/** New Bill: parcels the kitchen marked Ready. Handed over when the customer collects one (the dispatch step). */
import type { KitchenTicketDTO } from '@rb/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Package } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api } from '../services/api';
import { markOwnAction } from '../hooks/useOrderChime';
import { useToast } from '../store/toast';
import { Spinner } from './ui';

export function ReadyParcels({ branchId }: { branchId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = ['parcels', branchId] as const;
  const parcels = useQuery({
    queryKey: key,
    queryFn: () => api.get<KitchenTicketDTO[]>('/kitchen/parcels'),
    refetchInterval: 4_000,
    refetchIntervalInBackground: true,
  });
  const [busy, setBusy] = useState<string | null>(null);

  // An order sent before payment can have two tickets; they share the token and go out together.
  const orders = new Map<string, KitchenTicketDTO[]>();
  for (const t of parcels.data ?? []) orders.set(t.draftId, [...(orders.get(t.draftId) ?? []), t]);
  if (orders.size === 0) return null;

  const handOver = async (draftId: string, tickets: KitchenTicketDTO[]) => {
    setBusy(draftId);
    try {
      for (const t of tickets) {
        markOwnAction(t.id); // no "handed over" sound on this screen for its own tap
        // Someone else handed it over already: it simply leaves the list.
        await api.post(`/kitchen/tickets/${t.id}/handed-over`).catch((err: unknown) => {
          if (!(err instanceof ApiError && err.code === 'CONFLICT')) throw err;
        });
      }
      queryClient.setQueryData<KitchenTicketDTO[]>(key, (list) => (list ?? []).filter((t) => t.draftId !== draftId));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <div className="parcel-strip" role="region" aria-label="Ready parcels">
      <span className="parcel-strip-title">
        <Package size={16} /> Ready parcels
      </span>
      {[...orders].map(([draftId, tickets]) => {
        const t = tickets[0];
        return (
          <div key={draftId} className="parcel-chip">
            <span>
              <strong>Parcel #{t.token ?? t.number.slice(-4)}</strong> ready
            </span>
            {t.billNumber && <span className="muted">Bill {t.billNumber}</span>}
            <button className="btn btn-primary btn-sm" onClick={() => void handOver(draftId, tickets)} disabled={busy !== null}>
              {busy === draftId ? <Spinner /> : <Check />} Handed over
            </button>
          </div>
        );
      })}
    </div>
  );
}
