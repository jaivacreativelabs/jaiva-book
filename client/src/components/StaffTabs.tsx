/** Waiter and Kitchen logins: their pages' tabs, and a group's kitchen state on the Tables page. */
import type { Role, TableGroupSummaryDTO } from '@rb/shared';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { cx } from '../utils/format';

const TABS: Partial<Record<Role, { to: string; label: string; end?: boolean }[]>> = {
  WAITER: [
    { to: '/waiter/order', label: 'Take Order' },
    { to: '/waiter', label: 'Ready to Serve', end: true },
    { to: '/served', label: 'Served' },
  ],
  KITCHEN: [
    { to: '/kitchen', label: 'Kitchen' },
    { to: '/served', label: 'Served' },
  ],
};

/** A waiter's or kitchen's phone has no sidebar, so their pages link here. */
export function StaffTabs() {
  const { user } = useAuth();
  const tabs = user && TABS[user.role];
  if (!tabs) return null;
  return (
    <nav className="tabs waiter-tabs" aria-label="Pages">
      {tabs.map(({ to, label, end }) => (
        <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('tab', isActive && 'active')}>
          {label}
        </NavLink>
      ))}
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
