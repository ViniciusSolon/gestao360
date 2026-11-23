import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.js';
import { forbidden, paymentRequired, unauthorized } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { atLeast, type PlatformRole, type Role } from './roles.js';

/**
 * Nomes de cookie (SEC-12). Com HTTPS (cookieSecure) usam prefixos que o navegador
 * impõe: `__Host-` (Secure, Path=/, sem Domain — subdomínio não consegue
 * sobrescrever) para a sessão dos clientes e `__Secure-` para o painel (mantém o
 * Path restrito a /api/platform). Sem HTTPS (dev/teste) os prefixos não são aceitos
 * pelo navegador, então usamos os nomes simples.
 */
export function cookieNames(secure: boolean) {
  return {
    tenant: secure ? '__Host-g360_sid' : 'g360_sid',
    platform: secure ? '__Secure-g360_admin_sid' : 'g360_admin_sid',
    platformPath: '/api/platform',
  };
}
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const PLATFORM_SESSION_TTL_MS = 8 * 3600 * 1000;

export interface TenantAuth {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  role: Role;
  tenantName: string;
  tenantStatus: string;
  trialEndsAt: Date;
}

export interface PlatformAuth {
  adminId: string;
  email: string;
  name: string;
  role: PlatformRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: TenantAuth;
    platformAuth?: PlatformAuth;
  }
}

/** Carrega a sessão do tenant a partir do cookie. A sessão é sempre validada no banco. */
export function tenantSession(db: Db, secure: boolean) {
  const name = cookieNames(secure).tenant;
  return async function (req: FastifyRequest) {
    const token = req.cookies[name];
    if (!token) throw unauthorized();
    const row = await db.withAnon(async (c) => {
      const r = await c.query('SELECT * FROM auth_session_lookup($1)', [sha256(token)]);
      return r.rows[0];
    });
    if (!row) throw unauthorized('Sessão expirada');
    req.auth = {
      userId: row.user_id,
      tenantId: row.tenant_id,
      name: row.name,
      email: row.email,
      role: row.role,
      tenantName: row.tenant_name,
      tenantStatus: row.tenant_status,
      trialEndsAt: row.trial_ends_at,
    };
  };
}

/** Bloqueia tenants suspensos/cancelados e trial vencido (exceto rotas de cobrança). */
export function tenantIsUsable(auth: TenantAuth): { ok: true } | { ok: false; reason: string } {
  switch (auth.tenantStatus) {
    case 'active':
    case 'past_due':
      return { ok: true };
    case 'trialing':
      return new Date(auth.trialEndsAt).getTime() > Date.now()
        ? { ok: true }
        : { ok: false, reason: 'Período de teste encerrado. Assine um plano para continuar.' };
    case 'suspended':
      return { ok: false, reason: 'Conta suspensa. Fale com o suporte.' };
    default:
      return { ok: false, reason: 'Conta cancelada.' };
  }
}

export async function requireUsableTenant(req: FastifyRequest) {
  const auth = req.auth;
  if (!auth) throw unauthorized();
  const st = tenantIsUsable(auth);
  if (!st.ok) throw paymentRequired(st.reason);
}

export function requireRole(min: Role) {
  return async function (req: FastifyRequest) {
    if (!req.auth) throw unauthorized();
    if (!atLeast(req.auth.role, min)) throw forbidden();
  };
}

export function platformSession(db: Db, secure: boolean) {
  const name = cookieNames(secure).platform;
  return async function (req: FastifyRequest) {
    const token = req.cookies[name];
    if (!token) throw unauthorized();
    const row = await db.withPlatform(async (c) => {
      const r = await c.query(
        `SELECT a.id, a.email, a.name, a.role FROM platform_sessions s
           JOIN platform_admins a ON a.id = s.admin_id
          WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active`,
        [sha256(token)],
      );
      return r.rows[0];
    });
    if (!row) throw unauthorized('Sessão expirada');
    req.platformAuth = { adminId: row.id, email: row.email, name: row.name, role: row.role };
  };
}

export async function requireSuperadmin(req: FastifyRequest) {
  if (req.platformAuth?.role !== 'superadmin') throw forbidden('Apenas superadmin');
}

export function setSessionCookie(reply: FastifyReply, name: string, token: string, secure: boolean, maxAgeMs: number, path = '/') {
  reply.setCookie(name, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path,
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

/** Ajuda nas rotas: garante o contexto autenticado (tipado). */
export function authOf(req: FastifyRequest): TenantAuth {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
