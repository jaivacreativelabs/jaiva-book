import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import type { RecordStatus, Role } from '@rb/shared';
import { env } from '../config/env.js';
import { UserModel } from '../models/index.js';
import { forbidden, unauthenticated } from '../utils/errors.js';

export const SESSION_COOKIE = 'rb_session';

export interface AuthUser {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: Role;
  status: RecordStatus;
  restaurantIds: Types.ObjectId[];
  branchIds: Types.ObjectId[];
  kitchenStationId?: Types.ObjectId | null;
  tokenVersion: number;
  lastLoginAt?: Date | null;
  createdAt?: Date;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

interface SessionClaims {
  sub: string;
  tv: number;
}

export function issueSession(res: Response, user: Pick<AuthUser, '_id' | 'tokenVersion'>): void {
  const token = jwt.sign({ sub: String(user._id), tv: user.tokenVersion } satisfies SessionClaims, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: Math.round(env.SESSION_TTL_HOURS * 3600),
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.COOKIE_SECURE,
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 3600 * 1000,
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: env.COOKIE_SECURE, path: '/' });
}

/** Verifies the session cookie and reloads the user from MongoDB on every request. */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || !token) throw unauthenticated();
  let claims: SessionClaims;
  try {
    claims = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as unknown as SessionClaims;
  } catch {
    clearSession(res);
    throw unauthenticated('Your session has expired. Please sign in again.');
  }
  const user = await UserModel.findById(claims.sub).lean<AuthUser>();
  if (!user || user.status !== 'ACTIVE' || user.tokenVersion !== claims.tv) {
    clearSession(res);
    throw unauthenticated('Your session is no longer valid. Please sign in again.');
  }
  // Kitchen logins may only use the kitchen board and their own session – everything else is
  // refused here, whatever a route would otherwise allow.
  if (user.role === 'KITCHEN' && !KITCHEN_ROUTES.some((r) => req.baseUrl.endsWith(r))) {
    throw forbidden('Kitchen logins can only open the Kitchen Display');
  }
  // Waiter logins likewise: the Waiter board, and taking table orders (exact calls only – the
  // services refuse waiters everything else on those routes too).
  if (user.role === 'WAITER' && !WAITER_ROUTES.some((r) => req.baseUrl.endsWith(r)) && !WAITER_CALLS.some((c) => isCall(req, c))) {
    throw forbidden('Waiter logins can only take table orders and open the Waiter board');
  }
  req.user = user;
  next();
}

const KITCHEN_ROUTES = ['/kitchen', '/auth'];
const WAITER_ROUTES = ['/waiter', '/auth'];
const ID = '[a-f0-9]{24}';
/** [method, router, path within it] a waiter may call to take an order for a table. */
const WAITER_CALLS: [string, string, RegExp][] = [
  ['GET', '/tables', /^\/?$/],
  ['GET', '/menu', /^\/(categories|items)$/],
  ['POST', '/bills', /^\/table-groups$/],
  ['GET', '/bills', new RegExp(`^/${ID}$`)],
  ['PUT', '/bills', new RegExp(`^/${ID}$`)],
  ['POST', '/bills', new RegExp(`^/${ID}/kitchen$`)],
];
const isCall = (req: Request, [method, router, path]: [string, string, RegExp]) =>
  req.method === method && req.baseUrl.endsWith(router) && path.test(req.path);

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthenticated();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}
