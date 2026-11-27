import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { addMember, call, createLead, createProduct, createTestApp, resetDb, signup, type Session, type TestCtx } from './helpers.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); });

async function proposal(s: Session, leadId: string, extra: Record<string, unknown> = {}) {
  const prod = await createProduct(t.app, s);
  const r = await call(t.app, s, 'POST', '/api/proposals', { leadId, items: [{ productId: prod.id, quantity: 1 }], ...extra }, { 'idempotency-key': randomUUID() });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
const list = async (s: Session, qs = '') => (await call(t.app, s, 'GET', `/api/proposals${qs}`)).json() as any[];

describe('Propostas: responsável, temperatura, previsão e filtros', () => {
  it('quando cria com temperatura e previsão, então aparecem na lista; responsável padrão é quem criou', async () => {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s, { name: 'Metalúrgica Sul', cnpj: '11.222.333/0001-81' });
    const p = await proposal(s, lead.id, { temperature: 'hot', expectedCloseDate: '2026-12-15' });
    const [row] = await list(s);
    expect(row).toMatchObject({ id: p.id, temperature: 'hot', owner_id: s.userId, cnpj: '11222333000181' });
    expect(row.expected_close_date.slice(0, 10)).toBe('2026-12-15');
    expect(row.owner_name).toBeTruthy();
  });

  it('filtra por status, responsável, temperatura e por nome/CNPJ do cliente', async () => {
    const s = await signup(t.app);
    const seller = await addMember(t.app, s, 'seller');
    const a = await createLead(t.app, s, { name: 'Atacado Norte', cnpj: '11.222.333/0001-81' });
    const b = await createLead(t.app, s, { name: 'Loja Centro' });
    const pa = await proposal(s, a.id, { temperature: 'hot' });
    const pb = await proposal(s, b.id, { temperature: 'cold', ownerId: seller.userId });
    await call(t.app, s, 'POST', `/api/proposals/${pa.id}/send`);
    const ids = (rows: any[]) => rows.map((r) => r.id);
    expect(ids(await list(s, '?status=sent'))).toEqual([pa.id]);
    expect(ids(await list(s, '?status=draft'))).toEqual([pb.id]);
    expect(ids(await list(s, `?ownerId=${seller.userId}`))).toEqual([pb.id]);
    expect(ids(await list(s, '?temperature=hot'))).toEqual([pa.id]);
    expect(ids(await list(s, '?q=atacado'))).toEqual([pa.id]);
    expect(ids(await list(s, '?q=11.222.333/0001'))).toEqual([pa.id]);
    expect(ids(await list(s, '?q=100%25'))).toEqual([]); // % não vira curinga
  });

  it('vendedor não coloca outra pessoa como responsável; gerente pode; responsável inativo é recusado', async () => {
    const s = await signup(t.app);
    const mgr = await addMember(t.app, s, 'manager');
    const seller = await addMember(t.app, s, 'seller');
    const lead = await createLead(t.app, seller, { name: 'Do Vendedor' });
    const prod = await createProduct(t.app, s);
    const r = await call(t.app, seller, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }], ownerId: s.userId }, { 'idempotency-key': randomUUID() });
    expect(r.statusCode).toBe(403);
    const p = (await call(t.app, seller, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': randomUUID() })).json();
    expect(p.owner_id).toBe(seller.userId);
    expect((await call(t.app, mgr, 'PATCH', `/api/proposals/${p.id}`, { ownerId: s.userId })).json().owner_id).toBe(s.userId);
    await call(t.app, s, 'PATCH', `/api/users/${mgr.userId}`, { status: 'inactive' });
    expect((await call(t.app, s, 'PATCH', `/api/proposals/${p.id}`, { ownerId: mgr.userId })).json().error).toBe('invalid_owner');
  });

  it('quando muda temperatura e previsão, então valores e status não mudam', async () => {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s);
    const p = await proposal(s, lead.id);
    const r = (await call(t.app, s, 'PATCH', `/api/proposals/${p.id}`, { temperature: 'warm', expectedCloseDate: '2027-01-10' })).json();
    expect(r.temperature).toBe('warm');
    const after = (await call(t.app, s, 'GET', `/api/proposals/${p.id}`)).json();
    expect([after.status, after.total_cents]).toEqual(['draft', p.total_cents]);
    expect(after).not.toHaveProperty('share_token');
    expect((await call(t.app, s, 'PATCH', `/api/proposals/${p.id}`, { temperature: 'fervendo' })).statusCode).toBe(400);
  });

  it('outra empresa não vê nem edita a proposta', async () => {
    const s = await signup(t.app);
    const other = await signup(t.app);
    const lead = await createLead(t.app, s);
    const p = await proposal(s, lead.id);
    expect(await list(other)).toEqual([]);
    expect((await call(t.app, other, 'PATCH', `/api/proposals/${p.id}`, { temperature: 'hot' })).statusCode).toBe(404);
  });
});

describe('Indicadores comerciais: previsão de fechamento e Metas x Receita', () => {
  it('previsão soma as propostas em aberto com fechamento previsto até o fim do mês, inclusive atrasadas (por temperatura)', async () => {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s);
    const now = new Date();
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const p1 = await proposal(s, lead.id, { temperature: 'hot', expectedCloseDate: lastDay });            // fim do mês: conta
    const p0 = await proposal(s, lead.id, { temperature: 'cold', expectedCloseDate: '2020-01-10' });      // atrasada: conta
    await proposal(s, lead.id, { temperature: 'cold', expectedCloseDate: '2099-01-01' });                 // futuro distante: não
    await proposal(s, lead.id, { temperature: 'hot' });                                                   // sem previsão: não
    const p3 = await proposal(s, lead.id, { temperature: 'warm', expectedCloseDate: lastDay });
    await call(t.app, s, 'POST', `/api/proposals/${p3.id}/send`);
    await call(t.app, s, 'POST', `/api/proposals/${p3.id}/reject`); // recusada não conta
    const d = (await call(t.app, s, 'GET', '/api/dashboard')).json();
    expect(d.kpis.forecastCents.value).toBe(Number(p1.total_cents) + Number(p0.total_cents));
    expect(d.forecastByTemperature).toMatchObject({ hot: Number(p1.total_cents), warm: 0, cold: Number(p0.total_cents), proposals: 2 });
  });

  it('grava a meta do mês e devolve o histórico com a receita (leads ganhos) de cada mês', async () => {
    const s = await signup(t.app);
    const month = new Date().toISOString().slice(0, 7);
    expect((await call(t.app, s, 'PUT', '/api/dashboard/revenue-goals', { month, targetCents: 5_000_000 })).statusCode).toBe(200);
    expect((await call(t.app, s, 'PUT', '/api/dashboard/revenue-goals', { month, targetCents: 6_000_000 })).statusCode).toBe(200);
    const lead = await createLead(t.app, s, { valueCents: 1_234_500 });
    const won = (await call(t.app, s, 'GET', '/api/stages')).json().find((x: any) => x.kind === 'won');
    await call(t.app, s, 'POST', `/api/leads/${lead.id}/move`, { stageId: won.id });
    const h = (await call(t.app, s, 'GET', '/api/dashboard/revenue-goals?months=6')).json();
    expect(h).toHaveLength(6);
    expect(h.at(-1)).toEqual({ month, goalCents: 6_000_000, revenueCents: 1_234_500 });
    expect(h[0].goalCents).toBeNull();
    await call(t.app, s, 'PUT', '/api/dashboard/revenue-goals', { month, targetCents: null });
    expect((await call(t.app, s, 'GET', '/api/dashboard/revenue-goals?months=3')).json().at(-1).goalCents).toBeNull();
  });

  it('vendedor vê só a própria receita e não define meta; outra empresa não vê a meta', async () => {
    const s = await signup(t.app);
    const other = await signup(t.app);
    const seller = await addMember(t.app, s, 'seller');
    const month = new Date().toISOString().slice(0, 7);
    expect((await call(t.app, seller, 'PUT', '/api/dashboard/revenue-goals', { month, targetCents: 1 })).statusCode).toBe(403);
    await call(t.app, s, 'PUT', '/api/dashboard/revenue-goals', { month, targetCents: 999 });
    expect((await call(t.app, other, 'GET', '/api/dashboard/revenue-goals?months=3')).json().at(-1).goalCents).toBeNull();
    expect((await call(t.app, s, 'PUT', '/api/dashboard/revenue-goals', { month: '2026-13', targetCents: 1 })).statusCode).toBe(400);
  });
});
