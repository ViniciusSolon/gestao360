import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Client } from '../db/db.js';
import { authOf } from '../auth/guards.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/limits.js';
import { isMobile, normalizeBrPhone } from '../lib/phone.js';
import { verifyOptOut } from '../lib/secretbox.js';
import { SOURCE_KEYS } from '../lib/sources.js';
import { throttle } from '../lib/throttle.js';
import { enqueue } from '../jobs/queue.js';
import { smsSegments } from '../messaging/render.js';
import type { Channel } from '../messaging/providers.js';
import { CHANNELS, requireChannelKey } from './channels.js';
import { guard, idParam, params } from './common.js';

/** Máximo de destinatários por campanha no MVP (proteção contra disparo acidental gigante). */
export const MAX_RECIPIENTS = 20000;

const audienceSchema = z.object({
  stageIds: z.array(z.string().uuid()).max(50).default([]),
  sources: z.array(z.enum(SOURCE_KEYS)).max(30).default([]),
  statuses: z.array(z.enum(['open', 'won', 'lost'])).max(3).default([]),
  mqlOnly: z.boolean().default(false),
});
type Audience = z.infer<typeof audienceSchema>;

const CONTENT = {
  email: z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000) }),
  sms: z.object({ text: z.string().trim().min(1).max(480) }),
  whatsapp: z.object({
    template: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Nome do template: letras minúsculas, números e _ (como está na Meta)'),
    language: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'Ex.: pt_BR').default('pt_BR'),
    params: z.array(z.string().max(1024)).max(10).default([]),
  }),
};

const createBody = z.object({
  channel: z.enum(CHANNELS),
  name: z.string().trim().min(1).max(120),
  audience: audienceSchema.default({ stageIds: [], sources: [], statuses: [], mqlOnly: false }),
  content: z.record(z.string(), z.unknown()),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
});
const patchBody = createBody.omit({ channel: true }).partial();

function parseContent(channel: Channel, content: unknown) {
  return CONTENT[channel].parse(content);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Monta a lista de destinatários a partir dos filtros: endereço válido para o canal,
 * sem descadastro, sem endereço repetido. Usado na prévia e no envio.
 */
export async function buildRecipients(c: Client, channel: Channel, a: Audience) {
  const leads = (
    await c.query(
      `SELECT id, name, company, email, phone FROM leads
        WHERE (cardinality($1::uuid[]) = 0 OR stage_id = ANY($1))
          AND (cardinality($2::text[]) = 0 OR channel = ANY($2))
          AND (cardinality($3::text[]) = 0 OR status = ANY($3))
          AND (NOT $4 OR is_mql)
        ORDER BY created_at LIMIT ${MAX_RECIPIENTS * 2 + 1}`,
      [a.stageIds, a.sources, a.statuses, a.mqlOnly],
    )
  ).rows;
  const opted = new Set(
    (await c.query('SELECT address FROM contact_opt_outs WHERE channel = $1', [channel])).rows.map((r) => r.address as string),
  );
  const seen = new Set<string>();
  const list: { leadId: string; address: string; name: string; company: string | null }[] = [];
  let missing = 0, optedOut = 0, duplicates = 0;
  for (const l of leads) {
    let address: string | null = null;
    if (channel === 'email') address = l.email && EMAIL_RE.test(l.email) ? String(l.email).toLowerCase() : null;
    else {
      const p = normalizeBrPhone(l.phone);
      address = p && (channel === 'whatsapp' || isMobile(p)) ? p : null; // SMS só para celular
    }
    if (!address) { missing++; continue; }
    if (opted.has(address)) { optedOut++; continue; }
    if (seen.has(address)) { duplicates++; continue; }
    seen.add(address);
    list.push({ leadId: l.id, address, name: l.name, company: l.company });
  }
  return { matched: leads.length, reachable: list.length, missingAddress: missing, optedOut, duplicates, list };
}

async function stats(c: Client, campaignIds: string[]) {
  if (!campaignIds.length) return new Map<string, Record<string, number>>();
  const r = await c.query(
    `SELECT campaign_id, status, count(*) AS n FROM campaign_recipients WHERE campaign_id = ANY($1::uuid[]) GROUP BY 1, 2`,
    [campaignIds],
  );
  const m = new Map<string, Record<string, number>>();
  for (const row of r.rows) {
    const s = m.get(row.campaign_id) ?? { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    s[row.status] = Number(row.n);
    s.total += Number(row.n);
    m.set(row.campaign_id, s);
  }
  return m;
}
const emptyStats = () => ({ total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 });

export async function campaignRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const pre = { preHandler: guard(deps, 'manager') };

  app.get('/campaigns', pre, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) => {
      const rows = (
        await c.query(
          `SELECT c.id, c.channel, c.name, c.status, c.scheduled_at, c.started_at, c.finished_at, c.created_at, u.name AS created_by_name
             FROM campaigns c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.created_at DESC LIMIT 200`,
        )
      ).rows;
      const st = await stats(c, rows.map((r) => r.id));
      return rows.map((r) => ({ ...r, stats: st.get(r.id) ?? emptyStats() }));
    });
  });

  app.post('/campaigns', pre, async (req, reply) => {
    const a = authOf(req);
    const b = createBody.parse(req.body);
    const content = parseContent(b.channel, b.content);
    const row = await db.withAuth(a, async (c) => {
      const r = await c.query(
        `INSERT INTO campaigns (tenant_id, channel, name, audience, content, scheduled_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [a.tenantId, b.channel, b.name, JSON.stringify(b.audience), JSON.stringify(content), b.scheduledAt ?? null, a.userId],
      );
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'campaign.created', targetType: 'campaign', targetId: r.rows[0].id, ip: req.ip });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  app.get('/campaigns/:id', pre, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const camp = (await c.query('SELECT * FROM campaigns WHERE id = $1', [id])).rows[0];
      if (!camp) throw notFound('Campanha não encontrada');
      const st = (await stats(c, [id])).get(id) ?? emptyStats();
      const recipients = (
        await c.query(
          `SELECT r.id, r.lead_id, l.name AS lead_name, r.address, r.status, r.error, r.sent_at
             FROM campaign_recipients r LEFT JOIN leads l ON l.id = r.lead_id
            WHERE r.campaign_id = $1 ORDER BY (r.status = 'failed') DESC, r.id LIMIT 300`,
          [id],
        )
      ).rows;
      return { ...camp, stats: st, recipients };
    });
  });

  /** Edição só enquanto é rascunho (atômico: não edita campanha que acabou de ser enviada). */
  app.patch('/campaigns/:id', pre, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const b = patchBody.parse(req.body);
    return db.withAuth(a, async (c) => {
      const camp = (await c.query('SELECT channel FROM campaigns WHERE id = $1', [id])).rows[0];
      if (!camp) throw notFound('Campanha não encontrada');
      const content = b.content === undefined ? null : parseContent(camp.channel, b.content);
      const r = await c.query(
        `UPDATE campaigns SET name = coalesce($2, name), audience = coalesce($3, audience), content = coalesce($4, content),
                scheduled_at = CASE WHEN $5::boolean THEN $6::timestamptz ELSE scheduled_at END, updated_at = now()
          WHERE id = $1 AND status = 'draft' RETURNING *`,
        [id, b.name ?? null, b.audience ? JSON.stringify(b.audience) : null, content ? JSON.stringify(content) : null, b.scheduledAt !== undefined, b.scheduledAt ?? null],
      );
      if (!r.rowCount) throw conflict('Só é possível editar campanhas em rascunho', 'not_draft');
      return r.rows[0];
    });
  });

  app.delete('/campaigns/:id', pre, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const r = await c.query(`DELETE FROM campaigns WHERE id = $1 AND status = 'draft' RETURNING id`, [id]);
      if (!r.rowCount) throw conflict('Só é possível excluir rascunhos (campanhas enviadas ficam no histórico)', 'not_draft');
      return { ok: true };
    });
  });

  /** Prévia do público: quantos leads batem, quantos dá para alcançar e por quê os outros não. */
  app.post('/campaigns/audience-preview', pre, async (req) => {
    const a = authOf(req);
    const b = z.object({ channel: z.enum(CHANNELS), audience: audienceSchema }).parse(req.body);
    return db.withAuth(a, async (c) => {
      const r = await buildRecipients(c, b.channel, b.audience);
      return { matched: r.matched, reachable: r.reachable, missingAddress: r.missingAddress, optedOut: r.optedOut, duplicates: r.duplicates, sample: r.list.slice(0, 5).map((x) => ({ name: x.name, address: x.address })) };
    });
  });

  /** Contagem de caracteres/segmentos do SMS (estimativa de custo na tela). */
  app.post('/campaigns/sms-segments', pre, async (req) => {
    const { text } = z.object({ text: z.string().max(2000) }).parse(req.body);
    return smsSegments(text);
  });

  /**
   * Envia (ou agenda). Duplo clique não dispara duas vezes: a troca rascunho → agendada
   * é atômica; o segundo pedido recebe 409 e nada mais acontece.
   */
  app.post('/campaigns/:id/send', pre, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    requireChannelKey(deps);
    const result = await db.withAuth(a, async (c) => {
      const camp = (await c.query('SELECT * FROM campaigns WHERE id = $1', [id])).rows[0];
      if (!camp) throw notFound('Campanha não encontrada');
      const connected = (await c.query('SELECT 1 FROM tenant_channels WHERE channel = $1', [camp.channel])).rowCount;
      if (!connected) throw unprocessable('Conecte este canal em Marketing → Canais antes de enviar', 'channel_not_configured');
      const upd = await c.query(
        `UPDATE campaigns SET status = 'scheduled', updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING scheduled_at`,
        [id],
      );
      if (!upd.rowCount) throw conflict('Esta campanha já foi enviada ou agendada', 'already_sent');
      const r = await buildRecipients(c, camp.channel, audienceSchema.parse(camp.audience));
      if (!r.reachable) throw unprocessable('Nenhum destinatário alcançável com estes filtros', 'no_recipients');
      if (r.reachable > MAX_RECIPIENTS) throw unprocessable(`Máximo de ${MAX_RECIPIENTS} destinatários por campanha`, 'too_many_recipients');
      await c.query(
        `INSERT INTO campaign_recipients (tenant_id, campaign_id, lead_id, address, vars)
         SELECT $1, $2, x.lead_id, x.address, jsonb_build_object('name', x.name, 'company', x.company)
           FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[]) AS x(lead_id, address, name, company)
         ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
        [a.tenantId, id, r.list.map((x) => x.leadId), r.list.map((x) => x.address), r.list.map((x) => x.name), r.list.map((x) => x.company)],
      );
      const runAt: Date | null = upd.rows[0].scheduled_at && new Date(upd.rows[0].scheduled_at) > new Date() ? upd.rows[0].scheduled_at : null;
      await enqueue(c, { type: 'campaign.dispatch', tenantId: a.tenantId, payload: { campaignId: id, run: 0 }, dedupeKey: `campaign:${id}:0`, runAt: runAt ?? undefined });
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'campaign.sent', targetType: 'campaign', targetId: id, metadata: { recipients: r.reachable, scheduledAt: runAt }, ip: req.ip });
      return { recipients: r.reachable, scheduledAt: runAt, optedOut: r.optedOut, missingAddress: r.missingAddress, duplicates: r.duplicates };
    });
    return result;
  });

  app.post('/campaigns/:id/cancel', pre, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const r = await c.query(
        `UPDATE campaigns SET status = 'canceled', finished_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('scheduled', 'sending') RETURNING id`,
        [id],
      );
      if (!r.rowCount) throw conflict('Só dá para cancelar campanhas agendadas ou em envio', 'not_cancelable');
      await c.query(`UPDATE campaign_recipients SET status = 'skipped', error = 'Campanha cancelada' WHERE campaign_id = $1 AND status = 'pending'`, [id]);
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'campaign.canceled', targetType: 'campaign', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  // ---- Descadastros (manual, quando a pessoa pede por WhatsApp/telefone) ----
  const optOutBody = z.object({ channel: z.enum(CHANNELS), address: z.string().trim().min(3).max(254) });
  const normalizeAddress = (channel: Channel, address: string) => {
    if (channel === 'email') {
      const e = address.toLowerCase();
      if (!EMAIL_RE.test(e)) throw badRequest('E-mail inválido');
      return e;
    }
    const p = normalizeBrPhone(address);
    if (!p) throw badRequest('Telefone inválido (use DDD + número)');
    return p;
  };

  app.get('/opt-outs', pre, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) =>
      (await c.query('SELECT channel, address, source, created_at FROM contact_opt_outs ORDER BY created_at DESC LIMIT 1000')).rows,
    );
  });

  app.post('/opt-outs', pre, async (req, reply) => {
    const a = authOf(req);
    const b = optOutBody.parse(req.body);
    const address = normalizeAddress(b.channel, b.address);
    await db.withAuth(a, (c) =>
      c.query(`INSERT INTO contact_opt_outs (tenant_id, channel, address, source) VALUES ($1, $2, $3, 'manual') ON CONFLICT DO NOTHING`, [a.tenantId, b.channel, address]),
    );
    return reply.status(201).send({ channel: b.channel, address });
  });

  app.delete('/opt-outs', pre, async (req) => {
    const a = authOf(req);
    const b = optOutBody.parse(req.query);
    const address = normalizeAddress(b.channel, b.address);
    return db.withAuth(a, async (c) => {
      const r = await c.query('DELETE FROM contact_opt_outs WHERE channel = $1 AND address = $2 RETURNING address', [b.channel, address]);
      if (!r.rowCount) throw notFound('Descadastro não encontrado');
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'optout.removed', metadata: { channel: b.channel }, ip: req.ip });
      return { ok: true };
    });
  });
}

/**
 * Rotas públicas (sem login): descadastro pelo link do e-mail.
 * POST aceita também o "one-click" do Gmail/Outlook (RFC 8058: form-urlencoded).
 */
export async function publicRoutes(app: FastifyInstance, deps: Deps) {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  const handle = async (token: string | undefined, ip: string) => {
    await throttle(deps.db.app, [{ key: `unsubscribe:ip:${ip}`, max: 30, windowSeconds: 60 }]);
    const key = requireChannelKey(deps);
    const claim = token ? verifyOptOut(token, key) : null;
    if (!claim) throw badRequest('Link de descadastro inválido', 'invalid_token');
    await deps.db.withAnon((c) => c.query('SELECT record_opt_out($1, $2, $3)', [claim.t, claim.c, claim.a]));
    return { ok: true, channel: claim.c };
  };

  app.post('/unsubscribe', async (req) => {
    const q = (req.query as { token?: string }).token;
    const body = typeof req.body === 'object' && req.body ? (req.body as { token?: string }).token : undefined;
    return handle(q ?? body, req.ip);
  });
}
