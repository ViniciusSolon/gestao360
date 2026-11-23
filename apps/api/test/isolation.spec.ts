import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { addMember, call, createLead, createProduct, createTestApp, resetDb, signup, stages, type TestCtx } from './helpers.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); });

describe('Isolamento entre empresas (usuário A x dados da empresa B)', () => {
  it('quando A lista leads, produtos, atividades, propostas e usuários, então não vê nada de B', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const leadB = await createLead(t.app, b, { name: 'Segredo B' });
    const prodB = await createProduct(t.app, b);
    await call(t.app, b, 'POST', '/api/activities', { type: 'task', title: 'Tarefa B', leadId: leadB.id });
    await call(t.app, b, 'POST', '/api/proposals', { leadId: leadB.id, items: [{ productId: prodB.id, quantity: 1 }] }, { 'idempotency-key': 'chave-b-0001' });

    for (const url of ['/api/leads', '/api/products', '/api/activities', '/api/proposals']) {
      const r = await call(t.app, a, 'GET', url);
      expect(r.statusCode, url).toBe(200);
      expect(r.json(), url).toEqual([]);
    }
    const users = (await call(t.app, a, 'GET', '/api/users')).json();
    expect(users.map((u: any) => u.id)).toEqual([a.userId]);
  });

  it('quando A tenta ler, alterar, mover ou apagar o lead de B pelo ID, então recebe 404 e nada muda', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const leadB = await createLead(t.app, b, { name: 'Original' });
    const stA = await stages(t.app, a);
    expect((await call(t.app, a, 'GET', `/api/leads/${leadB.id}`)).statusCode).toBe(404);
    expect((await call(t.app, a, 'PATCH', `/api/leads/${leadB.id}`, { name: 'Hackeado' })).statusCode).toBe(404);
    expect((await call(t.app, a, 'POST', `/api/leads/${leadB.id}/move`, { stageId: stA[1].id })).statusCode).toBe(404);
    expect((await call(t.app, a, 'DELETE', `/api/leads/${leadB.id}`)).statusCode).toBe(404);
    const still = (await call(t.app, b, 'GET', `/api/leads/${leadB.id}`)).json();
    expect(still.name).toBe('Original');
  });

  it('quando A tenta usar produto ou lead de B numa proposta, então é recusado', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const leadA = await createLead(t.app, a);
    const leadB = await createLead(t.app, b);
    const prodA = await createProduct(t.app, a);
    const prodB = await createProduct(t.app, b);
    const r1 = await call(t.app, a, 'POST', '/api/proposals', { leadId: leadA.id, items: [{ productId: prodB.id, quantity: 1 }] }, { 'idempotency-key': 'chave-a-0001' });
    expect(r1.statusCode).toBe(422);
    const r2 = await call(t.app, a, 'POST', '/api/proposals', { leadId: leadB.id, items: [{ productId: prodA.id, quantity: 1 }] }, { 'idempotency-key': 'chave-a-0002' });
    expect(r2.statusCode).toBe(404);
  });

  it('quando A tenta ler o PDF, enviar ou aceitar a proposta de B, então 404', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const leadB = await createLead(t.app, b);
    const prodB = await createProduct(t.app, b);
    const p = (await call(t.app, b, 'POST', '/api/proposals', { leadId: leadB.id, items: [{ productId: prodB.id, quantity: 1 }] }, { 'idempotency-key': 'chave-b-0002' })).json();
    for (const [m, u] of [['GET', `/api/proposals/${p.id}`], ['GET', `/api/proposals/${p.id}/pdf`], ['POST', `/api/proposals/${p.id}/send`], ['POST', `/api/proposals/${p.id}/accept`]]) {
      expect((await call(t.app, a, m, u)).statusCode, `${m} ${u}`).toBe(404);
    }
  });

  it('quando A tenta alterar produto, atividade, etapa ou usuário de B, então 404', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const prodB = await createProduct(t.app, b);
    const actB = (await call(t.app, b, 'POST', '/api/activities', { type: 'task', title: 'B' })).json();
    const stB = await stages(t.app, b);
    expect((await call(t.app, a, 'PATCH', `/api/products/${prodB.id}`, { priceCents: 1 })).statusCode).toBe(404);
    expect((await call(t.app, a, 'POST', `/api/activities/${actB.id}/complete`)).statusCode).toBe(404);
    expect((await call(t.app, a, 'PATCH', `/api/stages/${stB[0].id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await call(t.app, a, 'PATCH', `/api/users/${b.userId}`, { active: false })).statusCode).toBe(404);
  });

  it('quando A cria lead apontando etapa ou responsável de B, então o banco recusa (FK composta por tenant)', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const stB = await stages(t.app, b);
    expect((await call(t.app, a, 'POST', '/api/leads', { name: 'x', stageId: stB[0].id })).statusCode).toBe(422);
    expect((await call(t.app, a, 'POST', '/api/leads', { name: 'x', ownerId: b.userId })).statusCode).toBe(422);
  });

  it('quando o papel da API (g360_app) consulta sem tenant definido, então o RLS não devolve nenhuma linha', async () => {
    const b = await signup(t.app);
    await createLead(t.app, b);
    const c = new pg.Client({ connectionString: inject('dbUrls').app });
    await c.connect();
    try {
      for (const table of ['tenants', 'users', 'leads', 'sessions', 'pipeline_stages']) {
        const r = await c.query(`SELECT count(*) FROM ${table}`);
        expect(Number(r.rows[0].count), table).toBe(0);
      }
      await expect(c.query('SELECT * FROM platform_admins')).rejects.toThrow(/permission denied/);
      await expect(c.query('SELECT * FROM webhook_events')).rejects.toThrow(/permission denied/);
      await expect(c.query(`UPDATE tenants SET status = 'active'`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it('quando o papel da API tenta gravar linha com tenant_id de outra empresa, então o RLS bloqueia', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const stB = await stages(t.app, b);
    const c = new pg.Client({ connectionString: inject('dbUrls').app });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      await expect(
        c.query(`INSERT INTO leads (tenant_id, name, stage_id) VALUES ($1, 'x', $2)`, [b.tenantId, stB[0].id]),
      ).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});

describe('Visibilidade dentro da empresa (vendedor x vendedor)', () => {
  it('quando o vendedor 1 tenta ver ou alterar o lead do vendedor 2, então 404', async () => {
    const owner = await signup(t.app);
    const s1 = await addMember(t.app, owner, 'seller');
    const s2 = await addMember(t.app, owner, 'manager');
    const seller2 = await addMember(t.app, owner, 'seller').catch(() => null); // plano starter: 3 vagas
    expect(seller2).toBeNull();
    const leadOwner = await createLead(t.app, owner, { ownerId: owner.userId, name: 'Do owner' });
    expect((await call(t.app, s1, 'GET', `/api/leads/${leadOwner.id}`)).statusCode).toBe(404);
    expect((await call(t.app, s1, 'PATCH', `/api/leads/${leadOwner.id}`, { valueCents: 1 })).statusCode).toBe(404);
    const list = (await call(t.app, s1, 'GET', '/api/leads')).json();
    expect(list).toEqual([]);
    // gerente vê tudo
    expect((await call(t.app, s2, 'GET', `/api/leads/${leadOwner.id}`)).statusCode).toBe(200);
  });

  it('quando o vendedor tenta atribuir lead ou atividade a outra pessoa, então 403', async () => {
    const owner = await signup(t.app);
    const s1 = await addMember(t.app, owner, 'seller');
    expect((await call(t.app, s1, 'POST', '/api/leads', { name: 'x', ownerId: owner.userId })).statusCode).toBe(403);
    expect((await call(t.app, s1, 'POST', '/api/activities', { type: 'task', title: 'x', assignedTo: owner.userId })).statusCode).toBe(403);
  });

  it('quando o vendedor consulta o dashboard, então vê só os próprios números', async () => {
    const owner = await signup(t.app);
    const s1 = await addMember(t.app, owner, 'seller');
    await createLead(t.app, owner, { ownerId: owner.userId });
    await createLead(t.app, s1);
    const d = (await call(t.app, s1, 'GET', '/api/dashboard')).json();
    expect(d.kpis.leads.value).toBe(1);
    const dOwner = (await call(t.app, owner, 'GET', '/api/dashboard')).json();
    expect(dOwner.kpis.leads.value).toBe(2);
  });
});
