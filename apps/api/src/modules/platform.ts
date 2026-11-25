import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import {
  cookieNames,
  PLATFORM_SESSION_TTL_MS,
  platformSession,
  requireSuperadmin,
  setSessionCookie,
} from '../auth/guards.js';
import { newToken, sha256, verifyPassword } from '../lib/crypto.js';
import { conflict, forbidden, notFound, unauthorized, unprocessable } from '../lib/errors.js';
import { throttle } from '../lib/throttle.js';
import { decryptSecret, normalizeRecoveryCode, verifyTotp } from '../lib/totp.js';
import { audit } from '../lib/limits.js';
import { assertTenantExists, issueOwnerAccessLink, provisionTenant } from '../lib/tenants.js';
import { idParam, params } from './common.js';

/**
 * Painel da PLATAFORMA (nossa equipe controlando os clientes).
 * - Autenticação separada (tabela platform_admins, cookie próprio com path restrito)
 *   com MFA TOTP obrigatório (login em duas etapas).
 * - Papel de banco separado (g360_platform), nunca acessível pela API dos tenants.
 * - Toda ação de escrita exige superadmin e gera audit_log.
 * - Em produção, rode com API_SURFACE=platform em host interno/VPN.
 */
const loginBody = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });
const mfaBody = z
  .object({
    challenge: z.string().min(20).max(200),
    code: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().min(8).max(20).optional(),
  })
  .refine((b) => !!b.code !== !!b.recoveryCode, 'Informe o código do autenticador OU um código de recuperação');
const statusBody = z.object({ status: z.enum(['active', 'suspended', 'canceled']), reason: z.string().trim().min(3).max(500) });
const planBody = z.object({ planCode: z.string().min(1).max(40), reason: z.string().trim().min(3).max(500) });
const newTenantBody = z.object({
  companyName: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use letras minúsculas, números e hífen'),
  ownerName: z.string().trim().min(1).max(120),
  ownerEmail: z.string().trim().toLowerCase().email().max(200),
  planCode: z.string().min(1).max(40),
});
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['trialing', 'active', 'past_due', 'suspended', 'canceled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export async function platformRoutes(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;
  const names = cookieNames(config.cookieSecure);
  const session = platformSession(db, config.cookieSecure);
  const pre = { preHandler: [session] };
  const preWrite = { preHandler: [session, requireSuperadmin] };
  const CHALLENGE_TTL_MS = 5 * 60 * 1000;
  const MAX_MFA_ATTEMPTS = 5;
  const loginLimits = (route: string, ip: string, email?: string) =>
    throttle(db.platform, [
      { key: `platform-${route}:ip:${ip}`, max: Math.max(1, Math.floor(config.AUTH_RATE_LIMIT_PER_MIN / 2)), windowSeconds: 60 },
      ...(email ? [{ key: `platform-${route}:email:${email}`, max: config.AUTH_EMAIL_LIMIT_PER_15MIN, windowSeconds: 900 }] : []),
    ]);

  /**
   * Etapa 1: e-mail + senha. NÃO cria sessão: devolve um desafio de uso único
   * (5 min, 5 tentativas) que só vira sessão com o código TOTP (SEC-09).
   */
  app.post('/auth/login', async (req) => {
    const b = loginBody.parse(req.body);
    await loginLimits('login', req.ip, b.email);
    const admin = (
      await db.platform.query('SELECT id, password_hash, active, totp_secret_enc FROM platform_admins WHERE lower(email) = $1', [b.email])
    ).rows[0];
    const ok = await verifyPassword(b.password, admin?.password_hash ?? null);
    if (!admin || !ok || !admin.active) throw unauthorized('E-mail ou senha inválidos');
    if (!admin.totp_secret_enc) {
      throw forbidden('MFA não configurado para este administrador. Peça para rodar platform:create-admin novamente.');
    }
    const challenge = newToken();
    await db.platform.query('INSERT INTO platform_login_challenges (token_hash, admin_id, expires_at) VALUES ($1, $2, $3)', [
      sha256(challenge), admin.id, new Date(Date.now() + CHALLENGE_TTL_MS),
    ]);
    return { mfaRequired: true, challenge };
  });

  /** Etapa 2: código do app autenticador OU código de recuperação → sessão. */
  app.post('/auth/mfa', async (req, reply) => {
    const b = mfaBody.parse(req.body);
    await loginLimits('mfa', req.ip);
    const challengeHash = sha256(b.challenge);
    // Conta a tentativa fora da transação, para valer mesmo se o código estiver errado
    const ch = (
      await db.platform.query(
        `UPDATE platform_login_challenges SET attempts = attempts + 1
          WHERE token_hash = $1 AND expires_at > now() RETURNING admin_id, attempts`,
        [challengeHash],
      )
    ).rows[0];
    const fail = () => unauthorized('Código inválido ou expirado');
    if (!ch || ch.attempts > MAX_MFA_ATTEMPTS) {
      if (ch) await db.platform.query('DELETE FROM platform_login_challenges WHERE token_hash = $1', [challengeHash]);
      throw fail();
    }

    const token = newToken();
    const method = await db.withPlatform(async (c) => {
      const admin = (await c.query('SELECT id, active, totp_secret_enc FROM platform_admins WHERE id = $1', [ch.admin_id])).rows[0];
      if (!admin?.active || !admin.totp_secret_enc) throw fail();
      let used: 'totp' | 'recovery';
      if (b.code) {
        const step = verifyTotp(decryptSecret(admin.totp_secret_enc, config.PLATFORM_MFA_KEY!), b.code);
        if (step === null) throw fail();
        // Anti-replay atômico: o mesmo código (passo) não vale duas vezes
        const upd = await c.query(
          'UPDATE platform_admins SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)',
          [admin.id, step],
        );
        if (!upd.rowCount) throw fail();
        used = 'totp';
      } else {
        const upd = await c.query(
          'UPDATE platform_recovery_codes SET used_at = now() WHERE admin_id = $1 AND code_hash = $2 AND used_at IS NULL',
          [admin.id, sha256(normalizeRecoveryCode(b.recoveryCode!))],
        );
        if (!upd.rowCount) throw fail();
        used = 'recovery';
      }
      // Desafio de uso único: só quem conseguir apagá-lo cria a sessão
      const del = await c.query('DELETE FROM platform_login_challenges WHERE token_hash = $1 RETURNING admin_id', [challengeHash]);
      if (!del.rowCount) throw fail();
      await c.query('INSERT INTO platform_sessions (token_hash, admin_id, expires_at) VALUES ($1, $2, $3)', [
        sha256(token), admin.id, new Date(Date.now() + PLATFORM_SESSION_TTL_MS),
      ]);
      await audit(c, { tenantId: null, actorType: 'platform_admin', actorId: admin.id, action: 'platform.login', metadata: { mfa: used }, ip: req.ip });
      return used;
    });
    setSessionCookie(reply, names.platform, token, config.cookieSecure, PLATFORM_SESSION_TTL_MS, names.platformPath);
    return { ok: true, method };
  });

  app.post('/auth/logout', pre, async (req, reply) => {
    await db.platform.query('DELETE FROM platform_sessions WHERE token_hash = $1', [sha256(req.cookies[names.platform]!)]);
    reply.clearCookie(names.platform, { path: names.platformPath });
    return { ok: true };
  });

  app.get('/me', pre, async (req) => req.platformAuth);

  app.get('/metrics', pre, async () => {
    const r = (
      await db.platform.query(`
        SELECT
          count(*) AS tenants,
          count(*) FILTER (WHERE t.status = 'active')    AS active,
          count(*) FILTER (WHERE t.status = 'trialing')  AS trialing,
          count(*) FILTER (WHERE t.status = 'past_due')  AS past_due,
          count(*) FILTER (WHERE t.status = 'suspended') AS suspended,
          count(*) FILTER (WHERE t.status = 'canceled')  AS canceled,
          count(*) FILTER (WHERE t.created_at > now() - interval '30 days') AS new_30d,
          coalesce(sum(p.price_cents) FILTER (WHERE t.status IN ('active','past_due')), 0) AS mrr_cents,
          coalesce(sum(t.seats_used), 0) AS seats,
          coalesce(sum(t.leads_count), 0) AS leads
        FROM tenants t JOIN plans p ON p.id = t.plan_id`)
    ).rows[0];
    const signups = (
      await db.platform.query(`
        SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week, count(*) AS n
          FROM tenants WHERE created_at > now() - interval '12 weeks' GROUP BY 1 ORDER BY 1`)
    ).rows;
    return {
      ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])),
      signupsByWeek: signups.map((s) => ({ week: s.week, n: Number(s.n) })),
    };
  });

  app.get('/plans', pre, async () => (await db.platform.query('SELECT code, name, price_cents, max_users, max_leads, public FROM plans ORDER BY price_cents')).rows);

  app.get('/tenants', pre, async (req) => {
    const f = listQuery.parse(req.query);
    const pageSize = 50;
    const r = await db.platform.query(
      `SELECT t.id, t.name, t.slug, t.status, t.seats_used, t.leads_count, t.trial_ends_at, t.created_at,
              p.code AS plan_code, p.name AS plan_name, p.max_users, p.price_cents,
              coalesce(
                (SELECT email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner'),
                (SELECT email FROM invites i WHERE i.tenant_id = t.id AND i.role = 'owner' AND i.accepted_at IS NULL
                    AND i.revoked_at IS NULL ORDER BY i.created_at DESC LIMIT 1)) AS owner_email,
              NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner') AS owner_pending,
              (SELECT max(s.created_at) FROM sessions s WHERE s.tenant_id = t.id) AS last_login_at
         FROM tenants t JOIN plans p ON p.id = t.plan_id
        WHERE ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR t.status = $2)
        ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`,
      [f.q ?? null, f.status ?? null, pageSize, (f.page - 1) * pageSize],
    );
    return r.rows;
  });

  app.get('/tenants/:id', pre, async (req) => {
    const { id } = params(idParam, req);
    const t = (
      await db.platform.query(
        `SELECT t.*, p.code AS plan_code, p.name AS plan_name, p.max_users, p.max_leads, p.price_cents
           FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
        [id],
      )
    ).rows[0];
    if (!t) throw notFound('Cliente não encontrado');
    const [users, sub, auditRows, usage, pendingOwner] = await Promise.all([
      db.platform.query('SELECT id, name, email, role, active, created_at FROM users WHERE tenant_id = $1 ORDER BY role, name', [id]),
      db.platform.query('SELECT provider_subscription_id, status, current_period_end, updated_at FROM subscriptions WHERE tenant_id = $1', [id]),
      db.platform.query('SELECT actor_type, action, target_type, metadata, created_at FROM audit_log WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
      db.platform.query(
        `SELECT (SELECT count(*) FROM proposals WHERE tenant_id = $1) AS proposals,
                (SELECT count(*) FROM activities WHERE tenant_id = $1) AS activities,
                (SELECT count(*) FROM leads WHERE tenant_id = $1 AND status = 'won') AS won`,
        [id],
      ),
      db.platform.query(
        `SELECT name, email, expires_at, created_at FROM invites
          WHERE tenant_id = $1 AND role = 'owner' AND accepted_at IS NULL AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [id],
      ),
    ]);
    // Dados de negócio do cliente (leads, valores) NÃO são expostos aqui: só metadados de uso (LGPD)
    return {
      tenant: t,
      users: users.rows,
      subscription: sub.rows[0] ?? null,
      // Responsável que ainda não definiu a senha (link pendente)
      pendingOwner: users.rows.some((u) => u.role === 'owner') ? null : (pendingOwner.rows[0] ?? null),
      audit: auditRows.rows,
      usage: Object.fromEntries(Object.entries(usage.rows[0]).map(([k, v]) => [k, Number(v)])),
    };
  });

  app.post('/tenants/:id/status', preWrite, async (req) => {
    const { id } = params(idParam, req);
    const b = statusBody.parse(req.body);
    return db.withPlatform(async (c) => {
      const r = await c.query(
        `UPDATE tenants SET status = $2, suspended_reason = CASE WHEN $2 = 'suspended' THEN $3 ELSE NULL END
          WHERE id = $1 RETURNING id, status`,
        [id, b.status, b.reason],
      );
      if (!r.rowCount) throw notFound('Cliente não encontrado');
      await audit(c, { tenantId: id, actorType: 'platform_admin', actorId: req.platformAuth!.adminId, action: 'platform.tenant_status', metadata: b, ip: req.ip });
      return r.rows[0];
    });
  });

  app.post('/tenants/:id/plan', preWrite, async (req) => {
    const { id } = params(idParam, req);
    const b = planBody.parse(req.body);
    return db.withPlatform(async (c) => {
      const plan = (await c.query('SELECT id, max_users FROM plans WHERE code = $1', [b.planCode])).rows[0];
      if (!plan) throw unprocessable('Plano inexistente');
      const r = await c.query('UPDATE tenants SET plan_id = $2 WHERE id = $1 RETURNING id, seats_used', [id, plan.id]);
      if (!r.rowCount) throw notFound('Cliente não encontrado');
      await audit(c, { tenantId: id, actorType: 'platform_admin', actorId: req.platformAuth!.adminId, action: 'platform.tenant_plan', metadata: b, ip: req.ip });
      return { ok: true, overSeatLimit: r.rows[0].seats_used > plan.max_users };
    });
  });

  /**
   * Cadastra uma empresa cliente (só a plataforma faz isso; não há cadastro público).
   * Devolve o link para o responsável definir a senha — também enviado por e-mail.
   */
  app.post('/tenants', preWrite, async (req, reply) => {
    const b = newTenantBody.parse(req.body);
    try {
      const r = await db.withPlatform((c) => provisionTenant(c, b, config.APP_PUBLIC_URL, req.platformAuth!.adminId));
      return reply.status(201).send({ tenantId: r.tenantId, accessUrl: r.url });
    } catch (e) {
      // Mensagens claras para os conflitos garantidos pelo banco (o painel é interno)
      const pg = e as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'tenants_slug_key') throw conflict('Identificador já está em uso por outro cliente', 'slug_in_use');
      if (pg.code === '23505' && pg.constraint === 'invites_pending_owner_email_uq') {
        throw conflict('Este e-mail já é responsável de outro cliente aguardando definir a senha', 'email_in_use');
      }
      throw e;
    }
  });

  /** Gera um novo link de acesso para o responsável (o anterior deixa de valer). */
  app.post('/tenants/:id/owner-link', preWrite, async (req) => {
    const { id } = params(idParam, req);
    return db.withPlatform(async (c) => {
      await assertTenantExists(c, id);
      const owner = await c.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND role = 'owner'`, [id]);
      if (owner.rowCount) throw conflict('Esta empresa já tem responsável com senha definida', 'owner_exists');
      // O link mais recente (mesmo vencido) diz para quem gerar o novo
      const pending = (
        await c.query(
          `SELECT name, email FROM invites WHERE tenant_id = $1 AND role = 'owner' AND accepted_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          [id],
        )
      ).rows[0];
      if (!pending) throw unprocessable('Não há responsável aguardando definir senha', 'no_pending_owner');
      const r = await issueOwnerAccessLink(c, id, { name: pending.name, email: pending.email }, config.APP_PUBLIC_URL, req.platformAuth!.adminId);
      return { accessUrl: r.url };
    });
  });

  app.get('/audit', pre, async (req) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid().optional() }).parse(req.query);
    const r = await db.platform.query(
      `SELECT a.id, a.tenant_id, t.name AS tenant_name, a.actor_type, a.actor_id, a.action, a.metadata, a.ip, a.created_at
         FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id
        WHERE ($1::uuid IS NULL OR a.tenant_id = $1) ORDER BY a.created_at DESC LIMIT 200`,
      [tenantId ?? null],
    );
    return r.rows;
  });
}
