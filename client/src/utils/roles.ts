import type { Role } from '@rb/shared';

/** First page after sign-in for each account type. */
export const homeFor = (role: Role) =>
  role === 'SUPER_ADMIN' ? '/admin/restaurants' : role === 'KITCHEN' ? '/kitchen' : role === 'WAITER' ? '/waiter/order' : '/billing';

export const ROLE_LABEL: Record<Role, string> = { SUPER_ADMIN: 'Super Admin', RESTAURANT_ADMIN: 'Restaurant Admin', KITCHEN: 'Kitchen', WAITER: 'Waiter' };
