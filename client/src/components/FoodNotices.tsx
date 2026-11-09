/**
 * Popups for food alerts, top right of every dashboard page: a new order (Kitchen) or food the
 * kitchen marked Ready (Waiter). Each shows where the food goes and its dishes; tapping one opens
 * the board, × closes it. They go by themselves after a while; at most four show at once.
 */
import { isParcel, ticketPlace, type KitchenTicketDTO } from '@rb/shared';
import { BellRing, ChefHat, Package, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { cx } from '../utils/format';

export type NoticeKind = 'order' | 'ready';
export interface Notice {
  key: number;
  kind: NoticeKind;
  ticket: KitchenTicketDTO;
}

export const NOTICE_MS = 15_000;
const MAX_LINES = 4;

export function FoodNotices({ notices, onClose }: { notices: Notice[]; onClose: (key: number) => void }) {
  const navigate = useNavigate();
  if (!notices.length) return null;
  return createPortal(
    <div className="food-notices" role="status" aria-live="polite">
      {notices.map(({ key, kind, ticket }) => {
        const more = ticket.items.length - MAX_LINES;
        const open = () => {
          onClose(key);
          navigate(kind === 'order' ? '/kitchen' : '/waiter');
        };
        return (
          <div key={key} className={cx('food-notice', kind)}>
            <button type="button" className="food-notice-body" onClick={open}>
              <span className="food-notice-icon" aria-hidden>
                {kind === 'order' ? <ChefHat size={20} /> : <BellRing size={20} />}
              </span>
              <span className="food-notice-text">
                <span className="food-notice-title">{kind === 'order' ? 'New order' : 'Food ready – take it to the table'}</span>
                <span className={cx('food-notice-place', isParcel(ticket) && 'parcel')}>
                  {isParcel(ticket) && <Package size={14} aria-hidden />}
                  {ticketPlace(ticket)}
                  {ticket.stationName && <span className="food-notice-station">{ticket.stationName}</span>}
                </span>
                <span className="food-notice-items">
                  {ticket.items.slice(0, MAX_LINES).map((i) => (
                    <span key={i.menuItemId}>
                      <strong>{i.quantity}×</strong> {i.name}
                      {i.note && <em> – {i.note}</em>}
                    </span>
                  ))}
                  {more > 0 && <span className="muted">+{more} more</span>}
                </span>
              </span>
            </button>
            <button type="button" className="food-notice-close" onClick={() => onClose(key)} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
