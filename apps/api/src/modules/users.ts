import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { authOf } from '../auth/guards.js';
import { rank, type Role } from '../auth/roles.js';
import { forbidden, notFound } from '../lib/errors.js';
import { newToken, sha256 } from '../lib/crypto.js';
import { audit, consumeSeat, releaseSeat } from '../lib/limits.js';
import { enqueue } from '../jobs/queue.js';
import { guard, idParam, params } from './common.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const assignableRole = z.enum(['admin', 'manager', 'seller']);

const inviteBody = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: assignableRole });
const patchUser = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: assignableRole.optional(),
  active: z.boolean().optional(),
});

export async function userRoutes(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;

  app.get('/users', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) => {
      const r = await c.query(`SELECT id, name, email, role, active, created_at FROM users ORDER BY name`);
      return r.rows;
    });
  });

  app.patch('/users/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const b = patchUser.parse(req.body);
    return db.withAuth(a, async (c) => {
      // Lock da linha: decisão (papel/ativo) e escrita sobre o mesmo estado
      const target = (await c.query('SELECT id, role, active FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!target) throw notFound('Usuário não encontrado');
      if (target.role === 'owner') throw forbidden('O proprietário da conta não pode ser alterado aqui');
      if (target.id === a.userId) throw forbidden('Você não pode alterar o próprio acesso');
      if (rank(target.role as Role) > rank(a.role)) throw forbidden();
      if (b.role && rank(b.role) > rank(a.role)) throw forbidden('Não é possível conceder papel acima do seu');

      if (b.active === false && target.active) {
        await c.query('UPDATE users SET active = false WHERE id = $1', [id]);
        await releaseSeat(c);
        await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      } else if (b.active === true && !target.active) {
        await consumeSeat(c);
        await c.query('UPDATE users SET active = true WHERE id = $1', [id]);
      }
      if (b.role || b.name) {
        await c.query('UPDATE users SET role = coalesce($2, role), name = coalesce($3, name) WHERE id = $1', [id, b.role ?? null, b.name ?? null]);
      }
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'user.updated', targetType: 'user', targetId: id, metadata: b, ip: req.ip });
      return (await c.query('SELECT id, name, email, role, active FROM users WHERE id = $1', [id])).rows[0];
    });
  });

  app.get('/invites', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) => {
      const r = await c.query(
        `SELECT id, email, role, expires_at, created_at FROM invites
          WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      );
      return r.rows;
    });
  });

  app.post('/invites', { preHandler: guard(deps, 'admin') }, async (req, reply) => {
    const a = authOf(req);
    const b = inviteBody.parse(req.body);
    if (rank(b.role) > rank(a.role)) throw forbidden('Não é possível convidar com papel acima do seu');
    const token = newToken();
    const url = `${config.APP_PUBLIC_URL}/convite?token=${encodeURIComponent(token)}`;
    const invite = await db.withAuth(a, async (c) => {
      // Convites pendentes vencidos não bloqueiam um novo convite
      await c.query(
        `UPDATE invites SET revoked_at = now()
          WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
        [b.email],
      );
      // Índice único parcial impede dois convites pendentes para o mesmo e-mail
      const r = await c.query(
        `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, expires_at`,
        [a.tenantId, b.email, b.role, sha256(token), new Date(Date.now() + INVITE_TTL_MS), a.userId],
      );
      const inv = r.rows[0];
      await enqueue(c, {
        type: 'email.invite',
        tenantId: a.tenantId,
        payload: { to: b.email, tenantName: a.tenantName, inviterName: a.name, url },
        dedupeKey: `email:invite:${inv.id}`,
      });
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'invite.created', targetType: 'invite', targetId: inv.id, ip: req.ip });
      return inv;
    });
    // O link só volta para quem convidou (admin), para copiar caso o e-mail não chegue
    return reply.status(201).send({ ...invite, url });
  });

  app.delete('/invites/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const r = await c.query(`UPDATE invites SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [id]);
      if (!r.rowCount) throw notFound('Convite não encontrado');
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'invite.revoked', targetType: 'invite', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });
}
