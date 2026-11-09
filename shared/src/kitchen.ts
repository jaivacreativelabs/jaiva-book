/** Kitchen Display helpers shared by the server and the billing screens. */
import type { KitchenTicketDTO } from './types.js';

/** A parcel: food packed to take away, handed over at the counter instead of served. */
export const isParcel = (t: Pick<KitchenTicketDTO, 'orderType'>) => t.orderType === 'TAKEAWAY';

/**
 * Where a ticket's food goes, with the order's number for the day: "Table T03 · Group 1 · Order T03-2"
 * (the 2nd customer at T03 today), "PARCEL · Token 12" or "Dine In · Token 5". (Older table tickets
 * have no Order no.)
 */
export function ticketPlace(t: Pick<KitchenTicketDTO, 'tableLabel' | 'groupName' | 'orderType' | 'token'>): string {
  if (t.tableLabel) return `Table ${t.tableLabel}${t.groupName ? ` · ${t.groupName}` : ''}${t.token ? ` · Order\u00a0${t.tableLabel}-${t.token}` /* no line break inside "Order T03-2" */ : ''}`;
  const kind = isParcel(t) ? 'PARCEL' : 'Dine In';
  return t.token ? `${kind} · Token ${t.token}` : kind;
}

export interface KitchenQty {
  menuItemId: string;
  quantity: number;
}

/** How many portions on the bill have not gone to the kitchen yet. */
export function kitchenPending(items: KitchenQty[], sent: KitchenQty[]): number {
  const done = new Map(sent.map((s) => [s.menuItemId, s.quantity]));
  return items.reduce((n, i) => n + Math.max(0, i.quantity - (done.get(i.menuItemId) ?? 0)), 0);
}
