import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Client } from '../db/db.js';
import { authOf, type TenantAuth } from '../auth/guards.js';
import { atLeast } from '../auth/roles.js';
import { forbidden, notFound } from '../lib/errors.js';
import { guard, idParam, optionalText, params } from './common.js';
import { loadVisibleLead } from './leads.js';

const activityBody = z.object({
  leadId: z.string().uuid().optional().nullable(),
  type: z.enum(['task', 'call', 'meeting', 'email', 'note']),
  title: z.string().trim().min(1).max(200),
  notes: optionalText(5000),
  dueAt: z.string().datetime({ offset: true }).optional().nullable(),
  assignedTo: z.string().uuid().optional(),
  meetingUrl: z.string().url().max(500).regex(/^https:\/\//, 'Use um link https').optional().nullable(),
});
const patchActivity = activityBody.omit({ leadId: true }).partial();
const listQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  open: z.enum(['true', 'false']).optional(),
  leadId: z.string().uuid().optional(),
  mine: z.enum(['true', 'false']).optional(),
});

/** Vendedor vê/edita só atividades atribuídas a ele ou criadas por ele. */
function scopeSql(a: TenantAuth, idx: number) {
  return atLeast(a.role, 'manager') ? `$${idx}::uuid IS NOT NULL` : `(act.assigned_to = $${idx} OR act.created_by = $${idx})`;
}

async function loadVisibleActivity(c: Client, a: TenantAuth, id: string) {
  const r = await c.query(`SELECT act.* FROM activities act WHERE act.id = $1 AND ${scopeSql(a, 2)} FOR UPDATE`, [id, a.userId]);
  if (!r.rows[0]) throw notFound('Atividade não encontrada');
  return r.rows[0];
}

function resolveAssignee(a: TenantAuth, requested?: string) {
  if (!requested) return a.userId;
  if (!atLeast(a.role, 'manager') && requested !== a.userId) throw forbidden('Vendedor só pode atribuir atividades a si mesmo');
  return requested;
}

export async function activityRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  app.get('/activities', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const f = listQuery.parse(req.query);
    return db.withAuth(a, async (c) => {
      const p: unknown[] = [a.userId];
      const where = [scopeSql(a, 1)];
      if (f.mine === 'true') where.push('act.assigned_to = $1');
      if (f.from) { p.push(f.from); where.push(`act.due_at >= $${p.length}`); }
      if (f.to) { p.push(f.to); where.push(`act.due_at < $${p.length}`); }
      if (f.open === 'true') where.push('act.done_at IS NULL');
      if (f.open === 'false') where.push('act.done_at IS NOT NULL');
      if (f.leadId) { p.push(f.leadId); where.push(`act.lead_id = $${p.length}`); }
      const r = await c.query(
        `SELECT act.id, act.lead_id, l.name AS lead_name, act.type, act.title, act.notes, act.due_at, act.done_at,
                act.assigned_to, u.name AS assigned_name, act.meeting_url, act.created_at
           FROM activities act
           LEFT JOIN leads l ON l.id = act.lead_id
           LEFT JOIN users u ON u.id = act.assigned_to
          WHERE ${where.join(' AND ')}
          ORDER BY act.done_at NULLS FIRST, act.due_at NULLS LAST LIMIT 500`,
        p,
      );
      return r.rows;
    });
  });

  app.post('/activities', { preHandler: guard(deps) }, async (req, reply) => {
    const a = authOf(req);
    const b = activityBody.parse(req.body);
    const assignedTo = resolveAssignee(a, b.assignedTo);
    const row = await db.withAuth(a, async (c) => {
      if (b.leadId) await loadVisibleLead(c, a, b.leadId);
      const r = await c.query(
        `INSERT INTO activities (tenant_id, lead_id, type, title, notes, due_at, assigned_to, meeting_url, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [a.tenantId, b.leadId ?? null, b.type, b.title, b.notes, b.dueAt ?? null, assignedTo, b.meetingUrl ?? null, a.userId],
      );
      if (b.leadId) {
        await c.query(`INSERT INTO lead_events (tenant_id, lead_id, user_id, type, data) VALUES ($1,$2,$3,'activity_created',$4)`, [
          a.tenantId, b.leadId, a.userId, JSON.stringify({ activityId: r.rows[0].id, type: b.type, title: b.title }),
        ]);
      }
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/activities/:id', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const b = patchActivity.parse(req.body);
    return db.withAuth(a, async (c) => {
      await loadVisibleActivity(c, a, id);
      const assignedTo = b.assignedTo ? resolveAssignee(a, b.assignedTo) : null;
      const r = await c.query(
        `UPDATE activities SET type = coalesce($2, type), title = coalesce($3, title), notes = coalesce($4, notes),
                due_at = coalesce($5, due_at), assigned_to = coalesce($6, assigned_to), meeting_url = coalesce($7, meeting_url)
          WHERE id = $1 RETURNING *`,
        [id, b.type ?? null, b.title ?? null, b.notes ?? null, b.dueAt ?? null, assignedTo, b.meetingUrl ?? null],
      );
      return r.rows[0];
    });
  });

  app.post('/activities/:id/complete', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      await loadVisibleActivity(c, a, id);
      // Atômico: só a primeira conclusão grava done_at e o evento
      const r = await c.query('UPDATE activities SET done_at = now() WHERE id = $1 AND done_at IS NULL RETURNING *', [id]);
      if (r.rowCount && r.rows[0].lead_id) {
        await c.query(`INSERT INTO lead_events (tenant_id, lead_id, user_id, type, data) VALUES ($1,$2,$3,'activity_done',$4)`, [
          a.tenantId, r.rows[0].lead_id, a.userId, JSON.stringify({ activityId: id }),
        ]);
      }
      return r.rows[0] ?? (await c.query('SELECT * FROM activities WHERE id = $1', [id])).rows[0];
    });
  });

  app.delete('/activities/:id', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      await loadVisibleActivity(c, a, id);
      await c.query('DELETE FROM activities WHERE id = $1', [id]);
      return { ok: true };
    });
  });
}
