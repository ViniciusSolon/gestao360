import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Client } from '../db/db.js';
import { authOf, type TenantAuth } from '../auth/guards.js';
import { atLeast } from '../auth/roles.js';
import { forbidden, notFound, unprocessable } from '../lib/errors.js';
import { audit, consumeLeadQuota, releaseLeadQuota } from '../lib/limits.js';
import { MQL_THRESHOLD, scoreLead } from '../lib/pricing.js';
import { isValidCnpj, normalizeCnpj } from '../lib/cnpj.js';
import { SOURCE_KEYS } from '../lib/sources.js';
import { guard, idParam, optionalText, params } from './common.js';

/** Fontes de aquisição (ver lib/sources.ts). Mantido o nome antigo para compatibilidade. */
export const CHANNELS = SOURCE_KEYS;

/** Campos do lead SEM valores padrão (base da edição parcial). */
const leadFields = z.object({
  name: z.string().trim().min(1).max(160),
  company: optionalText(160),
  /** Com ou sem máscara; numérico ou alfanumérico. Validado pelos dígitos verificadores. */
  cnpj: z
    .string()
    .trim()
    .max(30)
    .optional()
    .nullable()
    .transform((v) => (v ? normalizeCnpj(v) : null))
    .refine((v) => v === null || isValidCnpj(v), 'CNPJ inválido (confira os dígitos)'),
  email: z.string().trim().toLowerCase().email().max(200).optional().nullable().or(z.literal('')).transform((v) => v || null),
  phone: optionalText(40),
  channel: z.enum(CHANNELS),
  /** Campanha de marketing (ex.: "Black Friday"), detalha a fonte no painel */
  campaign: optionalText(120),
  valueCents: z.number().int().min(0).max(1e13),
  expectedCloseDate: z.string().date().optional().nullable(),
  stageId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional().nullable(),
});
/** Criação: aqui (e só aqui) entram os padrões. */
const leadBody = leadFields.extend({
  channel: z.enum(CHANNELS).default('outro'),
  valueCents: z.number().int().min(0).max(1e13).default(0),
});
/**
 * Edição parcial: parte dos campos SEM padrão. Com .partial() sobre campos que têm
 * .default(), o Zod preenche o padrão quando o campo não vem — e a edição apagava
 * o canal e o valor do lead.
 */
const patchLead = leadFields.omit({ stageId: true }).partial();
const moveBody = z.object({ stageId: z.string().uuid(), lostReason: optionalText(300) });
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  ownerId: z.string().uuid().optional(),
});

/**
 * Regra de visibilidade dentro do tenant: vendedor só vê os próprios leads e
 * os sem responsável. Gerente+ vê todos. Aplicada em TODA leitura/escrita por id.
 */
export function leadScope(a: TenantAuth, alias = 'l'): { sql: string; params: unknown[] } {
  if (atLeast(a.role, 'manager')) return { sql: 'true', params: [] };
  return { sql: `(${alias}.owner_id = $X OR ${alias}.owner_id IS NULL)`, params: [a.userId] };
}

function withScope(base: string, scope: { sql: string; params: unknown[] }, existing: unknown[]) {
  const idx = existing.length + 1;
  return { sql: base.replace('$SCOPE', scope.sql.replace('$X', `$${idx}`)), params: [...existing, ...scope.params] };
}

/** Busca um lead respeitando a visibilidade; 404 se não puder ver (não revela existência). */
export async function loadVisibleLead(c: Client, a: TenantAuth, id: string, forUpdate = false) {
  const q = withScope(`SELECT l.* FROM leads l WHERE l.id = $1 AND $SCOPE${forUpdate ? ' FOR UPDATE' : ''}`, leadScope(a), [id]);
  const lead = (await c.query(q.sql, q.params)).rows[0];
  if (!lead) throw notFound('Lead não encontrado');
  return lead;
}

function resolveOwner(a: TenantAuth, requested: string | null | undefined): string | null {
  if (requested === undefined) return a.userId;
  if (!atLeast(a.role, 'manager') && requested !== a.userId) throw forbidden('Vendedor só pode atribuir leads a si mesmo');
  return requested;
}

export async function leadRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  app.get('/leads', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const f = listQuery.parse(req.query);
    return db.withAuth(a, async (c) => {
      const p: unknown[] = [];
      const where: string[] = ['$SCOPE'];
      if (f.status) { p.push(f.status); where.push(`l.status = $${p.length}`); }
      if (f.ownerId) { p.push(f.ownerId); where.push(`l.owner_id = $${p.length}`); }
      if (f.q) {
        const text = p.push(`%${f.q}%`);
        const conds = [`l.name ILIKE $${text}`, `l.company ILIKE $${text}`, `l.email ILIKE $${text}`];
        // Busca por CNPJ digitado com ou sem máscara
        const cnpjTerm = normalizeCnpj(f.q);
        if (/^[0-9A-Z]{3,14}$/.test(cnpjTerm)) conds.push(`l.cnpj LIKE $${p.push(`%${cnpjTerm}%`)}`);
        where.push(`(${conds.join(' OR ')})`);
      }
      const q = withScope(
        `SELECT l.id, l.name, l.company, l.cnpj, l.email, l.phone, l.channel, l.campaign, l.stage_id, l.status, l.is_mql, l.score,
                l.value_cents, l.expected_close_date, l.owner_id, u.name AS owner_name, l.created_at, l.updated_at
           FROM leads l LEFT JOIN users u ON u.id = l.owner_id
          WHERE ${where.join(' AND ')}
          ORDER BY l.updated_at DESC LIMIT 1000`,
        leadScope(a),
        p,
      );
      return (await c.query(q.sql, q.params)).rows;
    });
  });

  app.post('/leads', { preHandler: guard(deps) }, async (req, reply) => {
    const a = authOf(req);
    const b = leadBody.parse(req.body);
    const ownerId = resolveOwner(a, b.ownerId);
    const score = scoreLead(b);
    const lead = await db.withAuth(a, async (c) => {
      const stage = b.stageId
        ? (await c.query('SELECT id, kind FROM pipeline_stages WHERE id = $1', [b.stageId])).rows[0]
        : (await c.query(`SELECT id, kind FROM pipeline_stages WHERE kind = 'open' ORDER BY position LIMIT 1`)).rows[0];
      if (!stage) throw unprocessable('Etapa inválida', 'invalid_stage');
      if (stage.kind !== 'open') throw unprocessable('Novos leads entram em etapa aberta', 'invalid_stage');
      await consumeLeadQuota(c);
      const r = await c.query(
        `INSERT INTO leads (tenant_id, name, company, email, phone, channel, owner_id, stage_id, score, is_mql, value_cents, expected_close_date, cnpj, campaign)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [a.tenantId, b.name, b.company, b.email, b.phone, b.channel, ownerId, stage.id, score, score >= MQL_THRESHOLD, b.valueCents, b.expectedCloseDate ?? null, b.cnpj ?? null, b.campaign],
      );
      await c.query(`INSERT INTO lead_events (tenant_id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'created', '{}')`, [a.tenantId, r.rows[0].id, a.userId]);
      return r.rows[0];
    });
    return reply.status(201).send(lead);
  });

  app.get('/leads/:id', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const lead = await loadVisibleLead(c, a, id);
      const [events, activities, proposals] = await Promise.all([
        c.query(`SELECT e.id, e.type, e.data, e.created_at, u.name AS user_name FROM lead_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.lead_id = $1 ORDER BY e.created_at DESC LIMIT 200`, [id]),
        c.query(`SELECT id, type, title, due_at, done_at, assigned_to FROM activities WHERE lead_id = $1 ORDER BY coalesce(due_at, created_at)`, [id]),
        c.query(`SELECT id, number, status, total_cents, created_at FROM proposals WHERE lead_id = $1 ORDER BY number DESC`, [id]),
      ]);
      return { ...lead, events: events.rows, activities: activities.rows, proposals: proposals.rows };
    });
  });

  app.patch('/leads/:id', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const b = patchLead.parse(req.body);
    return db.withAuth(a, async (c) => {
      const lead = await loadVisibleLead(c, a, id, true);
      const ownerId = b.ownerId === undefined ? lead.owner_id : resolveOwner(a, b.ownerId);
      const merged = {
        name: b.name ?? lead.name,
        company: b.company !== undefined ? b.company : lead.company,
        cnpj: b.cnpj !== undefined ? b.cnpj : lead.cnpj,
        campaign: b.campaign !== undefined ? b.campaign : lead.campaign,
        email: b.email !== undefined ? b.email : lead.email,
        phone: b.phone !== undefined ? b.phone : lead.phone,
        channel: b.channel ?? lead.channel,
        valueCents: b.valueCents ?? Number(lead.value_cents),
        expectedCloseDate: b.expectedCloseDate !== undefined ? b.expectedCloseDate : lead.expected_close_date,
      };
      const score = scoreLead(merged);
      const r = await c.query(
        `UPDATE leads SET name=$2, company=$3, email=$4, phone=$5, channel=$6, value_cents=$7, expected_close_date=$8,
                owner_id=$9, score=$10, is_mql = is_mql OR $11, cnpj=$12, campaign=$13, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, merged.name, merged.company, merged.email, merged.phone, merged.channel, merged.valueCents, merged.expectedCloseDate, ownerId, score, score >= MQL_THRESHOLD, merged.cnpj, merged.campaign],
      );
      await c.query(`INSERT INTO lead_events (tenant_id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'updated', $4)`, [a.tenantId, id, a.userId, JSON.stringify(Object.keys(b))]);
      return r.rows[0];
    });
  });

  app.post('/leads/:id/move', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const b = moveBody.parse(req.body);
    return db.withAuth(a, async (c) => {
      const lead = await loadVisibleLead(c, a, id, true);
      const stage = (await c.query('SELECT id, name, kind FROM pipeline_stages WHERE id = $1', [b.stageId])).rows[0];
      if (!stage) throw unprocessable('Etapa inválida', 'invalid_stage');
      if (lead.stage_id === stage.id) return lead;
      const status = stage.kind; // open | won | lost
      if (status === 'lost' && !b.lostReason) throw unprocessable('Informe o motivo da perda', 'lost_reason_required');
      const r = await c.query(
        `UPDATE leads SET stage_id = $2, status = $3, lost_reason = CASE WHEN $3 = 'lost' THEN $4 ELSE NULL END,
                closed_at = CASE WHEN $3 = 'open' THEN NULL ELSE now() END, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, stage.id, status, b.lostReason],
      );
      await c.query(`INSERT INTO lead_events (tenant_id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'stage_changed', $4)`, [
        a.tenantId, id, a.userId, JSON.stringify({ from: lead.stage_id, to: stage.id, stageName: stage.name }),
      ]);
      return r.rows[0];
    });
  });

  app.delete('/leads/:id', { preHandler: guard(deps, 'manager') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const r = await c.query('DELETE FROM leads WHERE id = $1 RETURNING id', [id]);
      if (!r.rowCount) throw notFound('Lead não encontrado');
      // Só quem efetivamente apagou devolve a cota (delete duplo não devolve duas vezes)
      await releaseLeadQuota(c);
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'lead.deleted', targetType: 'lead', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });
}
