import type { AuthUser } from '../middleware/auth.js';
import { forbidden } from './errors.js';

/**
 * Billing, discounts, tables, the menu and the shop belong to the admins. Waiter and kitchen
 * logins only take and cook orders – checked here as well as by the routes they may call.
 */
export function assertAdmin(actor: Pick<AuthUser, 'role'>, message = 'Only a Restaurant Admin can do this'): void {
  if (actor.role !== 'RESTAURANT_ADMIN' && actor.role !== 'SUPER_ADMIN') throw forbidden(message);
}
