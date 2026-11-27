import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { authOf } from '../auth/guards.js';
import { atLeast } from '../auth/roles.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../lib/limits.js';
import { guard } from './common.js';

const query = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  pipelineId: z.string().uuid().optional(),
});

/**
 * Indicadores comerciais. Cada número traz a "origem" (regra usada), para o
 * usuário conseguir conferir. Vendedor vê só os próprios números.
 */
export async function dashboardRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/dashboard', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const q = query.parse(req.query);
    const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : new Date();
    const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    const mine = !atLeast(a.role, 'manager');
    // Filtro de funil: só leads cujas etapas pertencem ao funil escolhido
    const inPipe = (n: number) => `AND ($${n}::uuid IS NULL OR l.stage_id IN (SELECT id FROM pipeline_stages WHERE pipeline_id = $${n}))`;
    const scope = `${mine ? 'AND l.owner_id = $3' : 'AND $3::uuid IS NULL'} ${inPipe(4)}`;
    const p = [from, to, mine ? a.userId : null, q.pipelineId ?? null];

    return deps.db.withAuth(a, async (c) => {
      if (q.pipelineId && !(await c.query('SELECT 1 FROM pipelines WHERE id = $1', [q.pipelineId])).rowCount) {
        throw notFound('Funil não encontrado');
      }
      const kpi = (
        await c.query(
          `SELECT
             count(*) FILTER (WHERE l.created_at BETWEEN $1 AND $2)                                   AS leads,
             count(*) FILTER (WHERE l.created_at BETWEEN $1 AND $2 AND l.is_mql)                      AS mqls,
             count(*) FILTER (WHERE l.status = 'won'  AND l.closed_at BETWEEN $1 AND $2)              AS won,
             count(*) FILTER (WHERE l.status = 'lost' AND l.closed_at BETWEEN $1 AND $2)              AS lost,
             coalesce(sum(l.value_cents) FILTER (WHERE l.status = 'won' AND l.closed_at BETWEEN $1 AND $2), 0) AS won_value,
             avg(extract(epoch FROM l.closed_at - l.created_at) / 86400)
               FILTER (WHERE l.status = 'won' AND l.closed_at BETWEEN $1 AND $2)                       AS cycle_days
           FROM leads l WHERE true ${scope}`,
          p,
        )
      ).rows[0];
      const bySeller = await c.query(
        `SELECT coalesce(u.name, 'Sem responsável') AS seller, count(*) AS won, sum(l.value_cents) AS value_cents
           FROM leads l LEFT JOIN users u ON u.id = l.owner_id
          WHERE l.status = 'won' AND l.closed_at BETWEEN $1 AND $2 ${scope}
          GROUP BY 1 ORDER BY value_cents DESC`,
        p,
      );
      const byChannel = await c.query(
        `SELECT l.channel, count(*) AS leads,
                count(*) FILTER (WHERE l.status = 'won') AS won,
                coalesce(sum(l.value_cents) FILTER (WHERE l.status = 'won'), 0) AS value_cents
           FROM leads l WHERE l.created_at BETWEEN $1 AND $2 ${scope}
          GROUP BY 1 ORDER BY leads DESC`,
        p,
      );
      const funnel = await c.query(
        `SELECT s.id, s.name, s.kind, s.probability, pl.name AS pipeline_name, count(l.id) AS leads, coalesce(sum(l.value_cents), 0) AS value_cents
           FROM pipeline_stages s
           JOIN pipelines pl ON pl.id = s.pipeline_id
           LEFT JOIN leads l ON l.stage_id = s.id ${mine ? 'AND l.owner_id = $1' : 'AND $1::uuid IS NULL'}
          WHERE ($2::uuid IS NULL OR pl.id = $2)
          GROUP BY s.id, pl.id ORDER BY pl.position, pl.created_at, s.position`,
        [mine ? a.userId : null, q.pipelineId ?? null],
      );
      // Previsão de fechamento: propostas em aberto (rascunho/enviada) com fechamento previsto até o
      // fim do mês atual, incluindo as atrasadas (previsão já passou e continuam em aberto)
      const fc = await c.query(
        `SELECT coalesce(sum(p.total_cents), 0) AS total, count(*) AS n,
                coalesce(sum(p.total_cents) FILTER (WHERE p.temperature = 'hot'), 0)  AS hot,
                coalesce(sum(p.total_cents) FILTER (WHERE p.temperature = 'warm'), 0) AS warm,
                coalesce(sum(p.total_cents) FILTER (WHERE p.temperature = 'cold'), 0) AS cold
           FROM proposals p JOIN leads l ON l.id = p.lead_id
          WHERE p.status IN ('draft','sent')
            AND p.expected_close_date < (date_trunc('month', now()) + interval '1 month')::date
            ${mine ? 'AND p.owner_id = $1' : 'AND $1::uuid IS NULL'} ${inPipe(2)}`,
        [mine ? a.userId : null, q.pipelineId ?? null],
      );
      const forecast = Number(fc.rows[0].total);
      const alerts = (
        await c.query(
          `SELECT
             (SELECT count(*) FROM leads l WHERE l.status = 'open' AND l.updated_at < now() - interval '14 days' ${mine ? 'AND l.owner_id = $1' : 'AND $1::uuid IS NULL'} ${inPipe(2)}) AS stalled,
             (SELECT count(*) FROM activities act WHERE act.done_at IS NULL AND act.due_at < now() ${mine ? 'AND act.assigned_to = $1' : 'AND $1::uuid IS NULL'}
                AND ($2::uuid IS NULL OR act.lead_id IN (SELECT l.id FROM leads l WHERE true ${inPipe(2)}))) AS overdue`,
          [mine ? a.userId : null, q.pipelineId ?? null],
        )
      ).rows[0];

      const won = Number(kpi.won);
      const lost = Number(kpi.lost);
      const wonValue = Number(kpi.won_value);
      return {
        period: { from, to, scope: mine ? 'meus leads' : 'empresa', pipelineId: q.pipelineId ?? null },
        kpis: {
          leads: { value: Number(kpi.leads), origin: 'Leads criados no período' },
          mqls: { value: Number(kpi.mqls), origin: 'Leads do período com pontuação ≥ 50' },
          wonCount: { value: won, origin: 'Leads marcados como ganhos no período' },
          wonValueCents: { value: wonValue, origin: 'Soma do valor dos leads ganhos no período' },
          avgTicketCents: { value: won ? Math.round(wonValue / won) : 0, origin: 'Valor ganho ÷ negócios ganhos' },
          conversionRate: { value: won + lost ? won / (won + lost) : 0, origin: 'Ganhos ÷ (ganhos + perdidos) fechados no período' },
          salesCycleDays: { value: kpi.cycle_days ? Number(Number(kpi.cycle_days).toFixed(1)) : 0, origin: 'Média de dias entre criação e ganho' },
          forecastCents: { value: forecast, origin: 'Σ propostas em aberto com fechamento previsto até o fim do mês (inclui atrasadas)' },
        },
        revenueBySeller: bySeller.rows.map((r) => ({ seller: r.seller, won: Number(r.won), valueCents: Number(r.value_cents) })),
        byChannel: byChannel.rows.map((r) => ({ channel: r.channel, leads: Number(r.leads), won: Number(r.won), valueCents: Number(r.value_cents) })),
        funnel: funnel.rows.map((r) => ({ stageId: r.id, name: r.name, kind: r.kind, pipeline: r.pipeline_name, leads: Number(r.leads), valueCents: Number(r.value_cents) })),
        alerts: { stalledLeads: Number(alerts.stalled), overdueActivities: Number(alerts.overdue) },
        forecastByTemperature: { hot: Number(fc.rows[0].hot), warm: Number(fc.rows[0].warm), cold: Number(fc.rows[0].cold), proposals: Number(fc.rows[0].n) },
      };
    });
  });

  /**
   * Metas x Receita por mês (últimos N meses). Receita = soma dos leads ganhos no mês
   * (mesma regra do "Valor vendido"). Meta = meta de receita gravada para o mês.
   */
  app.get('/dashboard/revenue-goals', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const q = z.object({ months: z.coerce.number().int().min(3).max(36).default(12), pipelineId: z.string().uuid().optional() }).parse(req.query);
    const mine = !atLeast(a.role, 'manager');
    return deps.db.withAuth(a, async (c) => {
      if (q.pipelineId && !(await c.query('SELECT 1 FROM pipelines WHERE id = $1', [q.pipelineId])).rowCount) throw notFound('Funil não encontrado');
      const r = await c.query(
        `WITH months AS (
           SELECT generate_series(date_trunc('month', now()) - make_interval(months => $1 - 1), date_trunc('month', now()), interval '1 month')::date AS m)
         SELECT to_char(m.m, 'YYYY-MM') AS month,
                (SELECT target FROM metric_goals g WHERE g.metric = 'revenue' AND g.month = m.m) AS goal,
                (SELECT coalesce(sum(l.value_cents), 0) FROM leads l
                  WHERE l.status = 'won' AND l.closed_at >= m.m AND l.closed_at < m.m + interval '1 month'
                    ${mine ? 'AND l.owner_id = $2' : 'AND $2::uuid IS NULL'}
                    AND ($3::uuid IS NULL OR l.stage_id IN (SELECT id FROM pipeline_stages WHERE pipeline_id = $3))) AS revenue
           FROM months m ORDER BY m.m`,
        [q.months, mine ? a.userId : null, q.pipelineId ?? null],
      );
      return r.rows.map((x) => ({ month: x.month, goalCents: x.goal === null ? null : Number(x.goal), revenueCents: Number(x.revenue) }));
    });
  });

  /** Define (ou apaga, com null) a meta de receita do mês. Gerente para cima. */
  app.put('/dashboard/revenue-goals', { preHandler: guard(deps, 'manager') }, async (req) => {
    const a = authOf(req);
    const b = z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês no formato AAAA-MM'),
      targetCents: z.number().int().min(0).max(1e13).nullable(),
    }).parse(req.body);
    const month = `${b.month}-01`;
    return deps.db.withAuth(a, async (c) => {
      if (b.targetCents === null) {
        await c.query(`DELETE FROM metric_goals WHERE metric = 'revenue' AND month = $1::date`, [month]);
      } else {
        await c.query(
          `INSERT INTO metric_goals (tenant_id, metric, month, target, updated_by) VALUES ($1, 'revenue', $2::date, $3, $4)
           ON CONFLICT (tenant_id, metric, month) DO UPDATE SET target = EXCLUDED.target, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [a.tenantId, month, b.targetCents, a.userId],
        );
      }
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'goal.revenue_set', metadata: b, ip: req.ip });
      return { ok: true };
    });
  });
}
