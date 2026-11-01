/** Kitchen Display helpers shared by the server and the billing screens. */
import type { KitchenTicketDTO } from './types.js';

/** A parcel: food packed to take away, handed over at the counter instead of served. */
export const isParcel = (t: Pick<KitchenTicketDTO, 'orderType'>) => t.orderType === 'TAKEAWAY';

/** Where a ticket's food goes: "Table T03 · Group 1", "PARCEL · Token 12" or "Dine In · Token 5". */
export function ticketPlace(t: Pick<KitchenTicketDTO, 'tableLabel' | 'groupName' | 'orderType' | 'token'>): string {
  if (t.tableLabel) return `Table ${t.tableLabel}${t.groupName ? ` · ${t.groupName}` : ''}`;
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
