import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Client } from '../db/db.js';
import { authOf, type TenantAuth } from '../auth/guards.js';
import { atLeast, rank, type Role } from '../auth/roles.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { newToken, sha256 } from '../lib/crypto.js';
import { isValidCpf } from '../lib/cpf.js';
import { audit, consumeSeat, releaseSeat } from '../lib/limits.js';
import { enqueue } from '../jobs/queue.js';
import { guard, idParam, params } from './common.js';
import { MAX_IMAGE_BYTES, sniffImage } from './products.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const assignableRole = z.enum(['admin', 'manager', 'seller']);
export const DEFAULT_PROFILES: [string, 'admin' | 'manager' | 'seller'][] = [
  ['Administrador', 'admin'],
  ['Gerente', 'manager'],
  ['Vendedor', 'seller'],
];

// ---------------------------------------------------------------------------
// Campos do cadastro (sem padrões: servem para criar e para editar em parte)
// ---------------------------------------------------------------------------
const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
const digits = (min: number, max: number, msg: string) =>
  z.string().trim().transform((v) => v.replace(/\D/g, '')).refine((v) => v === '' || (v.length >= min && v.length <= max), msg).transform((v) => v || null);
const httpsUrl = (msg: string) =>
  z.string().trim().max(300).transform((v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v)).refine((v) => v === '' || /^https:\/\/[^\s]+\.[^\s]+/.test(v), msg).transform((v) => v || null);
const dateStr = z.string().date().refine((v) => v >= '1900-01-01' && v <= '2100-01-01', 'Data fora do intervalo');

const profileFields = {
  nickname: opt(z.string().trim().max(60).transform((v) => v || null)),
  mobile: opt(digits(10, 13, 'Celular: DDD + número')),
  phone: opt(digits(10, 13, 'Telefone: DDD + número')),
  cpf: opt(digits(11, 11, 'CPF deve ter 11 dígitos').refine((v) => v === null || isValidCpf(v), 'CPF inválido')),
  birthDate: opt(dateStr),
  linkedinUrl: opt(httpsUrl('LinkedIn: informe o endereço do perfil')),
  meetingUrl: opt(httpsUrl('Link de reunião inválido')),
  color: opt(z.string().trim().toLowerCase().regex(/^#[0-9a-f]{6}$/, 'Cor inválida')),
  departmentId: opt(z.string().uuid()),
  admissionDate: opt(dateStr),
  reportsTo: opt(z.string().uuid()),
  bio: opt(z.string().trim().max(1000).transform((v) => v || null)),
  squadIds: z.array(z.string().uuid()).max(30).optional(),
};
const STATUS = z.enum(['active', 'third_party', 'inactive']);

const createUserBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(120),
  profileId: z.string().uuid(),
  thirdParty: z.boolean().optional(),
  ...profileFields,
});
const patchUser = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: assignableRole.optional(), // compatibilidade: troca direta de nível (sem perfil)
  active: z.boolean().optional(),
  status: STATUS.optional(),
  profileId: opt(z.string().uuid()),
  ...profileFields,
});
const inviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  role: assignableRole,
  name: z.string().trim().max(120).optional().transform((v) => v || null),
});

/** Coluna do banco para cada campo do cadastro. */
const COLUMN: Record<string, string> = {
  nickname: 'nickname', mobile: 'mobile', phone: 'phone', cpf: 'cpf', birthDate: 'birth_date', linkedinUrl: 'linkedin_url',
  meetingUrl: 'meeting_url', color: 'color', departmentId: 'department_id', admissionDate: 'admission_date', reportsTo: 'reports_to', bio: 'bio',
};
/** Dados pessoais que só o próprio usuário e administradores veem (LGPD). */
const PRIVATE = ['cpf', 'birth_date', 'phone'];

const USER_SELECT = `
  SELECT u.id, u.name, u.nickname, u.email, u.role, u.active, u.is_third_party, u.color, u.mobile, u.phone, u.cpf, u.birth_date,
         u.linkedin_url, u.meeting_url, u.department_id, d.name AS department_name, u.profile_id, p.name AS profile_name,
         u.admission_date, u.reports_to, m.name AS reports_to_name, u.bio, u.created_at, av.updated_at AS avatar_updated_at,
         coalesce((SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
                     FROM user_squads us JOIN squads s ON s.id = us.squad_id WHERE us.user_id = u.id), '[]') AS squads
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN user_profiles p ON p.id = u.profile_id
    LEFT JOIN users m ON m.id = u.reports_to
    LEFT JOIN user_avatars av ON av.user_id = u.id`;

function present(a: TenantAuth, u: Record<string, unknown>) {
  const status = !u.active ? 'inactive' : u.is_third_party ? 'third_party' : 'active';
  const out: Record<string, unknown> = { ...u, status };
  if (!atLeast(a.role, 'admin') && u.id !== a.userId) for (const k of PRIVATE) delete out[k];
  return out;
}

/** Trava por empresa para mudanças em "reporta a" (evita ciclo A→B e B→A ao mesmo tempo). */
async function lockOrgChart(c: Client, tenantId: string) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('org-chart:' || $1))`, [tenantId]);
}
/** "Reporta a" não pode formar ciclo (A reporta a B que reporta a A). */
async function assertNoCycle(c: Client, userId: string, managerId: string) {
  if (managerId === userId) throw unprocessable('A pessoa não pode reportar a si mesma', 'reports_to_cycle');
  const r = await c.query(
    `WITH RECURSIVE chain(id, depth) AS (
        SELECT reports_to, 1 FROM users WHERE id = $1
        UNION ALL
        SELECT u.reports_to, depth + 1 FROM users u JOIN chain ON u.id = chain.id WHERE chain.id IS NOT NULL AND depth < 100)
     SELECT 1 FROM chain WHERE id = $2 LIMIT 1`,
    [managerId, userId],
  );
  if (r.rowCount) throw unprocessable('Isso criaria um ciclo no organograma (um reporta ao outro)', 'reports_to_cycle');
}

/** Grava os campos do cadastro presentes em `b` (undefined = não mexe). */
async function applyFields(c: Client, a: TenantAuth, userId: string, b: Record<string, unknown>) {
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  for (const [k, col] of Object.entries(COLUMN)) {
    if (b[k] === undefined) continue;
    vals.push(b[k]);
    sets.push(`${col} = $${vals.length}`);
  }
  if (b.reportsTo) {
    await lockOrgChart(c, a.tenantId);
    const m = (await c.query('SELECT 1 FROM users WHERE id = $1', [b.reportsTo])).rowCount;
    if (!m) throw unprocessable('Gestor ("reporta a") não encontrado', 'invalid_reports_to');
    await assertNoCycle(c, userId, b.reportsTo as string);
  }
  try {
    await c.query('SAVEPOINT user_fields');
    if (sets.length) await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (Array.isArray(b.squadIds)) {
      await c.query('DELETE FROM user_squads WHERE user_id = $1', [userId]);
      if (b.squadIds.length) {
        await c.query(`INSERT INTO user_squads (tenant_id, user_id, squad_id) SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`, [
          a.tenantId, userId, [...new Set(b.squadIds as string[])],
        ]);
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code === '23503') {
      await c.query('ROLLBACK TO SAVEPOINT user_fields');
      throw unprocessable('Departamento ou squad não encontrado', 'invalid_reference');
    }
    throw e;
  }
}

/** Cria convite (o usuário nasce quando a pessoa aceita e define a senha). */
async function createInvite(
  deps: Deps, c: Client, a: TenantAuth, ip: string,
  inv: { email: string; name: string | null; role: Role; profileId?: string | null; details?: Record<string, unknown> },
) {
  const token = newToken();
  const url = `${deps.config.APP_PUBLIC_URL}/convite?token=${encodeURIComponent(token)}`;
  const exists = (await c.query('SELECT 1 FROM users WHERE lower(email) = $1', [inv.email])).rowCount;
  if (exists) throw conflict('Já existe um usuário com este e-mail nesta empresa', 'user_exists');
  // Convites pendentes vencidos não bloqueiam um novo convite
  await c.query(
    `UPDATE invites SET revoked_at = now()
      WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
    [inv.email],
  );
  // Índice único parcial impede dois convites pendentes para o mesmo e-mail
  let row;
  try {
    await c.query('SAVEPOINT invite_ins');
    row = (
      await c.query(
        `INSERT INTO invites (tenant_id, email, name, role, token_hash, expires_at, created_by, profile_id, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, email, name, role, expires_at`,
        [a.tenantId, inv.email, inv.name, inv.role, sha256(token), new Date(Date.now() + INVITE_TTL_MS), a.userId, inv.profileId ?? null, JSON.stringify(inv.details ?? {})],
      )
    ).rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      await c.query('ROLLBACK TO SAVEPOINT invite_ins');
      throw conflict('Já existe um convite pendente para este e-mail', 'invite_pending');
    }
    throw e;
  }
  await enqueue(c, {
    type: 'email.invite',
    tenantId: a.tenantId,
    payload: { to: inv.email, tenantName: a.tenantName, inviterName: a.name, url },
    dedupeKey: `email:invite:${row.id}`,
  });
  await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'invite.created', targetType: 'invite', targetId: row.id, ip });
  return { ...row, url };
}

/**
 * Aplica o cadastro guardado no convite ao usuário recém-criado (no aceite).
 * Referências apagadas nesse meio tempo (departamento, squad, gestor) são ignoradas.
 */
export async function applyInviteDetails(c: Client, tenantId: string, userId: string, inviteId: string) {
  const inv = (await c.query('SELECT details, profile_id FROM invites WHERE id = $1', [inviteId])).rows[0];
  if (!inv) return;
  const d = inv.details ?? {};
  await c.query(
    `UPDATE users SET
        profile_id = (SELECT id FROM user_profiles WHERE id = $2),
        nickname = $3, mobile = $4, phone = $5, cpf = $6, birth_date = $7, linkedin_url = $8, meeting_url = $9, color = $10,
        department_id = (SELECT id FROM departments WHERE id = $11), admission_date = $12,
        reports_to = (SELECT id FROM users WHERE id = $13 AND id <> $1), bio = $14, is_third_party = coalesce($15, false)
      WHERE id = $1`,
    [userId, inv.profile_id, d.nickname ?? null, d.mobile ?? null, d.phone ?? null, d.cpf ?? null, d.birthDate ?? null, d.linkedinUrl ?? null,
      d.meetingUrl ?? null, d.color ?? null, d.departmentId ?? null, d.admissionDate ?? null, d.reportsTo ?? null, d.bio ?? null, d.thirdParty ?? null],
  );
  if (Array.isArray(d.squadIds) && d.squadIds.length) {
    await c.query(
      `INSERT INTO user_squads (tenant_id, user_id, squad_id) SELECT $1, $2, s.id FROM squads s WHERE s.id = ANY($3::uuid[]) ON CONFLICT DO NOTHING`,
      [tenantId, userId, d.squadIds],
    );
  }
}

export async function userRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  app.get('/users', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) => (await c.query(`${USER_SELECT} ORDER BY u.name`)).rows.map((u) => present(a, u)));
  });

  app.get('/users/:id', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const u = (await c.query(`${USER_SELECT} WHERE u.id = $1`, [id])).rows[0];
      if (!u) throw notFound('Usuário não encontrado');
      return present(a, u);
    });
  });

  /** "Novo usuário": cadastro completo + convite por e-mail para a pessoa definir a senha. */
  app.post('/users', { preHandler: guard(deps, 'admin') }, async (req, reply) => {
    const a = authOf(req);
    const b = createUserBody.parse(req.body);
    const res = await db.withAuth(a, async (c) => {
      const profile = (await c.query('SELECT id, role FROM user_profiles WHERE id = $1', [b.profileId])).rows[0];
      if (!profile) throw unprocessable('Perfil não encontrado', 'invalid_profile');
      if (rank(profile.role) > rank(a.role)) throw forbidden('Não é possível dar acesso acima do seu');
      if (b.departmentId && !(await c.query('SELECT 1 FROM departments WHERE id = $1', [b.departmentId])).rowCount) throw unprocessable('Departamento não encontrado', 'invalid_reference');
      if (b.reportsTo && !(await c.query('SELECT 1 FROM users WHERE id = $1', [b.reportsTo])).rowCount) throw unprocessable('Gestor ("reporta a") não encontrado', 'invalid_reports_to');
      if (b.squadIds?.length) {
        const n = (await c.query('SELECT count(*) FROM squads WHERE id = ANY($1::uuid[])', [b.squadIds])).rows[0].count;
        if (Number(n) !== new Set(b.squadIds).size) throw unprocessable('Squad não encontrado', 'invalid_reference');
      }
      const { email, name, profileId, ...details } = b;
      return createInvite(deps, c, a, req.ip, { email, name, role: profile.role, profileId, details });
    });
    return reply.status(201).send(res);
  });

  app.patch('/users/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const b = patchUser.parse(req.body);
    const status = b.status ?? (b.active === undefined ? undefined : b.active ? 'active' : 'inactive');
    return db.withAuth(a, async (c) => {
      // Trava do organograma ANTES da trava da linha: duas edições de "reporta a"
      // ao mesmo tempo ficam em fila em vez de travarem uma à outra (deadlock)
      if (b.reportsTo) await lockOrgChart(c, a.tenantId);
      // Lock da linha: decisão (papel/ativo) e escrita sobre o mesmo estado
      const target = (await c.query('SELECT id, role, active, is_third_party FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!target) throw notFound('Usuário não encontrado');
      const self = target.id === a.userId;
      const isOwner = target.role === 'owner';
      if (isOwner && !self) throw forbidden('O proprietário da conta não pode ser alterado aqui');
      if (rank(target.role as Role) > rank(a.role)) throw forbidden();
      const changesAccess = status !== undefined || b.role !== undefined || (b.profileId !== undefined && !isOwner);
      if (changesAccess && self) throw forbidden('Você não pode alterar o próprio acesso');
      if (changesAccess && isOwner) throw forbidden('O acesso do proprietário não muda');
      if (b.role && rank(b.role) > rank(a.role)) throw forbidden('Não é possível conceder papel acima do seu');

      // Perfil → nível de acesso (proprietário: perfil é só o cargo)
      if (b.profileId !== undefined) {
        if (b.profileId === null) {
          await c.query('UPDATE users SET profile_id = NULL WHERE id = $1', [id]);
        } else {
          const p = (await c.query('SELECT id, role FROM user_profiles WHERE id = $1', [b.profileId])).rows[0];
          if (!p) throw unprocessable('Perfil não encontrado', 'invalid_profile');
          if (!isOwner && rank(p.role) > rank(a.role)) throw forbidden('Não é possível dar acesso acima do seu');
          await c.query(`UPDATE users SET profile_id = $2, role = CASE WHEN role = 'owner' THEN role ELSE $3 END WHERE id = $1`, [id, p.id, p.role]);
        }
      } else if (b.role) {
        // Troca direta de nível: o perfil só continua se for do mesmo nível
        await c.query(
          `UPDATE users SET role = $2, profile_id = CASE WHEN (SELECT role FROM user_profiles WHERE id = profile_id) = $2 THEN profile_id END WHERE id = $1`,
          [id, b.role],
        );
      }

      if (status === 'inactive' && target.active) {
        await c.query('UPDATE users SET active = false WHERE id = $1', [id]);
        await releaseSeat(c);
        await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      } else if (status && status !== 'inactive') {
        if (!target.active) {
          await consumeSeat(c);
          await c.query('UPDATE users SET active = true WHERE id = $1', [id]);
        }
        await c.query('UPDATE users SET is_third_party = $2 WHERE id = $1', [id, status === 'third_party']);
      }
      if (b.name) await c.query('UPDATE users SET name = $2 WHERE id = $1', [id, b.name]);
      await applyFields(c, a, id, b);

      // Auditoria sem dados pessoais (CPF, telefone, nascimento)
      const fields = Object.keys(b).filter((k) => !['cpf', 'mobile', 'phone', 'birthDate'].includes(k));
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'user.updated', targetType: 'user', targetId: id, metadata: { fields, status, role: b.role, profileId: b.profileId }, ip: req.ip });
      return present(a, (await c.query(`${USER_SELECT} WHERE u.id = $1`, [id])).rows[0]);
    });
  });

  // ---- Foto do usuário ----
  await app.register(async (img) => {
    img.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));
    img.put('/users/:id/avatar', { preHandler: guard(deps), bodyLimit: MAX_IMAGE_BYTES }, async (req) => {
      const a = authOf(req);
      const { id } = params(idParam, req);
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Envie a imagem (JPEG, PNG ou WebP)');
      const mime = sniffImage(body);
      if (!mime) throw badRequest('Formato não aceito. Use JPEG, PNG ou WebP.');
      return db.withAuth(a, async (c) => {
        const t = (await c.query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
        if (!t) throw notFound('Usuário não encontrado');
        // A própria pessoa, ou administrador sobre quem está no mesmo nível ou abaixo
        if (id !== a.userId && (!atLeast(a.role, 'admin') || rank(t.role) > rank(a.role))) throw forbidden();
        const r = await c.query(
          `INSERT INTO user_avatars (tenant_id, user_id, mime, content) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET mime = EXCLUDED.mime, content = EXCLUDED.content, updated_at = now()
           RETURNING updated_at`,
          [a.tenantId, id, mime, body],
        );
        return { ok: true, avatarUpdatedAt: r.rows[0].updated_at };
      });
    });
  });

  app.get('/users/:id/avatar', { preHandler: guard(deps) }, async (req, reply) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const row = await db.withAuth(a, async (c) => (await c.query('SELECT mime, content FROM user_avatars WHERE user_id = $1', [id])).rows[0]);
    if (!row) throw notFound('Usuário sem foto');
    return reply
      .header('Content-Type', row.mime)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(row.content);
  });

  app.delete('/users/:id/avatar', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const t = (await c.query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
      if (!t) throw notFound('Usuário não encontrado');
      if (id !== a.userId && (!atLeast(a.role, 'admin') || rank(t.role) > rank(a.role))) throw forbidden();
      await c.query('DELETE FROM user_avatars WHERE user_id = $1', [id]);
      return { ok: true };
    });
  });

  // ---- Convites ----
  app.get('/invites', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) => {
      const r = await c.query(
        `SELECT i.id, i.email, i.name, i.role, i.profile_id, p.name AS profile_name, i.expires_at, i.created_at
           FROM invites i LEFT JOIN user_profiles p ON p.id = i.profile_id
          WHERE i.role <> 'owner' AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`,
      );
      return r.rows;
    });
  });

  app.post('/invites', { preHandler: guard(deps, 'admin') }, async (req, reply) => {
    const a = authOf(req);
    const b = inviteBody.parse(req.body);
    if (rank(b.role) > rank(a.role)) throw forbidden('Não é possível convidar com papel acima do seu');
    const inv = await db.withAuth(a, async (c) => {
      // Perfil padrão do mesmo nível (se existir), para o usuário já nascer com cargo
      const p = (await c.query('SELECT id FROM user_profiles WHERE role = $1 ORDER BY created_at LIMIT 1', [b.role])).rows[0];
      return createInvite(deps, c, a, req.ip, { email: b.email, name: b.name, role: b.role, profileId: p?.id ?? null });
    });
    // O link só volta para quem convidou (admin), para copiar caso o e-mail não chegue
    return reply.status(201).send(inv);
  });

  app.delete('/invites/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const r = await c.query(`UPDATE invites SET revoked_at = now() WHERE id = $1 AND role <> 'owner' AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [id]);
      if (!r.rowCount) throw notFound('Convite não encontrado');
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'invite.revoked', targetType: 'invite', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  // ---- Perfis, departamentos e squads ----
  const nameBody = z.object({ name: z.string().trim().min(1).max(60) });
  const profileBody = nameBody.extend({ role: assignableRole });
  const dup = (e: unknown, what: string) => {
    if ((e as { code?: string }).code === '23505') throw conflict(`Já existe ${what} com este nome`, 'duplicate_name');
    throw e;
  };

  app.get('/profiles', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) =>
      (await c.query(`SELECT p.id, p.name, p.role, (SELECT count(*)::int FROM users u WHERE u.profile_id = p.id) AS users FROM user_profiles p ORDER BY p.name`)).rows,
    );
  });
  app.post('/profiles', { preHandler: guard(deps, 'admin') }, async (req, reply) => {
    const a = authOf(req);
    const b = profileBody.parse(req.body);
    if (rank(b.role) > rank(a.role)) throw forbidden('Não é possível criar perfil com acesso acima do seu');
    const row = await db.withAuth(a, (c) =>
      c.query('INSERT INTO user_profiles (tenant_id, name, role) VALUES ($1, $2, $3) RETURNING id, name, role', [a.tenantId, b.name, b.role]).then((r) => r.rows[0], (e) => dup(e, 'um perfil')),
    );
    return reply.status(201).send(row);
  });
  /** Mudar o nível do perfil muda o acesso de TODOS os usuários dele (e dos convites pendentes). */
  app.patch('/profiles/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const b = profileBody.partial().parse(req.body);
    return db.withAuth(a, async (c) => {
      const p = (await c.query('SELECT id, role FROM user_profiles WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) throw notFound('Perfil não encontrado');
      if (rank(p.role) > rank(a.role) || (b.role && rank(b.role) > rank(a.role))) throw forbidden('Não é possível dar acesso acima do seu');
      if (b.role && b.role !== p.role) {
        // Ninguém muda o próprio acesso por aqui
        const mine = (await c.query(`SELECT 1 FROM users WHERE id = $1 AND profile_id = $2 AND role <> 'owner'`, [a.userId, id])).rowCount;
        if (mine) throw forbidden('Este perfil é o seu: peça a outro administrador para mudar o nível');
        await c.query(`UPDATE users SET role = $2 WHERE profile_id = $1 AND role <> 'owner'`, [id, b.role]);
        await c.query(`UPDATE invites SET role = $2 WHERE profile_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [id, b.role]);
      }
      const r = await c
        .query('UPDATE user_profiles SET name = coalesce($2, name), role = coalesce($3, role) WHERE id = $1 RETURNING id, name, role', [id, b.name ?? null, b.role ?? null])
        .catch((e) => dup(e, 'um perfil'));
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'profile.updated', targetType: 'profile', targetId: id, metadata: b, ip: req.ip });
      return r.rows[0];
    });
  });
  app.delete('/profiles/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      await c.query('SELECT 1 FROM user_profiles WHERE id = $1 FOR UPDATE', [id]);
      const used = Number((await c.query('SELECT count(*) FROM users WHERE profile_id = $1', [id])).rows[0].count);
      if (used) throw conflict(`Há ${used} usuário(s) com este perfil; troque o perfil deles antes`, 'profile_in_use');
      const r = await c.query('DELETE FROM user_profiles WHERE id = $1', [id]);
      if (!r.rowCount) throw notFound('Perfil não encontrado');
      return { ok: true };
    });
  });

  for (const [path, table, what] of [['departments', 'departments', 'um departamento'], ['squads', 'squads', 'um squad']] as const) {
    app.get(`/${path}`, { preHandler: guard(deps, 'admin') }, async (req) => {
      const a = authOf(req);
      return db.withAuth(a, async (c) => (await c.query(`SELECT id, name FROM ${table} ORDER BY name`)).rows);
    });
    app.post(`/${path}`, { preHandler: guard(deps, 'admin') }, async (req, reply) => {
      const a = authOf(req);
      const b = nameBody.parse(req.body);
      const row = await db.withAuth(a, (c) =>
        c.query(`INSERT INTO ${table} (tenant_id, name) VALUES ($1, $2) RETURNING id, name`, [a.tenantId, b.name]).then((r) => r.rows[0], (e) => dup(e, what)),
      );
      return reply.status(201).send(row);
    });
    /** Excluir só esvazia o campo dos usuários (ninguém é apagado). */
    app.delete(`/${path}/:id`, { preHandler: guard(deps, 'admin') }, async (req) => {
      const a = authOf(req);
      const { id } = params(idParam, req);
      return db.withAuth(a, async (c) => {
        const r = await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        if (!r.rowCount) throw notFound('Não encontrado');
        return { ok: true };
      });
    });
  }
}
