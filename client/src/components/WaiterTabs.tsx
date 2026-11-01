/** Waiter logins: the two pages' tabs, and a group's kitchen state on the Tables page. */
import type { TableGroupSummaryDTO } from '@rb/shared';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { cx } from '../utils/format';

/** Take Order | Ready to Serve – a waiter's phone has no sidebar, so the two pages link here. */
export function WaiterTabs() {
  const { user } = useAuth();
  if (user?.role !== 'WAITER') return null;
  return (
    <nav className="tabs waiter-tabs" aria-label="Waiter pages">
      <NavLink to="/waiter/order" className={({ isActive }) => cx('tab', isActive && 'active')}>
        Take Order
      </NavLink>
      <NavLink to="/waiter" end className={({ isActive }) => cx('tab', isActive && 'active')}>
        Ready to Serve
      </NavLink>
    </nav>
  );
}

const KITCHEN_LABEL: Record<NonNullable<TableGroupSummaryDTO['kitchenStatus']>, [string, string]> = {
  NEW: ['Sent', 'badge-blue'],
  PREPARING: ['Preparing', 'badge-amber'],
  READY: ['Ready', 'badge-green'],
};

/** What a group has in the kitchen (Sent / Preparing / Ready) and what has not been sent yet. */
export function KitchenBadges({ group }: { group: Pick<TableGroupSummaryDTO, 'kitchenStatus' | 'kitchenPending'> }) {
  if (!group.kitchenStatus && group.kitchenPending === 0) return null;
  return (
    <span className="waiter-badges">
      {group.kitchenStatus && <span className={cx('badge badge-sm', KITCHEN_LABEL[group.kitchenStatus][1])}>{KITCHEN_LABEL[group.kitchenStatus][0]}</span>}
      {group.kitchenPending > 0 && <span className="badge badge-sm badge-gray">{group.kitchenPending} not sent</span>}
    </span>
  );
}
