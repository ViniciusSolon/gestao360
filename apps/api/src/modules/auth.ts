import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { hashPassword, newToken, sha256, verifyPassword } from '../lib/crypto.js';
import { conflict, gone, unauthorized } from '../lib/errors.js';
import { audit, consumeSeat } from '../lib/limits.js';
import { throttle } from '../lib/throttle.js';
import {
  SESSION_TTL_MS,
  cookieNames,
  authOf,
  setSessionCookie,
  tenantIsUsable,
} from '../auth/guards.js';
import { sessionOnly } from './common.js';
import type { Client } from '../db/db.js';

const password = z.string().min(10, 'A senha precisa ter ao menos 10 caracteres').max(200);
const email = z.string().trim().toLowerCase().email().max(200);

const signupBody = z.object({
  companyName: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use letras minúsculas, números e hífen'),
  name: z.string().trim().min(1).max(120),
  email,
  password,
});

const loginBody = z.object({ email, password: z.string().min(1).max(200) });
const acceptBody = z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(1).max(120), password });

export const DEFAULT_STAGES: [string, number, 'open' | 'won' | 'lost'][] = [
  ['Novo lead', 10, 'open'],
  ['Qualificado', 25, 'open'],
  ['Proposta enviada', 50, 'open'],
  ['Negociação', 75, 'open'],
  ['Ganho', 100, 'won'],
  ['Perdido', 0, 'lost'],
];

async function createSession(c: Client, tenantId: string, userId: string) {
  const token = newToken();
  await c.query(`INSERT INTO sessions (token_hash, tenant_id, user_id, expires_at) VALUES ($1, $2, $3, $4)`, [
    sha256(token),
    tenantId,
    userId,
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  return token;
}

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;
  const TENANT_COOKIE = cookieNames(config.cookieSecure).tenant;
  // Rate limit no Postgres por IP e por e-mail (SEC-08/SEC-10)
  const limits = (route: string, ip: string, email?: string) =>
    throttle(db.app, [
      { key: `${route}:ip:${ip}`, max: config.AUTH_RATE_LIMIT_PER_MIN, windowSeconds: 60 },
      ...(email ? [{ key: `${route}:email:${email}`, max: config.AUTH_EMAIL_LIMIT_PER_15MIN, windowSeconds: 900 }] : []),
    ]);

  app.post('/auth/signup', async (req, reply) => {
    const b = signupBody.parse(req.body);
    await limits('signup', req.ip, b.email);
    const tenantId = randomUUID();
    const pwHash = await hashPassword(b.password);
    const { token, userId } = await db.withTenant(tenantId, async (c) => {
      const plan = (await c.query(`SELECT id FROM plans WHERE code = 'starter'`)).rows[0];
      await c.query(`INSERT INTO tenants (id, name, slug, plan_id) VALUES ($1, $2, $3, $4)`, [tenantId, b.companyName, b.slug, plan.id]);
      const u = await c.query(
        `INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'owner') RETURNING id`,
        [tenantId, b.name, b.email, pwHash],
      );
      const userId = u.rows[0].id as string;
      await consumeSeat(c);
      for (const [i, [name, prob, kind]] of DEFAULT_STAGES.entries()) {
        await c.query(`INSERT INTO pipeline_stages (tenant_id, name, position, probability, kind) VALUES ($1, $2, $3, $4, $5)`, [
          tenantId,
          name,
          i,
          prob,
          kind,
        ]);
      }
      await audit(c, { tenantId, actorType: 'user', actorId: userId, action: 'tenant.signup', ip: req.ip });
      return { token: await createSession(c, tenantId, userId), userId };
    });
    setSessionCookie(reply, TENANT_COOKIE, token, config.cookieSecure, SESSION_TTL_MS);
    return reply.status(201).send({ tenantId, userId });
  });

  app.post('/auth/login', async (req, reply) => {
    const b = loginBody.parse(req.body);
    await limits('login', req.ip, b.email);
    const user = await db.withAnon(async (c) => (await c.query('SELECT * FROM auth_login_lookup($1)', [b.email])).rows[0]);
    const ok = await verifyPassword(b.password, user?.password_hash ?? null);
    if (!user || !ok || !user.active) throw unauthorized('E-mail ou senha inválidos');
    const token = await db.withTenant(user.tenant_id, async (c) => {
      await audit(c, { tenantId: user.tenant_id, actorType: 'user', actorId: user.user_id, action: 'user.login', ip: req.ip });
      return createSession(c, user.tenant_id, user.user_id);
    });
    setSessionCookie(reply, TENANT_COOKIE, token, config.cookieSecure, SESSION_TTL_MS);
    return { ok: true };
  });

  app.post('/auth/logout', { preHandler: sessionOnly(deps) }, async (req, reply) => {
    const auth = authOf(req);
    const token = req.cookies[TENANT_COOKIE]!;
    await db.withAuth(auth, (c) => c.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]));
    reply.clearCookie(TENANT_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: sessionOnly(deps) }, async (req) => {
    const a = authOf(req);
    const usable = tenantIsUsable(a);
    return {
      user: { id: a.userId, name: a.name, email: a.email, role: a.role },
      tenant: {
        id: a.tenantId,
        name: a.tenantName,
        status: a.tenantStatus,
        trialEndsAt: a.trialEndsAt,
        usable: usable.ok,
        blockedReason: usable.ok ? null : usable.reason,
      },
    };
  });

  app.post('/auth/accept-invite', async (req, reply) => {
    const b = acceptBody.parse(req.body);
    await limits('accept-invite', req.ip);
    const tokenHash = sha256(b.token);
    const inv = await db.withAnon(async (c) => (await c.query('SELECT * FROM auth_invite_lookup($1)', [tokenHash])).rows[0]);
    if (!inv) throw gone('Convite inválido, expirado ou já utilizado');
    const pwHash = await hashPassword(b.password);
    const token = await db.withTenant(inv.tenant_id, async (c) => {
      // Operação atômica: só um aceite "vence"; o segundo não encontra linha pendente
      const upd = await c.query(
        `UPDATE invites SET accepted_at = now()
          WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          RETURNING id`,
        [inv.invite_id],
      );
      if (!upd.rowCount) throw conflict('Convite já utilizado', 'invite_used');
      await consumeSeat(c);
      const u = await c.query(
        `INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [inv.tenant_id, b.name, inv.email, pwHash, inv.role],
      );
      await audit(c, { tenantId: inv.tenant_id, actorType: 'user', actorId: u.rows[0].id, action: 'invite.accepted', targetId: inv.invite_id, ip: req.ip });
      return createSession(c, inv.tenant_id, u.rows[0].id);
    });
    setSessionCookie(reply, TENANT_COOKIE, token, config.cookieSecure, SESSION_TTL_MS);
    return reply.status(201).send({ ok: true });
  });
}
