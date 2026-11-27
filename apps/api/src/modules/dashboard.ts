import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { authOf } from '../auth/guards.js';
import { atLeast } from '../auth/roles.js';
import { guard } from './common.js';

const query = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
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
    const scope = mine ? 'AND l.owner_id = $3' : 'AND $3::uuid IS NULL';
    const p = [from, to, mine ? a.userId : null];

    return deps.db.withAuth(a, async (c) => {
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
          GROUP BY s.id, pl.id ORDER BY pl.position, pl.created_at, s.position`,
        [mine ? a.userId : null],
      );
      const forecast = funnel.rows
        .filter((s) => s.kind === 'open')
        .reduce((acc, s) => acc + Math.round((Number(s.value_cents) * s.probability) / 100), 0);
      const alerts = (
        await c.query(
          `SELECT
             (SELECT count(*) FROM leads l WHERE l.status = 'open' AND l.updated_at < now() - interval '14 days' ${mine ? 'AND l.owner_id = $1' : 'AND $1::uuid IS NULL'}) AS stalled,
             (SELECT count(*) FROM activities act WHERE act.done_at IS NULL AND act.due_at < now() ${mine ? 'AND act.assigned_to = $1' : ''}) AS overdue`,
          [mine ? a.userId : null],
        )
      ).rows[0];

      const won = Number(kpi.won);
      const lost = Number(kpi.lost);
      const wonValue = Number(kpi.won_value);
      return {
        period: { from, to, scope: mine ? 'meus leads' : 'empresa' },
        kpis: {
          leads: { value: Number(kpi.leads), origin: 'Leads criados no período' },
          mqls: { value: Number(kpi.mqls), origin: 'Leads do período com pontuação ≥ 50' },
          wonCount: { value: won, origin: 'Leads marcados como ganhos no período' },
          wonValueCents: { value: wonValue, origin: 'Soma do valor dos leads ganhos no período' },
          avgTicketCents: { value: won ? Math.round(wonValue / won) : 0, origin: 'Valor ganho ÷ negócios ganhos' },
          conversionRate: { value: won + lost ? won / (won + lost) : 0, origin: 'Ganhos ÷ (ganhos + perdidos) fechados no período' },
          salesCycleDays: { value: kpi.cycle_days ? Number(Number(kpi.cycle_days).toFixed(1)) : 0, origin: 'Média de dias entre criação e ganho' },
          forecastCents: { value: forecast, origin: 'Σ valor dos leads abertos × probabilidade da etapa' },
        },
        revenueBySeller: bySeller.rows.map((r) => ({ seller: r.seller, won: Number(r.won), valueCents: Number(r.value_cents) })),
        byChannel: byChannel.rows.map((r) => ({ channel: r.channel, leads: Number(r.leads), won: Number(r.won), valueCents: Number(r.value_cents) })),
        funnel: funnel.rows.map((r) => ({ stageId: r.id, name: r.name, kind: r.kind, pipeline: r.pipeline_name, leads: Number(r.leads), valueCents: Number(r.value_cents) })),
        alerts: { stalledLeads: Number(alerts.stalled), overdueActivities: Number(alerts.overdue) },
      };
    });
  });
}
