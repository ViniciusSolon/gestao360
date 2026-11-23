import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, call, createLead, createProduct, createTestApp, resetDb, signup, stages, type TestCtx } from './helpers.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); });

describe('Leads e funil Kanban', () => {
  it('quando cria um lead, então a pontuação e o MQL são calculados no servidor (ignora score enviado)', async () => {
    const s = await signup(t.app);
    const r = await call(t.app, s, 'POST', '/api/leads', { name: 'Fulano', company: 'X', email: 'f@x.com', phone: '1199', valueCents: 6_000_000, channel: 'indicacao', score: 0, is_mql: false });
    expect(r.statusCode).toBe(201);
    expect(r.json().score).toBe(100);
    expect(r.json().is_mql).toBe(true);
  });

  it('quando move o lead para "Ganho", então status=won e closed_at preenchido; para "Perdido" exige motivo', async () => {
    const s = await signup(t.app);
    const st = await stages(t.app, s);
    const lead = await createLead(t.app, s);
    const won = await call(t.app, s, 'POST', `/api/leads/${lead.id}/move`, { stageId: st.find((x) => x.kind === 'won')!.id });
    expect(won.json().status).toBe('won');
    expect(won.json().closed_at).toBeTruthy();
    const lost = st.find((x) => x.kind === 'lost')!.id;
    expect((await call(t.app, s, 'POST', `/api/leads/${lead.id}/move`, { stageId: lost })).statusCode).toBe(422);
    expect((await call(t.app, s, 'POST', `/api/leads/${lead.id}/move`, { stageId: lost, lostReason: 'Preço' })).json().status).toBe('lost');
  });

  it('quando o valor do lead é negativo, então 400', async () => {
    const s = await signup(t.app);
    expect((await call(t.app, s, 'POST', '/api/leads', { name: 'x', valueCents: -1 })).statusCode).toBe(400);
  });

  it('quando o plano atinge o limite de leads e dois leads são criados ao mesmo tempo, então só um entra', async () => {
    const s = await signup(t.app);
    await t.db.platform.query(`UPDATE tenants SET leads_count = 999 WHERE id = $1`, [s.tenantId]); // starter: 1000
    const rs = await Promise.all([1, 2].map((i) => call(t.app, s, 'POST', '/api/leads', { name: `L${i}` })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    const n = await t.db.platform.query('SELECT leads_count FROM tenants WHERE id = $1', [s.tenantId]);
    expect(n.rows[0].leads_count).toBe(1000);
  });

  it('quando o mesmo lead é apagado duas vezes ao mesmo tempo, então a cota é devolvida uma vez', async () => {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s);
    await createLead(t.app, s);
    const rs = await Promise.all([1, 2].map(() => call(t.app, s, 'DELETE', `/api/leads/${lead.id}`)));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    const n = await t.db.platform.query('SELECT leads_count FROM tenants WHERE id = $1', [s.tenantId]);
    expect(n.rows[0].leads_count).toBe(1);
  });

  it('quando a atividade é concluída duas vezes ao mesmo tempo, então gera um único evento no histórico', async () => {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s);
    const act = (await call(t.app, s, 'POST', '/api/activities', { type: 'call', title: 'Ligar', leadId: lead.id })).json();
    await Promise.all([1, 2].map(() => call(t.app, s, 'POST', `/api/activities/${act.id}/complete`)));
    const ev = await t.db.platform.query(`SELECT count(*) FROM lead_events WHERE lead_id = $1 AND type = 'activity_done'`, [lead.id]);
    expect(Number(ev.rows[0].count)).toBe(1);
  });

  it('quando o link de reunião não é https (ex.: javascript:), então 400', async () => {
    const s = await signup(t.app);
    const r = await call(t.app, s, 'POST', '/api/activities', { type: 'meeting', title: 'x', meetingUrl: 'javascript:alert(1)' });
    expect(r.statusCode).toBe(400);
  });
});

describe('Permissões por papel (servidor)', () => {
  it('quando o vendedor tenta criar produto, convidar, criar etapa ou apagar lead, então 403', async () => {
    const owner = await signup(t.app);
    const seller = await addMember(t.app, owner, 'seller');
    const lead = await createLead(t.app, seller);
    expect((await call(t.app, seller, 'POST', '/api/products', { sku: 'A', name: 'A', priceCents: 1 })).statusCode).toBe(403);
    expect((await call(t.app, seller, 'POST', '/api/invites', { email: 'z@z.com', role: 'seller' })).statusCode).toBe(403);
    expect((await call(t.app, seller, 'POST', '/api/stages', { name: 'X', probability: 10 })).statusCode).toBe(403);
    expect((await call(t.app, seller, 'DELETE', `/api/leads/${lead.id}`)).statusCode).toBe(403);
    expect((await call(t.app, seller, 'PATCH', `/api/users/${owner.userId}`, { active: false })).statusCode).toBe(403);
  });

  it('quando o admin tenta promover alguém a owner ou alterar o owner, então é recusado', async () => {
    const owner = await signup(t.app);
    const admin = await addMember(t.app, owner, 'admin');
    const seller = await addMember(t.app, owner, 'seller');
    expect((await call(t.app, admin, 'PATCH', `/api/users/${seller.userId}`, { role: 'owner' })).statusCode).toBe(400);
    expect((await call(t.app, admin, 'PATCH', `/api/users/${owner.userId}`, { active: false })).statusCode).toBe(403);
  });

  it('quando gerente tenta checkout de plano (só owner), então 403', async () => {
    const owner = await signup(t.app);
    const mgr = await addMember(t.app, owner, 'manager');
    expect((await call(t.app, mgr, 'POST', '/api/billing/checkout', { planCode: 'pro' }, { 'idempotency-key': 'k-mgr-00001' })).statusCode).toBe(403);
  });
});

describe('Propostas', () => {
  async function setup() {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s);
    const prod = await createProduct(t.app, s, { priceCents: 10000, taxRateBp: 1000 });
    return { s, lead, prod };
  }

  it('quando cria proposta, então preço e tributo vêm do cadastro (valores enviados pelo cliente são ignorados)', async () => {
    const { s, lead, prod } = await setup();
    const r = await call(t.app, s, 'POST', '/api/proposals', {
      leadId: lead.id,
      items: [{ productId: prod.id, quantity: 3, discountPercent: 10, unitPriceCents: 1 }],
      freightCents: 500,
      totalCents: 1,
    }, { 'idempotency-key': 'prop-0000001' });
    expect(r.statusCode).toBe(201);
    const p = r.json();
    // 3 × 100,00 = 300,00; desconto 10% = 30,00; tributo 10% de 270,00 = 27,00; frete 5,00
    expect(p.subtotal_cents).toBe('30000');
    expect(p.discount_cents).toBe('3000');
    expect(p.tax_cents).toBe('2700');
    expect(p.total_cents).toBe('30200');
    expect(p.number).toBe('1');
  });

  it('quando o vendedor dá desconto acima de 10%, então 403; quando o gerente dá 15%, então aceita', async () => {
    const { s, lead, prod } = await setup();
    const seller = await addMember(t.app, s, 'seller');
    const leadSeller = await createLead(t.app, seller);
    const r1 = await call(t.app, seller, 'POST', '/api/proposals', { leadId: leadSeller.id, items: [{ productId: prod.id, quantity: 1, discountPercent: 15 }] }, { 'idempotency-key': 'prop-seller-1' });
    expect(r1.statusCode).toBe(403);
    const mgr = await addMember(t.app, s, 'manager');
    const r2 = await call(t.app, mgr, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1, discountPercent: 15 }] }, { 'idempotency-key': 'prop-mgr-01' });
    expect(r2.statusCode).toBe(201);
  });

  it('quando falta Idempotency-Key, então 400', async () => {
    const { s, lead, prod } = await setup();
    expect((await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] })).statusCode).toBe(400);
  });

  it('quando a mesma Idempotency-Key é reenviada (clique duplo / retry), então devolve a mesma resposta e cria uma só proposta', async () => {
    const { s, lead, prod } = await setup();
    const body = { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] };
    const r1 = await call(t.app, s, 'POST', '/api/proposals', body, { 'idempotency-key': 'mesma-chave-1' });
    const r2 = await call(t.app, s, 'POST', '/api/proposals', body, { 'idempotency-key': 'mesma-chave-1' });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().id).toBe(r1.json().id);
    const n = await t.db.platform.query('SELECT count(*) FROM proposals WHERE tenant_id = $1', [s.tenantId]);
    expect(Number(n.rows[0].count)).toBe(1);
  });

  it('quando duas requisições com a mesma Idempotency-Key chegam ao mesmo tempo, então só uma proposta é criada', async () => {
    const { s, lead, prod } = await setup();
    const body = { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] };
    const rs = await Promise.all([1, 2, 3].map(() => call(t.app, s, 'POST', '/api/proposals', body, { 'idempotency-key': 'concorrente-1' })));
    expect(rs.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
    const n = await t.db.platform.query('SELECT count(*) FROM proposals WHERE tenant_id = $1', [s.tenantId]);
    expect(Number(n.rows[0].count)).toBe(1);
  });

  it('quando a mesma chave é usada com outro corpo, então 422', async () => {
    const { s, lead, prod } = await setup();
    await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': 'reuso-chave-1' });
    const r = await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 2 }] }, { 'idempotency-key': 'reuso-chave-1' });
    expect(r.statusCode).toBe(422);
  });

  it('quando várias propostas diferentes são criadas ao mesmo tempo, então os números são sequenciais e sem repetição', async () => {
    const { s, lead, prod } = await setup();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': `numeracao-${i}-xyz` })));
    expect(rs.every((r) => r.statusCode === 201)).toBe(true);
    expect(rs.map((r) => Number(r.json().number)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('quando a proposta é aceita duas vezes ao mesmo tempo, então só um aceite vale e o lead fica ganho', async () => {
    const { s, lead, prod } = await setup();
    const p = (await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': 'aceite-0001' })).json();
    await call(t.app, s, 'POST', `/api/proposals/${p.id}/send`);
    const rs = await Promise.all([1, 2].map(() => call(t.app, s, 'POST', `/api/proposals/${p.id}/accept`)));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const ev = await t.db.platform.query(`SELECT count(*) FROM lead_events WHERE lead_id = $1 AND type = 'proposal_accepted'`, [lead.id]);
    expect(Number(ev.rows[0].count)).toBe(1);
    const l = (await call(t.app, s, 'GET', `/api/leads/${lead.id}`)).json();
    expect(l.status).toBe('won');
  });

  it('quando duas propostas do mesmo lead são aceitas ao mesmo tempo, então só uma fica aceita', async () => {
    const { s, lead, prod } = await setup();
    const ids = [];
    for (const k of ['dupla-a-0001', 'dupla-b-0001']) {
      const p = (await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': k })).json();
      await call(t.app, s, 'POST', `/api/proposals/${p.id}/send`);
      ids.push(p.id);
    }
    const rs = await Promise.all(ids.map((id) => call(t.app, s, 'POST', `/api/proposals/${id}/accept`)));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('quando gera o PDF, então devolve application/pdf', async () => {
    const { s, lead, prod } = await setup();
    const p = (await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 2 }] }, { 'idempotency-key': 'pdf-000001' })).json();
    const r = await call(t.app, s, 'GET', `/api/proposals/${p.id}/pdf`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('quando quantidade é zero ou negativa, ou frete negativo, então 400', async () => {
    const { s, lead, prod } = await setup();
    expect((await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 0 }] }, { 'idempotency-key': 'qtd-zero-01' })).statusCode).toBe(400);
    expect((await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }], freightCents: -10 }, { 'idempotency-key': 'frete-neg-1' })).statusCode).toBe(400);
  });

  it('quando o produto está inativo, então não pode entrar em proposta', async () => {
    const { s, lead } = await setup();
    const prod = await createProduct(t.app, s, { active: false });
    expect((await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': 'inativo-001' })).statusCode).toBe(422);
  });
});

describe('Conta bloqueada', () => {
  it('quando o trial venceu, então as rotas de negócio respondem 402 mas a cobrança continua acessível', async () => {
    const s = await signup(t.app);
    await t.db.platform.query(`UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [s.tenantId]);
    expect((await call(t.app, s, 'GET', '/api/leads')).statusCode).toBe(402);
    expect((await call(t.app, s, 'GET', '/api/billing')).statusCode).toBe(200);
    const me = (await call(t.app, s, 'GET', '/api/auth/me')).json();
    expect(me.tenant.usable).toBe(false);
  });

  it('quando a conta está suspensa, então 402 em tudo que é de negócio', async () => {
    const s = await signup(t.app);
    await t.db.platform.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [s.tenantId]);
    expect((await call(t.app, s, 'POST', '/api/leads', { name: 'x' })).statusCode).toBe(402);
  });
});
