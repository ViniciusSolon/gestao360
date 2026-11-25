import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, createTestApp, resetDb, signedWebhook, signup, type TestCtx } from './helpers.js';
import { drainJobs } from '../src/jobs/runner.js';
import { signPayload } from '../src/billing/gateway.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  t.email.sent = [];
  t.gateway.checkoutCalls.length = 0;
});

async function startCheckout(key = 'checkout-key-1', planCode = 'pro') {
  const s = await signup(t.app);
  const r = await call(t.app, s, 'POST', '/api/billing/checkout', { planCode }, { 'idempotency-key': key });
  return { s, r };
}

async function tenantRow(id: string) {
  return (await t.db.platform.query('SELECT t.status, p.code FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1', [id])).rows[0];
}

describe('Checkout (chamadas ao gateway)', () => {
  it('quando o owner inicia o checkout, então o gateway recebe uma idempotency key UUID v4 e o preço vem do servidor', async () => {
    const { r } = await startCheckout();
    expect(r.statusCode).toBe(201);
    expect(r.json().checkoutUrl).toContain('checkout-fake');
    expect(t.gateway.checkoutCalls).toHaveLength(1);
    expect(t.gateway.checkoutCalls[0].key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(t.gateway.checkoutCalls[0].input.planCode).toBe('pro');
  });

  it('quando o cliente repete a mesma Idempotency-Key, então devolve a mesma resposta sem chamar o gateway de novo', async () => {
    const { s, r } = await startCheckout('mesma-chave-ck');
    const r2 = await call(t.app, s, 'POST', '/api/billing/checkout', { planCode: 'pro' }, { 'idempotency-key': 'mesma-chave-ck' });
    expect(r2.json()).toEqual(r.json());
    expect(t.gateway.checkoutCalls).toHaveLength(1);
  });

  it('quando o cliente tenta de novo com outra chave (nova tentativa da mesma operação), então o gateway recebe a MESMA idempotency key', async () => {
    const { s } = await startCheckout('tentativa-1');
    await call(t.app, s, 'POST', '/api/billing/checkout', { planCode: 'pro' }, { 'idempotency-key': 'tentativa-2' });
    expect(t.gateway.checkoutCalls).toHaveLength(2);
    expect(t.gateway.checkoutCalls[0].key).toBe(t.gateway.checkoutCalls[1].key);
    const ops = await t.db.platform.query('SELECT count(*) FROM billing_operations');
    expect(Number(ops.rows[0].count)).toBe(1);
  });

  it('quando dois checkouts do mesmo plano chegam ao mesmo tempo, então existe uma única operação e uma única chave', async () => {
    const s = await signup(t.app);
    await Promise.all(['par-a-0001', 'par-b-0001'].map((k) => call(t.app, s, 'POST', '/api/billing/checkout', { planCode: 'pro' }, { 'idempotency-key': k })));
    const ops = await t.db.platform.query('SELECT count(*) FROM billing_operations');
    expect(Number(ops.rows[0].count)).toBe(1);
    expect(new Set(t.gateway.checkoutCalls.map((c) => c.key)).size).toBe(1);
  });

  it('quando o plano não existe, então 404', async () => {
    const { r } = await startCheckout('k-inexistente', 'plano-fake');
    expect(r.statusCode).toBe(404);
  });
});

describe('Webhook de pagamento', () => {
  it('quando a assinatura é inválida, ausente ou expirada, então 401 e nada é registrado', async () => {
    const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { subscription: 'sub_x' } } };
    expect((await signedWebhook(t.app, ev, 'segredo-errado-'.repeat(3))).statusCode).toBe(401);
    expect((await signedWebhook(t.app, ev, undefined, 'lixo')).statusCode).toBe(401);
    const old = signPayload('whsec_test_' + 'x'.repeat(32), JSON.stringify(ev), Math.floor(Date.now() / 1000) - 3600);
    expect((await signedWebhook(t.app, ev, undefined, old)).statusCode).toBe(401);
    const n = await t.db.platform.query('SELECT count(*) FROM webhook_events');
    expect(Number(n.rows[0].count)).toBe(0);
  });

  it('quando o corpo é alterado depois de assinado, então 401 (assinatura sobre o corpo bruto)', async () => {
    const body = JSON.stringify({ id: 'evt_2', type: 'x', data: {} });
    const sig = signPayload('whsec_test_' + 'x'.repeat(32), body);
    const r = await t.app.inject({ method: 'POST', url: '/api/webhooks/billing', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, payload: body.replace('evt_2', 'evt_3') });
    expect(r.statusCode).toBe(401);
  });

  it('quando o pagamento é confirmado, então a conta vira ativa no plano pago e o e-mail sai uma vez', async () => {
    const { s, r } = await startCheckout();
    const ev = t.gateway.completeCheckout(r.json().sessionId);
    expect((await signedWebhook(t.app, ev)).statusCode).toBe(200);
    await drainJobs(t.deps);
    expect(await tenantRow(s.tenantId)).toEqual({ status: 'active', code: 'pro' });
    expect(t.email.sent.filter((m) => m.subject === 'Assinatura ativada')).toHaveLength(1);
    const op = await t.db.platform.query('SELECT status FROM billing_operations');
    expect(op.rows[0].status).toBe('completed');
  });

  it('quando o mesmo evento chega 2 vezes, então o efeito acontece uma vez (segundo responde 200 duplicate)', async () => {
    const { s, r } = await startCheckout();
    const ev = t.gateway.completeCheckout(r.json().sessionId);
    const r1 = await signedWebhook(t.app, ev);
    const r2 = await signedWebhook(t.app, ev);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().duplicate).toBe(true);
    await drainJobs(t.deps);
    const jobs = await t.db.platform.query(`SELECT count(*) FROM jobs WHERE type = 'billing.sync_subscription'`);
    expect(Number(jobs.rows[0].count)).toBe(1);
    expect(t.email.sent.filter((m) => m.subject === 'Assinatura ativada')).toHaveLength(1);
    expect((await tenantRow(s.tenantId)).status).toBe('active');
  });

  it('quando o mesmo evento chega 2 vezes AO MESMO TEMPO, então só um é processado', async () => {
    const { r } = await startCheckout();
    const ev = t.gateway.completeCheckout(r.json().sessionId);
    const rs = await Promise.all([signedWebhook(t.app, ev), signedWebhook(t.app, ev), signedWebhook(t.app, ev)]);
    expect(rs.every((x) => x.statusCode === 200)).toBe(true);
    expect(rs.filter((x) => x.json().duplicate === false)).toHaveLength(1);
    await drainJobs(t.deps);
    const n = await t.db.platform.query('SELECT count(*) FROM webhook_events');
    expect(Number(n.rows[0].count)).toBe(1);
    expect(t.email.sent.filter((m) => m.subject === 'Assinatura ativada')).toHaveLength(1);
  });

  it('quando eventos diferentes da mesma assinatura chegam fora de ordem, então vale o estado atual do gateway', async () => {
    const { s, r } = await startCheckout();
    const created = t.gateway.completeCheckout(r.json().sessionId);
    const subId = created.data.object.subscription;
    const canceled = t.gateway.setSubscriptionStatus(subId, 'canceled'); // estado final no gateway
    // chega primeiro o cancelamento, depois o "checkout concluído" antigo
    await signedWebhook(t.app, canceled);
    await signedWebhook(t.app, created);
    await drainJobs(t.deps);
    expect((await tenantRow(s.tenantId)).status).toBe('canceled');
    expect(t.email.sent.filter((m) => m.subject === 'Assinatura ativada')).toHaveLength(0);
  });

  it('quando a conta foi suspensa pela plataforma, então um pagamento não a reativa sozinho', async () => {
    const { s, r } = await startCheckout();
    await t.db.platform.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [s.tenantId]);
    await signedWebhook(t.app, t.gateway.completeCheckout(r.json().sessionId));
    await drainJobs(t.deps);
    expect((await tenantRow(s.tenantId)).status).toBe('suspended');
  });

  it('quando o evento não tem relação com assinatura, então responde 200 e não enfileira nada', async () => {
    const r = await signedWebhook(t.app, { id: 'evt_irrelevante', type: 'customer.created', data: { object: {} } });
    expect(r.statusCode).toBe(200);
    const n = await t.db.platform.query('SELECT count(*) FROM jobs');
    expect(Number(n.rows[0].count)).toBe(0);
  });

  it('quando o pagamento falha (past_due), então a conta fica past_due e continua utilizável', async () => {
    const { s, r } = await startCheckout();
    const ev = t.gateway.completeCheckout(r.json().sessionId);
    await signedWebhook(t.app, ev);
    await signedWebhook(t.app, t.gateway.setSubscriptionStatus(ev.data.object.subscription, 'past_due'));
    await drainJobs(t.deps);
    expect((await tenantRow(s.tenantId)).status).toBe('past_due');
    expect((await call(t.app, s, 'GET', '/api/leads')).statusCode).toBe(200);
  });
});
