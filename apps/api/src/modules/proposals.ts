import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Client } from '../db/db.js';
import { authOf, type TenantAuth } from '../auth/guards.js';
import { atLeast } from '../auth/roles.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { idempotentTx } from '../lib/idempotency.js';
import { audit, nextCounter } from '../lib/limits.js';
import { assertDiscountAllowed, priceItem, sumTotals, type PricedItem } from '../lib/pricing.js';
import { guard, idParam, optionalText, params } from './common.js';
import { loadVisibleLead } from './leads.js';

const proposalBody = z.object({
  leadId: z.string().uuid(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().positive().max(1_000_000),
        discountPercent: z.number().min(0).max(100).default(0),
      }),
    )
    .min(1)
    .max(200),
  freightCents: z.number().int().min(0).default(0),
  paymentTerms: optionalText(500),
  validUntil: z.string().date().optional().nullable(),
  notes: optionalText(5000),
});

/** Busca proposta visível ao usuário (vendedor: só de leads visíveis a ele). */
async function loadVisibleProposal(c: Client, a: TenantAuth, id: string, forUpdate = false) {
  const p = (await c.query(`SELECT * FROM proposals WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!p) throw notFound('Proposta não encontrada');
  await loadVisibleLead(c, a, p.lead_id).catch(() => {
    throw notFound('Proposta não encontrada');
  });
  return p;
}

const brl = (cents: number | string) =>
  (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function renderPdf(data: { tenantName: string; proposal: any; lead: any; items: any[] }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const { proposal: p, lead, items, tenantName } = data;

    doc.fontSize(18).fillColor('#0f172a').text(tenantName, { continued: false });
    doc.fontSize(12).fillColor('#475569').text(`Proposta comercial nº ${p.number}`);
    doc.text(`Emitida em ${new Date(p.created_at).toLocaleDateString('pt-BR')}`);
    if (p.valid_until) doc.text(`Válida até ${new Date(p.valid_until).toLocaleDateString('pt-BR')}`);
    doc.moveDown();
    doc.fillColor('#0f172a').fontSize(12).text(`Cliente: ${lead.name}${lead.company ? ` — ${lead.company}` : ''}`);
    doc.moveDown();

    const cols = [50, 250, 310, 390, 470];
    doc.fontSize(9).fillColor('#475569');
    ['Item', 'Qtd.', 'Unitário', 'Desc.', 'Total'].forEach((h, i) => doc.text(h, cols[i], doc.y, { continued: false, lineBreak: false }));
    doc.moveDown();
    doc.fillColor('#0f172a');
    for (const it of items) {
      const y = doc.y;
      doc.text(String(it.description), cols[0], y, { width: 190 });
      const yEnd = doc.y;
      doc.text(String(Number(it.quantity)), cols[1], y, { lineBreak: false });
      doc.text(brl(it.unit_price_cents), cols[2], y, { lineBreak: false });
      doc.text(`${it.discount_bp / 100}%`, cols[3], y, { lineBreak: false });
      doc.text(brl(it.total_cents), cols[4], y, { lineBreak: false });
      doc.y = Math.max(yEnd, y + 14);
    }
    doc.moveDown();
    doc.x = 50;
    const line = (label: string, v: number | string) => doc.fontSize(10).text(`${label}: ${brl(v)}`, 300, doc.y, { align: 'right', width: 245 });
    line('Subtotal', p.subtotal_cents);
    line('Descontos', p.discount_cents);
    line('Tributos (estimativa)', p.tax_cents);
    line('Frete', p.freight_cents);
    doc.fontSize(13).text(`Total: ${brl(p.total_cents)}`, 300, doc.y, { align: 'right', width: 245 });
    doc.x = 50;
    doc.moveDown();
    if (p.payment_terms) doc.fontSize(10).text(`Condições de pagamento: ${p.payment_terms}`, 50);
    if (p.notes) doc.fontSize(10).text(`Observações: ${p.notes}`, 50);
    doc.moveDown().fontSize(8).fillColor('#64748b').text('Tributos estimados com base no cadastro do produto. Não substitui documento fiscal.', 50);
    doc.end();
  });
}

export async function proposalRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  app.get('/proposals', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { leadId } = z.object({ leadId: z.string().uuid().optional() }).parse(req.query);
    return db.withAuth(a, async (c) => {
      const scope = atLeast(a.role, 'manager') ? 'true' : '(l.owner_id = $2 OR l.owner_id IS NULL)';
      const r = await c.query(
        `SELECT p.id, p.number, p.status, p.total_cents, p.created_at, p.lead_id, l.name AS lead_name, l.company
           FROM proposals p JOIN leads l ON l.id = p.lead_id
          WHERE ($1::uuid IS NULL OR p.lead_id = $1) AND ${scope}
          ORDER BY p.number DESC LIMIT 500`,
        atLeast(a.role, 'manager') ? [leadId ?? null] : [leadId ?? null, a.userId],
      );
      return r.rows;
    });
  });

  /** Cria proposta. Preços e tributos vêm do banco; o cliente só informa produto, quantidade e desconto. */
  app.post('/proposals', { preHandler: guard(deps) }, async (req, reply) => {
    const a = authOf(req);
    const b = proposalBody.parse(req.body);
    const discounts = b.items.map((i) => Math.round(i.discountPercent * 100));
    discounts.forEach((d) => assertDiscountAllowed(a.role, d));

    const res = await idempotentTx(db, req, a, 'POST /proposals', async (c) => {
      await loadVisibleLead(c, a, b.leadId);
      const ids = [...new Set(b.items.map((i) => i.productId))];
      const prods = (
        await c.query(`SELECT id, name, price_cents, tax_rate_bp FROM products WHERE id = ANY($1::uuid[]) AND active`, [ids])
      ).rows;
      const byId = new Map(prods.map((p) => [p.id, p]));
      const priced: PricedItem[] = b.items.map((it, idx) => {
        const p = byId.get(it.productId);
        if (!p) throw unprocessable('Produto inexistente ou inativo', 'invalid_product');
        return priceItem(
          { id: p.id, name: p.name, priceCents: Number(p.price_cents), taxRateBp: p.tax_rate_bp },
          { productId: it.productId, quantity: it.quantity, discountBp: discounts[idx] },
        );
      });
      const t = sumTotals(priced, b.freightCents);
      const number = await nextCounter(c, a.tenantId, 'proposal');
      const p = (
        await c.query(
          `INSERT INTO proposals (tenant_id, number, lead_id, subtotal_cents, discount_cents, tax_cents, freight_cents, total_cents,
                                  payment_terms, valid_until, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [a.tenantId, number, b.leadId, t.subtotalCents, t.discountCents, t.taxCents, t.freightCents, t.totalCents, b.paymentTerms, b.validUntil ?? null, b.notes, a.userId],
        )
      ).rows[0];
      for (const [i, it] of priced.entries()) {
        await c.query(
          `INSERT INTO proposal_items (tenant_id, proposal_id, product_id, description, quantity, unit_price_cents, discount_bp, tax_rate_bp, total_cents, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [a.tenantId, p.id, it.productId, it.description, it.quantity, it.unitPriceCents, it.discountBp, it.taxRateBp, it.totalCents, i],
        );
      }
      await c.query(`INSERT INTO lead_events (tenant_id, lead_id, user_id, type, data) VALUES ($1,$2,$3,'proposal_created',$4)`, [
        a.tenantId, b.leadId, a.userId, JSON.stringify({ proposalId: p.id, number, totalCents: t.totalCents }),
      ]);
      return { status: 201, body: { ...p, items: priced } };
    });
    return reply.status(res.status).send(res.body);
  });

  app.get('/proposals/:id', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const p = await loadVisibleProposal(c, a, id);
      const items = (await c.query('SELECT * FROM proposal_items WHERE proposal_id = $1 ORDER BY position', [id])).rows;
      return { ...p, items };
    });
  });

  async function transition(req: any, from: string, to: string, extra: (c: Client, p: any, a: TenantAuth) => Promise<void> = async () => {}) {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const p = await loadVisibleProposal(c, a, id, true);
      // Atômico: só transiciona se o status atual for o esperado
      const col = to === 'sent' ? 'sent_at' : 'decided_at';
      const r = await c.query(`UPDATE proposals SET status = $2, ${col} = now() WHERE id = $1 AND status = $3 RETURNING *`, [id, to, from]);
      if (!r.rowCount) throw conflict(`Proposta não está em "${from}" (atual: ${p.status})`, 'invalid_status');
      await extra(c, r.rows[0], a);
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: `proposal.${to}`, targetType: 'proposal', targetId: id, ip: req.ip });
      return r.rows[0];
    });
  }

  app.post('/proposals/:id/send', { preHandler: guard(deps) }, (req) => transition(req, 'draft', 'sent'));
  app.post('/proposals/:id/reject', { preHandler: guard(deps) }, (req) => transition(req, 'sent', 'rejected'));
  app.post('/proposals/:id/accept', { preHandler: guard(deps) }, (req) =>
    transition(req, 'sent', 'accepted', async (c, p, a) => {
      const won = (await c.query(`SELECT id FROM pipeline_stages WHERE kind = 'won' ORDER BY position LIMIT 1`)).rows[0];
      await c.query(
        `UPDATE leads SET status = 'won', stage_id = coalesce($2, stage_id), value_cents = $3, closed_at = now(), updated_at = now()
          WHERE id = $1`,
        [p.lead_id, won?.id ?? null, p.total_cents],
      );
      await c.query(`INSERT INTO lead_events (tenant_id, lead_id, user_id, type, data) VALUES ($1,$2,$3,'proposal_accepted',$4)`, [
        a.tenantId, p.lead_id, a.userId, JSON.stringify({ proposalId: p.id, number: p.number }),
      ]);
    }),
  );

  app.get('/proposals/:id/pdf', { preHandler: guard(deps) }, async (req, reply) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const data = await db.withAuth(a, async (c) => {
      const proposal = await loadVisibleProposal(c, a, id);
      const lead = (await c.query('SELECT name, company FROM leads WHERE id = $1', [proposal.lead_id])).rows[0];
      const items = (await c.query('SELECT * FROM proposal_items WHERE proposal_id = $1 ORDER BY position', [id])).rows;
      return { tenantName: a.tenantName, proposal, lead, items };
    });
    const pdf = await renderPdf(data);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="proposta-${data.proposal.number}.pdf"`)
      .send(pdf);
  });
}
