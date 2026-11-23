import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { requireRole, requireUsableTenant, tenantSession } from '../auth/guards.js';
import type { Role } from '../auth/roles.js';

/** Sessão válida + tenant utilizável (+ papel mínimo, se informado). */
export function guard(deps: Deps, minRole?: Role): preHandlerAsyncHookHandler[] {
  const list: preHandlerAsyncHookHandler[] = [tenantSession(deps.db, deps.config.cookieSecure), requireUsableTenant];
  if (minRole) list.push(requireRole(minRole));
  return list;
}

/** Só sessão (rotas que precisam funcionar com conta suspensa, ex.: cobrança, /me). */
export function sessionOnly(deps: Deps, minRole?: Role): preHandlerAsyncHookHandler[] {
  const list: preHandlerAsyncHookHandler[] = [tenantSession(deps.db, deps.config.cookieSecure)];
  if (minRole) list.push(requireRole(minRole));
  return list;
}

export const idParam = z.object({ id: z.string().uuid() });

export function params<T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> {
  return schema.parse(req.params);
}

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
