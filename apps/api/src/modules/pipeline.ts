import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Client } from '../db/db.js';
import { authOf } from '../auth/guards.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/limits.js';
import { guard, idParam, params } from './common.js';

/** Campos da etapa SEM padrão (base da edição parcial). */
const stageFields = z.object({
  name: z.string().trim().min(1).max(60),
  probability: z.number().int().min(0).max(100),
  kind: z.enum(['open', 'won', 'lost']),
});
const stageBody = stageFields.extend({
  kind: z.enum(['open', 'won', 'lost']).default('open'),
  pipelineId: z.string().uuid().optional(),
});
/** Edição: sem padrão, senão renomear a etapa "Ganho" a transformava em etapa aberta. */
const patchStage = stageFields.partial().extend({ position: z.number().int().min(0).max(1000).optional() });

const pipelineName = z.string().trim().min(1).max(60);
/** Etapas com que um funil novo nasce (dá para renomear, excluir e criar outras). */
export const NEW_PIPELINE_STAGES: [string, number, 'open' | 'won' | 'lost'][] = [
  ['Novo lead', 10, 'open'],
  ['Em negociação', 50, 'open'],
  ['Ganho', 100, 'won'],
  ['Perdido', 0, 'lost'],
];

const STAGE_COLS = 'id, pipeline_id, name, position, probability, kind';

/** Trava o funil (FOR UPDATE) para que exclusões simultâneas não deixem o funil sem etapa aberta. */
async function lockPipeline(c: Client, pipelineId: string) {
  const p = (await c.query('SELECT id FROM pipelines WHERE id = $1 FOR UPDATE', [pipelineId])).rows[0];
  if (!p) throw notFound('Funil não encontrado');
}

export async function pipelineRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  // ---- Funis ----
  app.get('/pipelines', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) => {
      const pipes = (await c.query('SELECT id, name, position FROM pipelines ORDER BY position, created_at')).rows;
      const stages = (await c.query(`SELECT ${STAGE_COLS} FROM pipeline_stages ORDER BY position, created_at`)).rows;
      return pipes.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) }));
    });
  });

  app.post('/pipelines', { preHandler: guard(deps, 'admin') }, async (req, reply) => {
    const a = authOf(req);
    const { name } = z.object({ name: pipelineName }).parse(req.body);
    const row = await db.withAuth(a, async (c) => {
      const p = (
        await c.query(
          `INSERT INTO pipelines (tenant_id, name, position)
           VALUES ($1, $2, (SELECT coalesce(max(position) + 1, 0) FROM pipelines)) RETURNING id, name, position`,
          [a.tenantId, name],
        )
      ).rows[0];
      const stages = [];
      for (const [i, [sname, prob, kind]] of NEW_PIPELINE_STAGES.entries()) {
        stages.push(
          (
            await c.query(
              `INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, position, probability, kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${STAGE_COLS}`,
              [a.tenantId, p.id, sname, i, prob, kind],
            )
          ).rows[0],
        );
      }
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'pipeline.created', targetType: 'pipeline', targetId: p.id, ip: req.ip });
      return { ...p, stages };
    });
    return reply.status(201).send(row);
  });

  app.patch('/pipelines/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const { name } = z.object({ name: pipelineName }).parse(req.body);
    return db.withAuth(a, async (c) => {
      const r = await c.query('UPDATE pipelines SET name = $2 WHERE id = $1 RETURNING id, name, position', [id, name]);
      if (!r.rowCount) throw notFound('Funil não encontrado');
      return r.rows[0];
    });
  });

  /** Exclui um funil sem leads. O último funil da empresa não pode ser excluído. */
  app.delete('/pipelines/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      // Trava todos os funis da empresa: duas exclusões ao mesmo tempo não zeram a lista
      const all = (await c.query('SELECT id FROM pipelines ORDER BY id FOR UPDATE')).rows;
      if (!all.some((p) => p.id === id)) throw notFound('Funil não encontrado');
      if (all.length <= 1) throw conflict('A empresa precisa ter pelo menos um funil', 'last_pipeline');
      try {
        await c.query('SAVEPOINT del_pipeline');
        await c.query('DELETE FROM pipelines WHERE id = $1', [id]);
      } catch (e) {
        if ((e as { code?: string }).code === '23503') {
          await c.query('ROLLBACK TO SAVEPOINT del_pipeline');
          throw conflict('Este funil tem leads; mova-os para outro funil antes de excluir', 'pipeline_has_leads');
        }
        throw e;
      }
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'pipeline.deleted', targetType: 'pipeline', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  // ---- Etapas ----
  app.get('/stages', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) =>
      (
        await c.query(
          `SELECT s.id, s.pipeline_id, s.name, s.position, s.probability, s.kind FROM pipeline_stages s
             JOIN pipelines p ON p.id = s.pipeline_id ORDER BY p.position, p.created_at, s.position, s.created_at`,
        )
      ).rows,
    );
  });

  app.post('/stages', { preHandler: guard(deps, 'admin') }, async (req, reply) => {
    const a = authOf(req);
    const b = stageBody.parse(req.body);
    const row = await db.withAuth(a, async (c) => {
      const pipelineId =
        b.pipelineId ?? (await c.query('SELECT id FROM pipelines ORDER BY position, created_at LIMIT 1')).rows[0]?.id;
      if (!pipelineId) throw unprocessable('Crie um funil primeiro', 'no_pipeline');
      await lockPipeline(c, pipelineId);
      const r = await c.query(
        `INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, position, probability, kind)
         VALUES ($1, $2, $3, (SELECT coalesce(max(position) + 1, 0) FROM pipeline_stages WHERE pipeline_id = $2), $4, $5)
         RETURNING ${STAGE_COLS}`,
        [a.tenantId, pipelineId, b.name, b.probability, b.kind],
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
          WHERE id = $1 RETURNING ${STAGE_COLS}`,
        [id, b.name ?? null, b.probability ?? null, b.kind ?? null, b.position ?? null],
      );
      if (!r.rowCount) throw notFound('Etapa não encontrada');
      return r.rows[0];
    });
  });

  /**
   * Exclui etapa sem leads. O funil precisa continuar com pelo menos uma etapa aberta
   * (é onde os leads novos entram).
   */
  app.delete('/stages/:id', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const stage = (await c.query('SELECT pipeline_id, kind FROM pipeline_stages WHERE id = $1', [id])).rows[0];
      if (!stage) throw notFound('Etapa não encontrada');
      await lockPipeline(c, stage.pipeline_id);
      if (stage.kind === 'open') {
        const open = Number((await c.query(`SELECT count(*) FROM pipeline_stages WHERE pipeline_id = $1 AND kind = 'open'`, [stage.pipeline_id])).rows[0].count);
        if (open <= 1) throw conflict('O funil precisa ter pelo menos uma etapa aberta', 'last_open_stage');
      }
      // A FK de leads impede apagar etapa com leads (sem "checar e depois apagar")
      try {
        await c.query('SAVEPOINT del_stage');
        const r = await c.query('DELETE FROM pipeline_stages WHERE id = $1 RETURNING id', [id]);
        if (!r.rowCount) throw notFound('Etapa não encontrada');
      } catch (e) {
        if ((e as { code?: string }).code === '23503') {
          await c.query('ROLLBACK TO SAVEPOINT del_stage');
          throw conflict('Esta etapa tem leads; mova-os para outra etapa antes de excluir', 'stage_has_leads');
        }
        throw e;
      }
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'stage.deleted', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });
}
