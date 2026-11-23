import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { authOf } from '../auth/guards.js';
import { conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/limits.js';
import { guard, idParam, params } from './common.js';

const stageBody = z.object({
  name: z.string().trim().min(1).max(60),
  probability: z.number().int().min(0).max(100),
  kind: z.enum(['open', 'won', 'lost']).default('open'),
});
const patchStage = stageBody.partial().extend({ position: z.number().int().min(0).max(1000).optional() });

export async function pipelineRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  app.get('/stages', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) =>
      (await c.query('SELECT id, name, position, probability, kind FROM pipeline_stages ORDER BY position, created_at')).rows,
    );
  });

  app.post('/stages', { preHandler: guard(deps, 'admin') }, async (req, reply) => {
    const a = authOf(req);
    const b = stageBody.parse(req.body);
    const row = await db.withAuth(a, async (c) => {
      const r = await c.query(
        `INSERT INTO pipeline_stages (tenant_id, name, position, probability, kind)
         VALUES ($1, $2, (SELECT coalesce(max(position) + 1, 0) FROM pipeline_stages), $3, $4)
         RETURNING id, name, position, probability, kind`,
        [a.tenantId, b.name, b.probability, b.kind],
      );
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'stage.created', targetId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/stages/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const b = patchStage.parse(req.body);
    return db.withAuth(a, async (c) => {
      const r = await c.query(
        `UPDATE pipeline_stages SET name = coalesce($2, name), probability = coalesce($3, probability),
                kind = coalesce($4, kind), position = coalesce($5, position)
          WHERE id = $1 RETURNING id, name, position, probability, kind`,
        [id, b.name ?? null, b.probability ?? null, b.kind ?? null, b.position ?? null],
      );
      if (!r.rowCount) throw notFound('Etapa não encontrada');
      return r.rows[0];
    });
  });

  app.delete('/stages/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      // A FK de leads impede apagar etapa com leads (sem "checar e depois apagar")
      try {
        const r = await c.query('DELETE FROM pipeline_stages WHERE id = $1 RETURNING id', [id]);
        if (!r.rowCount) throw notFound('Etapa não encontrada');
      } catch (e) {
        if ((e as { code?: string }).code === '23503') throw conflict('Etapa possui leads; mova-os antes de excluir', 'stage_has_leads');
        throw e;
      }
      return { ok: true };
    });
  });
}
