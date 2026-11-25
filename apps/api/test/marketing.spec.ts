import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, call, createLead, createProduct, createTestApp, resetDb, signup, type Session, type TestCtx } from './helpers.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); });

const PERIOD = 'from=2026-11-01&to=2026-11-24';

/**
 * Cenário (datas em UTC; São Paulo = UTC−3):
 *  google_ads / "Black Friday": L1 criado 05/11; L2 criado 10/11, proposta 11/11, GANHO 20/11 (R$ 10.000)
 *  meta_ads (sem campanha):      L3 criado 02/11, PERDIDO 15/11; L5 criado 03/11, proposta 12/11; L4 criado 20/10 (anterior)
 *  direto:                        L6 criado 01/11 00:30 SP (dentro); L7 criado 31/10 23:30 SP (período anterior)
 *  investimento: Google/Black Friday R$ 3.000 em 01/11; Meta R$ 2.000 em 01/11; Google R$ 1.000 em 15/10 (anterior)
 */
async function scenario(s: Session) {
  const prod = await createProduct(t.app, s);
  const mk = async (key: string, channel: string, campaign: string | null, createdAt: string) => {
    const l = await createLead(t.app, s, { name: key, channel, ...(campaign ? { campaign } : {}), valueCents: 0 });
    await t.db.platform.query('UPDATE leads SET created_at = $2 WHERE id = $1', [l.id, createdAt]);
    return l;
  };
  const L1 = await mk('L1', 'google_ads', 'Black Friday', '2026-11-05T15:00:00Z');
  const L2 = await mk('L2', 'google_ads', 'Black Friday', '2026-11-10T15:00:00Z');
  const L3 = await mk('L3', 'meta_ads', null, '2026-11-02T15:00:00Z');
  const L4 = await mk('L4', 'meta_ads', null, '2026-10-20T15:00:00Z');
  const L5 = await mk('L5', 'meta_ads', null, '2026-11-03T15:00:00Z');
  await mk('L6', 'direto', null, '2026-11-01T03:30:00Z');
  await mk('L7', 'direto', null, '2026-11-01T02:30:00Z');
  for (const [lead, at, key] of [[L2, '2026-11-11T12:00:00Z', 'p-l2-0001'], [L5, '2026-11-12T12:00:00Z', 'p-l5-0001']] as const) {
    const p = (await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': key })).json();
    await t.db.platform.query('UPDATE proposals SET created_at = $2 WHERE id = $1', [p.id, at]);
  }
  await t.db.platform.query(`UPDATE leads SET status = 'won', closed_at = '2026-11-20T15:00:00Z', value_cents = 1000000 WHERE id = $1`, [L2.id]);
  await t.db.platform.query(`UPDATE leads SET status = 'lost', closed_at = '2026-11-15T15:00:00Z', lost_reason = 'Preço' WHERE id = $1`, [L3.id]);
  for (const sp of [
    { source: 'google_ads', campaign: 'Black Friday', spentOn: '2026-11-01', amountCents: 300000 },
    { source: 'meta_ads', spentOn: '2026-11-01', amountCents: 200000 },
    { source: 'google_ads', spentOn: '2026-10-15', amountCents: 100000 },
  ]) expect((await call(t.app, s, 'POST', '/api/marketing/spend', sp)).statusCode).toBe(201);
  return { L1, L4 };
}

const kpi = (d: any, key: string) => d.kpis.find((k: any) => k.key === key);

describe('Painel de Marketing — números', () => {
  it('quando calcula o período, então leads, deals, ganhos, perdas, custo, CPL, CPD, CAC e ROI batem com o cenário', async () => {
    const s = await signup(t.app);
    await scenario(s);
    const d = (await call(t.app, s, 'GET', `/api/marketing?${PERIOD}`)).json();
    expect(d.period).toMatchObject({ from: '2026-11-01', to: '2026-11-24', previousFrom: '2026-10-08', previousTo: '2026-10-31', days: 24 });
    const v = Object.fromEntries(d.kpis.map((k: any) => [k.key, k.value]));
    expect(v).toEqual({ cost: 500000, leads: 5, deals: 2, gains: 1, cpl: 100000, cpd: 250000, cac: 500000, roi: 1 });
    expect(d.totals.lost).toBe(1);
    // Período anterior (08/10 a 31/10): L4 e L7 (31/10 23:30 em São Paulo); custo R$ 1.000
    expect(kpi(d, 'leads').previous).toBe(2);
    expect(kpi(d, 'cost').previous).toBe(100000);
    expect(kpi(d, 'gains').previous).toBe(0);
  });

  it('quando detalha por fonte e campanha, então cada linha e a campanha batem; fontes sem dados aparecem zeradas', async () => {
    const s = await signup(t.app);
    await scenario(s);
    const d = (await call(t.app, s, 'GET', `/api/marketing?${PERIOD}`)).json();
    const by = Object.fromEntries(d.bySource.map((r: any) => [r.source, r]));
    expect(by.google_ads).toMatchObject({ label: 'Google Ads', leads: 2, deals: 1, gains: 1, lost: 0, cost: 300000, revenue: 1000000, cpl: 150000, cac: 300000 });
    expect(by.google_ads.roi).toBeCloseTo(7 / 3, 6);
    expect(by.google_ads.campaigns).toEqual([expect.objectContaining({ campaign: 'Black Friday', leads: 2, deals: 1, gains: 1, cost: 300000 })]);
    expect(by.meta_ads).toMatchObject({ label: 'Meta Business', leads: 2, deals: 1, gains: 0, lost: 1, cost: 200000, cac: null });
    expect(by.meta_ads.previous.leads).toBe(1);
    expect(by.direto).toMatchObject({ leads: 1, previous: expect.objectContaining({ leads: 1 }) });
    expect(by.tiktok_ads).toMatchObject({ leads: 0, cost: 0, cpl: null });
    // Ordem igual à do painel; fontes antigas sem dados não aparecem
    expect(d.bySource.slice(0, 10).map((r: any) => r.label)).toEqual([
      'Google Ads', 'Meta Business', 'TikTok Ads', 'LinkedIn Ads', 'Google Orgânico', 'WhatsApp', 'Instagram Orgânico', 'Indicação', 'Direto', 'ChatGPT Ads',
    ]);
    expect(d.bySource.some((r: any) => r.source === 'site')).toBe(false);
  });

  it('quando filtra "meus + sem responsável", então lead de outro responsável sai, mas o custo da empresa continua', async () => {
    const s = await signup(t.app);
    const mgr = await addMember(t.app, s, 'manager');
    await scenario(s);
    const l = await createLead(t.app, s, { name: 'Do gerente', channel: 'google_ads', ownerId: mgr.userId });
    await t.db.platform.query(`UPDATE leads SET created_at = '2026-11-06T15:00:00Z' WHERE id = $1`, [l.id]);
    const all = (await call(t.app, s, 'GET', `/api/marketing?${PERIOD}&scope=all`)).json();
    const mine = (await call(t.app, s, 'GET', `/api/marketing?${PERIOD}&scope=mine`)).json();
    expect(kpi(all, 'leads').value).toBe(6);
    expect(kpi(mine, 'leads').value).toBe(5);
    expect(kpi(mine, 'cost').value).toBe(500000);
  });

  it('quando o período é inválido ou longo demais, então 422', async () => {
    const s = await signup(t.app);
    expect((await call(t.app, s, 'GET', '/api/marketing?from=2026-11-10&to=2026-11-01')).statusCode).toBe(422);
    expect((await call(t.app, s, 'GET', '/api/marketing?from=2024-01-01&to=2026-11-01')).statusCode).toBe(422);
    expect((await call(t.app, s, 'GET', '/api/marketing?from=01/11/2026')).statusCode).toBe(400);
  });
});

describe('Painel de Marketing — metas', () => {
  it('quando define metas, então somas mensais valem para custo/leads e a do mês final para CPL; meta nula remove', async () => {
    const s = await signup(t.app);
    const put = (body: object) => call(t.app, s, 'PUT', '/api/marketing/goals', body);
    expect((await put({ metric: 'cost', month: '2026-10', target: 1000000 })).statusCode).toBe(200);
    expect((await put({ metric: 'cost', month: '2026-11', target: 1500000 })).statusCode).toBe(200);
    expect((await put({ metric: 'cpl', month: '2026-10', target: 50000 })).statusCode).toBe(200);
    expect((await put({ metric: 'cpl', month: '2026-11', target: 80000 })).statusCode).toBe(200);
    const d = (await call(t.app, s, 'GET', '/api/marketing?from=2026-10-01&to=2026-11-24')).json();
    expect(kpi(d, 'cost').goal).toBe(2500000);
    expect(kpi(d, 'cpl').goal).toBe(80000);
    expect(kpi(d, 'leads').goal).toBeNull();
    await put({ metric: 'cost', month: '2026-11', target: 2000000 }); // atualiza
    await put({ metric: 'cpl', month: '2026-11', target: null }); // remove
    const d2 = (await call(t.app, s, 'GET', '/api/marketing?from=2026-11-01&to=2026-11-24')).json();
    expect(kpi(d2, 'cost').goal).toBe(2000000);
    expect(kpi(d2, 'cpl').goal).toBeNull();
  });

  it('quando o indicador ou o mês são inválidos, então 400', async () => {
    const s = await signup(t.app);
    expect((await call(t.app, s, 'PUT', '/api/marketing/goals', { metric: 'lucro', month: '2026-11', target: 1 })).statusCode).toBe(400);
    expect((await call(t.app, s, 'PUT', '/api/marketing/goals', { metric: 'cost', month: '11/2026', target: 1 })).statusCode).toBe(400);
  });
});

describe('Painel de Marketing — investimentos e permissões', () => {
  it('quando o vendedor tenta abrir o painel, lançar investimento ou meta, então 403', async () => {
    const owner = await signup(t.app);
    const seller = await addMember(t.app, owner, 'seller');
    expect((await call(t.app, seller, 'GET', `/api/marketing?${PERIOD}`)).statusCode).toBe(403);
    expect((await call(t.app, seller, 'POST', '/api/marketing/spend', { source: 'google_ads', spentOn: '2026-11-01', amountCents: 1 })).statusCode).toBe(403);
    expect((await call(t.app, seller, 'PUT', '/api/marketing/goals', { metric: 'cost', month: '2026-11', target: 1 })).statusCode).toBe(403);
  });

  it('quando lança investimento inválido (fonte desconhecida, valor negativo, data errada), então 400', async () => {
    const s = await signup(t.app);
    for (const body of [
      { source: 'orkut', spentOn: '2026-11-01', amountCents: 100 },
      { source: 'google_ads', spentOn: '2026-11-01', amountCents: -1 },
      { source: 'google_ads', spentOn: '01/11/2026', amountCents: 100 },
    ]) expect((await call(t.app, s, 'POST', '/api/marketing/spend', body)).statusCode, JSON.stringify(body)).toBe(400);
  });

  it('quando lista e apaga investimentos, então só os da própria empresa aparecem e podem ser apagados', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const spA = (await call(t.app, a, 'POST', '/api/marketing/spend', { source: 'google_ads', spentOn: '2026-11-03', amountCents: 12345, campaign: 'Natal' })).json();
    await call(t.app, b, 'POST', '/api/marketing/spend', { source: 'meta_ads', spentOn: '2026-11-03', amountCents: 999 });
    const listA = (await call(t.app, a, 'GET', '/api/marketing/spend?from=2026-11-01&to=2026-11-30')).json();
    expect(listA).toEqual([expect.objectContaining({ source: 'google_ads', label: 'Google Ads', campaign: 'Natal', spent_on: '2026-11-03', amount_cents: 12345 })]);
    expect((await call(t.app, b, 'DELETE', `/api/marketing/spend/${spA.id}`)).statusCode).toBe(404);
    expect((await call(t.app, a, 'GET', `/api/marketing?from=2026-11-01&to=2026-11-30`)).json().kpis[0].value).toBe(12345);
    expect((await call(t.app, a, 'DELETE', `/api/marketing/spend/${spA.id}`)).statusCode).toBe(200);
    expect((await call(t.app, a, 'GET', '/api/marketing/spend?from=2026-11-01&to=2026-11-30')).json()).toEqual([]);
  });

  it('quando o lead recebe campanha, então ela é gravada, editável e aparece na listagem', async () => {
    const s = await signup(t.app);
    const l = await createLead(t.app, s, { channel: 'meta_ads', campaign: 'Remarketing' });
    expect(l.campaign).toBe('Remarketing');
    expect((await call(t.app, s, 'PATCH', `/api/leads/${l.id}`, { campaign: 'Lookalike' })).json().campaign).toBe('Lookalike');
    expect((await call(t.app, s, 'GET', '/api/leads')).json()[0]).toMatchObject({ channel: 'meta_ads', campaign: 'Lookalike' });
    expect((await call(t.app, s, 'POST', '/api/leads', { name: 'x', channel: 'orkut' })).statusCode).toBe(400);
  });
});
