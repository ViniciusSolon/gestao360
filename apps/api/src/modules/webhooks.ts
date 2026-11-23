import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { verifySignature, FakeGateway, signPayload } from '../billing/gateway.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';

/** Extrai o ID da assinatura de eventos relevantes; o resto é ignorado. */
export function subscriptionIdFrom(event: any): string | null {
  const obj = event?.data?.object ?? {};
  if (event?.type === 'checkout.session.completed') return typeof obj.subscription === 'string' ? obj.subscription : null;
  if (typeof event?.type === 'string' && event.type.startsWith('customer.subscription.')) return typeof obj.id === 'string' ? obj.id : null;
  if (event?.type === 'invoice.paid' || event?.type === 'invoice.payment_failed') return typeof obj.subscription === 'string' ? obj.subscription : null;
  return null;
}

export async function webhookRoutes(app: FastifyInstance, deps: Deps) {
  const { db, config, gateway } = deps;

  // Corpo BRUTO: a assinatura é calculada sobre os bytes exatos recebidos
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/billing', async (req, reply) => {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw)) throw badRequest('Corpo inválido');
    // 1) Verifica assinatura ANTES de qualquer processamento
    const sig = req.headers['stripe-signature'] ?? req.headers['x-signature'];
    if (!verifySignature(config.BILLING_WEBHOOK_SECRET!, raw, Array.isArray(sig) ? sig[0] : sig)) {
      throw unauthorized('Assinatura inválida');
    }
    let event: any;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw badRequest('JSON inválido');
    }
    const subId = subscriptionIdFrom(event);
    const tooLong = (v: unknown) => typeof v === 'string' && (v.length === 0 || v.length > 255);
    if (typeof event?.id !== 'string' || typeof event?.type !== 'string' || tooLong(event.id) || tooLong(event.type) || tooLong(subId)) {
      throw badRequest('Evento inválido');
    }

    // 2) Grava o ID primeiro; se já existe, responde 200 e não faz mais nada.
    // 3) Se novo, enfileira a sincronização (o job busca o estado atual no gateway).
    // Tudo numa função SECURITY DEFINER (migration 005), na mesma transação, com o
    // papel g360_app: o processo público não precisa da credencial BYPASSRLS.
    const isNew = await db.withAnon(async (c) => {
      const r = await c.query<{ is_new: boolean }>('SELECT record_billing_webhook($1, $2, $3, $4) AS is_new', [
        gateway.provider,
        event.id,
        event.type,
        subId,
      ]);
      return r.rows[0].is_new;
    });
    return reply.status(200).send({ received: true, duplicate: !isNew });
  });

  // Simulador de pagamento: exige flag explícita. config.ts garante que a flag só
  // é aceita com NODE_ENV=development + BILLING_PROVIDER=fake; aqui conferimos de novo.
  if (config.ENABLE_FAKE_CHECKOUT && config.NODE_ENV === 'development' && gateway instanceof FakeGateway) {
    app.post('/dev/fake-checkout/:sessionId/complete', async (req, reply) => {
      const { sessionId } = req.params as { sessionId: string };
      let event;
      try {
        event = gateway.completeCheckout(sessionId);
      } catch {
        throw notFound('Sessão inexistente');
      }
      const body = JSON.stringify(event);
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/billing',
        headers: { 'content-type': 'application/json', 'stripe-signature': signPayload(config.BILLING_WEBHOOK_SECRET!, body) },
        payload: body,
      });
      return reply.status(res.statusCode).send({ forwarded: true });
    });
  }
}
