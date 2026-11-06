/** Kitchen Display: the Send to Kitchen button used on table groups and the counter bill. */
import { ticketPlace, type KitchenTicketDTO, type OrderType } from '@rb/shared';
import { ChefHat } from 'lucide-react';
import { useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../store/toast';
import { Spinner } from './ui';

/**
 * Sends what was added since the group's last kitchen ticket. Resolves true when the request
 * worked. New Bill passes its Dine In / Take Away so a parcel is marked as one.
 */
export function useSendToKitchen() {
  const toast = useToast();
  const [sending, setSending] = useState(false);
  /** `quietIfNothing`: no message when everything was already sent (leaving a table's order with Done). */
  const send = async (draftId: string, sync?: { flushNow: () => Promise<void> } | null, orderType?: OrderType | null, { quietIfNothing = false } = {}) => {
    setSending(true);
    try {
      if (sync) await sync.flushNow();
      // One ticket per kitchen counter when the restaurant has counters.
      const tickets = await api.post<KitchenTicketDTO[]>(`/bills/${draftId}/kitchen`, orderType ? { orderType } : undefined);
      const [first] = tickets;
      if (first) {
        const where = tickets.some((t) => t.stationName) ? tickets.map((t) => t.stationName).join(' + ') : 'kitchen';
        const items = tickets.flatMap((t) => t.items.map((i) => `${i.quantity}× ${i.name}`)).join(', ');
        toast.success(`${first.tableLabel ? `Sent to ${where}` : `${ticketPlace(first)} sent`}: ${items}`);
      } else if (!quietIfNothing) toast.info('Nothing new – everything is already in the kitchen');
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      setSending(false);
    }
  };
  return { send, sending };
}

/** Kitchen Display branches: how much of the group's food still has to go to the kitchen. */
export function KitchenSendButton({ pending, sending, onSend }: { pending: number; sending: boolean; onSend: () => void }) {
  if (pending === 0) {
    return (
      <div className="kitchen-sent">
        <ChefHat size={15} /> All items sent to the kitchen
      </div>
    );
  }
  return (
    <button className="btn btn-secondary btn-block" onClick={onSend} disabled={sending}>
      {sending ? <Spinner /> : <ChefHat />} Send to Kitchen ({pending} new)
    </button>
  );
}
