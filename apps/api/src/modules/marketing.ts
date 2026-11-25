import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Client } from '../db/db.js';
import { authOf } from '../auth/guards.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/limits.js';
import { SOURCES, SOURCE_KEYS, SOURCE_LABEL } from '../lib/sources.js';
import { guard, idParam, optionalText, params } from './common.js';

/**
 * Painel de Marketing (gerente para cima).
 *
 * Definições (o painel mostra a "origem" de cada uma):
 *  - Leads: leads CRIADOS no período
 *  - Deals: leads cuja PRIMEIRA PROPOSTA foi criada no período (oportunidade gerada)
 *  - Gains: leads GANHOS no período (data de fechamento); receita = valor desses leads
 *  - Lost: leads PERDIDOS no período
 *  - Cost: investimento lançado com data no período (marketing_spend)
 *  - CPL = cost/leads · CPD = cost/deals · CAC = cost/gains · ROI = (receita − cost)/cost
 * Datas em America/Sao_Paulo. Período anterior = mesmo número de dias, logo antes.
 */
const TZ = 'America/Sao_Paulo';
const MAX_DAYS = 400;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD');
const dashQuery = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  scope: z.enum(['all', 'mine']).default('all'),
});
const spendBody = z.object({
  source: z.enum(SOURCE_KEYS),
  campaign: optionalText(120),
  spentOn: dateStr,
  amountCents: z.number().int().min(0).max(1e12),
  notes: optionalText(500),
});
const METRICS = ['cost', 'leads', 'deals', 'gains', 'cpl', 'cpd', 'cac', 'roi'] as const;
const ADDITIVE = new Set(['cost', 'leads', 'deals', 'gains']);
const goalBody = z.object({
  metric: z.enum(METRICS),
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Use AAAA-MM'),
  target: z.number().min(-1e12).max(1e12).nullable(),
});

interface Counts {
  cost: number;
  leads: number;
  deals: number;
  gains: number;
  lost: number;
  revenue: number;
}
const zero = (): Counts => ({ cost: 0, leads: 0, deals: 0, gains: 0, lost: 0, revenue: 0 });

function ratios(c: Counts) {
  return {
    cpl: c.leads ? Math.round(c.cost / c.leads) : null,
    cpd: c.deals ? Math.round(c.cost / c.deals) : null,
    cac: c.gains ? Math.round(c.cost / c.gains) : null,
    roi: c.cost ? (c.revenue - c.cost) / c.cost : null,
  };
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
function todaySP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Contagens por fonte e campanha no intervalo [from, toExclusive). */
async function countsBySourceCampaign(c: Client, from: string, toExcl: string, ownerId: string | null) {
  const leads = await c.query(
    `WITH fp AS (SELECT lead_id, min(created_at) AS first_at FROM proposals GROUP BY lead_id),
          b AS (SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS f, ($2::date)::timestamp AT TIME ZONE '${TZ}' AS t)
     SELECT l.channel AS source, coalesce(l.campaign, '') AS campaign,
            count(*) FILTER (WHERE l.created_at >= b.f AND l.created_at < b.t) AS leads,
            count(*) FILTER (WHERE fp.first_at >= b.f AND fp.first_at < b.t) AS deals,
            count(*) FILTER (WHERE l.status = 'won' AND l.closed_at >= b.f AND l.closed_at < b.t) AS gains,
            coalesce(sum(l.value_cents) FILTER (WHERE l.status = 'won' AND l.closed_at >= b.f AND l.closed_at < b.t), 0) AS revenue,
            count(*) FILTER (WHERE l.status = 'lost' AND l.closed_at >= b.f AND l.closed_at < b.t) AS lost
       FROM leads l CROSS JOIN b LEFT JOIN fp ON fp.lead_id = l.id
      WHERE ($3::uuid IS NULL OR l.owner_id = $3 OR l.owner_id IS NULL)
      GROUP BY 1, 2`,
    [from, toExcl, ownerId],
  );
  // Investimento é da empresa (não tem responsável): não muda com o filtro "meus"
  const spend = await c.query(
    `SELECT source, coalesce(campaign, '') AS campaign, sum(amount_cents) AS cost
       FROM marketing_spend WHERE spent_on >= $1::date AND spent_on < $2::date GROUP BY 1, 2`,
    [from, toExcl],
  );
  const map = new Map<string, Map<string, Counts>>();
  const at = (s: string, camp: string) => {
    if (!map.has(s)) map.set(s, new Map());
    const m = map.get(s)!;
    if (!m.has(camp)) m.set(camp, zero());
    return m.get(camp)!;
  };
  for (const r of leads.rows) {
    const x = at(r.source, r.campaign);
    x.leads += Number(r.leads); x.deals += Number(r.deals); x.gains += Number(r.gains);
    x.revenue += Number(r.revenue); x.lost += Number(r.lost);
  }
  for (const r of spend.rows) at(r.source, r.campaign).cost += Number(r.cost);
  return map;
}

function sum(list: Iterable<Counts>): Counts {
  const t = zero();
  for (const c of list) for (const k of Object.keys(t) as (keyof Counts)[]) t[k] += c[k];
  return t;
}

export async function marketingRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const pre = { preHandler: guard(deps, 'manager') };

  app.get('/marketing', pre, async (req) => {
    const a = authOf(req);
    const q = dashQuery.parse(req.query);
    const to = q.to ?? todaySP();
    const from = q.from ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw unprocessable('A data inicial é depois da final', 'invalid_range');
    const days = daysBetween(from, to) + 1;
    if (days > MAX_DAYS) throw unprocessable(`Período máximo de ${MAX_DAYS} dias`, 'invalid_range');
    const toExcl = addDays(to, 1);
    const prevFrom = addDays(from, -days);
    const ownerId = q.scope === 'mine' ? a.userId : null;

    return db.withAuth(a, async (c) => {
      const cur = await countsBySourceCampaign(c, from, toExcl, ownerId);
      const prev = await countsBySourceCampaign(c, prevFrom, from, ownerId);

      // Metas: aditivas somam os meses do período; razões usam a meta do mês final
      const goalsRows = (
        await c.query(
          `SELECT metric, to_char(month, 'YYYY-MM') AS month, target FROM metric_goals
            WHERE month >= date_trunc('month', $1::date) AND month <= date_trunc('month', $2::date)`,
          [from, to],
        )
      ).rows;
      const lastMonth = to.slice(0, 7);
      const goals: Record<string, number | null> = {};
      for (const m of METRICS) {
        const rows = goalsRows.filter((g) => g.metric === m);
        if (!rows.length) { goals[m] = null; continue; }
        goals[m] = ADDITIVE.has(m)
          ? rows.reduce((s, g) => s + Number(g.target), 0)
          : (rows.find((g) => g.month === lastMonth) ? Number(rows.find((g) => g.month === lastMonth)!.target) : null);
      }

      const totalCur = sum([...cur.values()].flatMap((m) => [...m.values()]));
      const totalPrev = sum([...prev.values()].flatMap((m) => [...m.values()]));
      const rc = ratios(totalCur);
      const rp = ratios(totalPrev);
      const kpi = (key: string, value: number | null, previous: number | null, origin: string, better: 'up' | 'down') =>
        ({ key, value, previous, goal: goals[key] ?? null, better, origin });

      // Todas as fontes conhecidas aparecem (mesmo zeradas); legado e desconhecidas só se tiverem dados
      const known = SOURCES.map(([k]) => k as string);
      const withData = new Set([...cur.keys(), ...prev.keys()]);
      const LEGACY_FROM = known.indexOf('site');
      const sourceKeys = [
        ...known.filter((k, i) => i < LEGACY_FROM || withData.has(k)),
        ...[...withData].filter((k) => !known.includes(k)).sort(),
      ];

      const bySource = sourceKeys.map((s) => {
        const cm = cur.get(s) ?? new Map<string, Counts>();
        const pm = prev.get(s) ?? new Map<string, Counts>();
        const t = sum(cm.values());
        const p = sum(pm.values());
        const campaigns = [...new Set([...cm.keys(), ...pm.keys()])]
          .filter((k) => k !== '')
          .sort()
          .map((k) => {
            const x = cm.get(k) ?? zero();
            const y = pm.get(k) ?? zero();
            return { campaign: k, ...x, ...ratios(x), previous: { leads: y.leads, deals: y.deals, gains: y.gains, lost: y.lost } };
          });
        return {
          source: s,
          label: SOURCE_LABEL[s] ?? s,
          ...t,
          ...ratios(t),
          previous: { leads: p.leads, deals: p.deals, gains: p.gains, lost: p.lost, cost: p.cost },
          campaigns,
          // Leads/ganhos sem campanha ficam na própria linha da fonte
          withoutCampaign: cm.get('') ?? zero(),
        };
      });

      return {
        period: { from, to, previousFrom: prevFrom, previousTo: addDays(from, -1), days, scope: q.scope },
        kpis: [
          kpi('cost', totalCur.cost, totalPrev.cost, 'Soma dos investimentos lançados com data no período (da empresa toda)', 'down'),
          kpi('leads', totalCur.leads, totalPrev.leads, 'Leads criados no período', 'up'),
          kpi('deals', totalCur.deals, totalPrev.deals, 'Leads cuja primeira proposta foi criada no período', 'up'),
          kpi('gains', totalCur.gains, totalPrev.gains, 'Leads ganhos (fechados) no período', 'up'),
          kpi('cpl', rc.cpl, rp.cpl, 'Custo ÷ leads', 'down'),
          kpi('cpd', rc.cpd, rp.cpd, 'Custo ÷ deals', 'down'),
          kpi('cac', rc.cac, rp.cac, 'Custo ÷ ganhos (custo de aquisição de cliente)', 'down'),
          kpi('roi', rc.roi, rp.roi, '(Receita dos ganhos − custo) ÷ custo', 'up'),
        ],
        totals: { ...totalCur, ...rc, previous: { leads: totalPrev.leads, deals: totalPrev.deals, gains: totalPrev.gains, lost: totalPrev.lost, cost: totalPrev.cost } },
        bySource,
        sources: SOURCES.map(([key, label]) => ({ key, label })),
      };
    });
  });

  app.get('/marketing/spend', pre, async (req) => {
    const a = authOf(req);
    const q = z.object({ from: dateStr, to: dateStr }).parse(req.query);
    return db.withAuth(a, async (c) =>
      (
        await c.query(
          `SELECT s.id, s.source, s.campaign, to_char(s.spent_on, 'YYYY-MM-DD') AS spent_on, s.amount_cents, s.notes,
                  u.name AS created_by_name, s.created_at
             FROM marketing_spend s LEFT JOIN users u ON u.id = s.created_by
            WHERE s.spent_on >= $1::date AND s.spent_on <= $2::date
            ORDER BY s.spent_on DESC, s.created_at DESC LIMIT 500`,
          [q.from, q.to],
        )
      ).rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents), label: SOURCE_LABEL[r.source] ?? r.source })),
    );
  });

  app.post('/marketing/spend', pre, async (req, reply) => {
    const a = authOf(req);
    const b = spendBody.parse(req.body);
    const row = await db.withAuth(a, async (c) => {
      const r = await c.query(
        `INSERT INTO marketing_spend (tenant_id, source, campaign, spent_on, amount_cents, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, source, campaign, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, amount_cents`,
        [a.tenantId, b.source, b.campaign, b.spentOn, b.amountCents, b.notes, a.userId],
      );
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'marketing.spend_created', targetId: r.rows[0].id, metadata: { source: b.source, amountCents: b.amountCents }, ip: req.ip });
      return r.rows[0];
    });
    return reply.status(201).send({ ...row, amount_cents: Number(row.amount_cents) });
  });

  app.delete('/marketing/spend/:id', pre, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const r = await c.query('DELETE FROM marketing_spend WHERE id = $1 RETURNING id', [id]);
      if (!r.rowCount) throw notFound('Lançamento não encontrado');
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'marketing.spend_deleted', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  /** Define (ou remove, com target null) a meta de um indicador para um mês. */
  app.put('/marketing/goals', pre, async (req) => {
    const a = authOf(req);
    const b = goalBody.parse(req.body);
    const month = `${b.month}-01`;
    return db.withAuth(a, async (c) => {
      if (b.target === null) {
        await c.query('DELETE FROM metric_goals WHERE metric = $1 AND month = $2::date', [b.metric, month]);
      } else {
        await c.query(
          `INSERT INTO metric_goals (tenant_id, metric, month, target, updated_by) VALUES ($1, $2, $3::date, $4, $5)
           ON CONFLICT (tenant_id, metric, month) DO UPDATE SET target = EXCLUDED.target, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [a.tenantId, b.metric, month, b.target, a.userId],
        );
      }
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'marketing.goal_set', metadata: b, ip: req.ip });
      return { ok: true };
    });
  });
}
