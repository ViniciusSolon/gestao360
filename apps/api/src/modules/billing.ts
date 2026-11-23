import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { authOf } from '../auth/guards.js';
import { conflict, notFound } from '../lib/errors.js';
import { idempotentExternal } from '../lib/idempotency.js';
import { audit } from '../lib/limits.js';
import { sessionOnly } from './common.js';

const checkoutBody = z.object({ planCode: z.string().min(1).max(40) });

export async function billingRoutes(app: FastifyInstance, deps: Deps) {
  const { db, gateway, config } = deps;

  // Disponível mesmo com conta bloqueada, para o cliente conseguir pagar
  app.get('/billing', { preHandler: sessionOnly(deps) }, async (req) => {
    const a = authOf(req);
    return db.withAuth(a, async (c) => {
      const t = (
        await c.query(
          `SELECT t.status, t.trial_ends_at, t.seats_used, t.leads_count, p.code AS plan_code, p.name AS plan_name,
                  p.max_users, p.max_leads, p.price_cents
             FROM tenants t JOIN plans p ON p.id = t.plan_id`,
        )
      ).rows[0];
      const sub = (await c.query('SELECT status, current_period_end FROM subscriptions')).rows[0] ?? null;
      const plans = (await c.query('SELECT code, name, price_cents, max_users, max_leads FROM plans WHERE public ORDER BY price_cents')).rows;
      return { tenant: t, subscription: sub, plans };
    });
  });

  /**
   * Inicia o checkout. Idempotência em duas camadas:
   * 1) header Idempotency-Key do cliente → mesma resposta para a mesma chave;
   * 2) billing_operations guarda UMA chave UUID por operação de negócio
   *    (tenant + plano), reaproveitada em toda nova tentativa ao gateway.
   * O preço vem do cadastro do plano no servidor; o cliente só escolhe o código.
   */
  app.post('/billing/checkout', { preHandler: sessionOnly(deps, 'owner') }, async (req, reply) => {
    const a = authOf(req);
    const b = checkoutBody.parse(req.body);
    const res = await idempotentExternal(db, req, a, 'POST /billing/checkout', async () => {
      const op = await db.withAuth(a, async (c) => {
        const plan = (await c.query('SELECT id, code, gateway_price_id FROM plans WHERE code = $1 AND public', [b.planCode])).rows[0];
        if (!plan) throw notFound('Plano não encontrado');
        const t = (await c.query('SELECT status, plan_id FROM tenants')).rows[0];
        if (t.status === 'active' && t.plan_id === plan.id) throw conflict('Você já está neste plano', 'already_subscribed');
        await c.query(
          `INSERT INTO billing_operations (tenant_id, kind, plan_id, idempotency_key)
           VALUES ($1, 'checkout', $2, $3) ON CONFLICT DO NOTHING`,
          [a.tenantId, plan.id, randomUUID()],
        );
        const row = (
          await c.query(`SELECT id, idempotency_key FROM billing_operations WHERE kind = 'checkout' AND plan_id = $1 AND status = 'pending'`, [plan.id])
        ).rows[0];
        return { ...row, plan };
      });

      const session = await gateway.createCheckoutSession(
        {
          tenantId: a.tenantId,
          planCode: op.plan.code,
          gatewayPriceId: op.plan.gateway_price_id,
          successUrl: `${config.APP_PUBLIC_URL}/app/assinatura?status=ok`,
          cancelUrl: `${config.APP_PUBLIC_URL}/app/assinatura?status=cancelado`,
        },
        op.idempotency_key,
      );
      await db.withAuth(a, async (c) => {
        await c.query('UPDATE billing_operations SET provider_ref = $2, checkout_url = $3 WHERE id = $1', [op.id, session.id, session.url]);
        await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'billing.checkout_started', metadata: { plan: op.plan.code }, ip: req.ip });
      });
      return { status: 201, body: { checkoutUrl: session.url, sessionId: session.id } };
    });
    return reply.status(res.status).send(res.body);
  });
}
