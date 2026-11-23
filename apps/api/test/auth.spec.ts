import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, call, cookieOf, createTestApp, ORIGIN, resetDb, signup, type TestCtx } from './helpers.js';
import { drainJobs } from '../src/jobs/runner.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); t.email.sent = []; });

describe('Cadastro (signup)', () => {
  it('quando os dados são válidos, então cria empresa em trial, usuário owner, funil padrão e sessão', async () => {
    const s = await signup(t.app, { slug: 'acme-ltda' });
    const me = (await call(t.app, s, 'GET', '/api/auth/me')).json();
    expect(me.user.role).toBe('owner');
    expect(me.tenant.status).toBe('trialing');
    expect(me.tenant.usable).toBe(true);
    const st = (await call(t.app, s, 'GET', '/api/stages')).json();
    expect(st.map((x: any) => x.kind)).toEqual(['open', 'open', 'open', 'open', 'won', 'lost']);
    const billing = (await call(t.app, s, 'GET', '/api/billing')).json();
    expect(billing.tenant.seats_used).toBe(1);
  });

  it('quando a senha é curta ou o e-mail inválido, então responde 400 sem criar nada', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/signup', headers: { origin: ORIGIN }, payload: { companyName: 'X Y', slug: 'xy-co', name: 'A', email: 'nao-email', password: '123' } });
    expect(r.statusCode).toBe(400);
    const n = await t.db.platform.query('SELECT count(*) FROM tenants');
    expect(Number(n.rows[0].count)).toBe(0);
  });

  it('quando o e-mail já existe, então responde 409', async () => {
    await signup(t.app, { email: 'dup@exemplo.com' });
    await expect(signup(t.app, { email: 'DUP@exemplo.com' })).rejects.toThrow(/409/);
  });

  it('quando dois cadastros com o mesmo e-mail chegam ao mesmo tempo, então só um cria empresa', async () => {
    const mk = (slug: string) => t.app.inject({ method: 'POST', url: '/api/auth/signup', headers: { origin: ORIGIN }, payload: { companyName: 'Corrida', slug, name: 'A', email: 'corrida@exemplo.com', password: 'senha-forte-123' } });
    const rs = await Promise.all([mk('corrida-a'), mk('corrida-b')]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const n = await t.db.platform.query('SELECT count(*) FROM tenants');
    expect(Number(n.rows[0].count)).toBe(1);
  });

  it('quando a requisição vem de uma origem não autorizada, então responde 403 (CSRF)', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/signup', headers: { origin: 'https://site-malicioso.com' }, payload: {} });
    expect(r.statusCode).toBe(403);
  });

  it('quando o corpo é text/plain (formulário cross-site), então é rejeitado', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'text/plain' }, payload: '{"email":"a@b.com","password":"x"}' });
    expect(r.statusCode).toBe(415);
  });
});

describe('Login e sessão', () => {
  it('quando a senha confere, então cria sessão; quando não confere, então 401 genérico', async () => {
    await signup(t.app, { email: 'login@exemplo.com' });
    const ok = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'login@exemplo.com', password: 'senha-forte-123' } });
    expect(ok.statusCode).toBe(200);
    expect(cookieOf(ok)).toMatch(/g360_sid=/);
    const ck = ok.cookies.find((c) => c.name === 'g360_sid')!;
    expect(ck.httpOnly).toBe(true);
    expect(ck.sameSite).toBe('Lax');
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'login@exemplo.com', password: 'errada-errada' } });
    const none = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'ninguem@exemplo.com', password: 'errada-errada' } });
    expect(bad.statusCode).toBe(401);
    expect(none.statusCode).toBe(401);
    expect(bad.json().message).toBe(none.json().message);
  });

  it('quando faz logout, então o cookie antigo deixa de funcionar', async () => {
    const s = await signup(t.app);
    expect((await call(t.app, s, 'POST', '/api/auth/logout')).statusCode).toBe(200);
    expect((await call(t.app, s, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('quando não há cookie ou o cookie é forjado, então 401', async () => {
    expect((await call(t.app, null, 'GET', '/api/leads')).statusCode).toBe(401);
    expect((await call(t.app, { cookie: 'g360_sid=forjado', tenantId: '', userId: '' }, 'GET', '/api/leads')).statusCode).toBe(401);
  });

  it('quando o usuário é desativado, então a sessão dele para de funcionar na hora', async () => {
    const owner = await signup(t.app);
    const seller = await addMember(t.app, owner, 'seller');
    expect((await call(t.app, owner, 'PATCH', `/api/users/${seller.userId}`, { active: false })).statusCode).toBe(200);
    expect((await call(t.app, seller, 'GET', '/api/leads')).statusCode).toBe(401);
  });
});

describe('Convites e limite de usuários do plano', () => {
  it('quando o admin convida, então enfileira e envia o e-mail uma única vez', async () => {
    const owner = await signup(t.app);
    const r = await call(t.app, owner, 'POST', '/api/invites', { email: 'novo@exemplo.com', role: 'seller' });
    expect(r.statusCode).toBe(201);
    await drainJobs(t.deps);
    await drainJobs(t.deps);
    expect(t.email.sent.filter((m) => m.to === 'novo@exemplo.com')).toHaveLength(1);
  });

  it('quando o nome de quem convida tem HTML, então o e-mail sai com o texto escapado', async () => {
    const owner = await signup(t.app, { name: '<img src=x onerror=alert(1)>' });
    await call(t.app, owner, 'POST', '/api/invites', { email: 'xss@exemplo.com', role: 'seller' });
    await drainJobs(t.deps);
    const html = t.email.sent[0].html;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('quando clica duas vezes em convidar (mesmo e-mail, ao mesmo tempo), então existe só um convite pendente', async () => {
    const owner = await signup(t.app);
    const rs = await Promise.all([1, 2].map(() => call(t.app, owner, 'POST', '/api/invites', { email: 'duplo@exemplo.com', role: 'seller' })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('quando o mesmo convite é aceito duas vezes ao mesmo tempo, então só um usuário é criado e só uma vaga é consumida', async () => {
    const owner = await signup(t.app);
    const inv = (await call(t.app, owner, 'POST', '/api/invites', { email: 'aceite@exemplo.com', role: 'seller' })).json();
    const token = new URL(inv.url).searchParams.get('token');
    const accept = () => t.app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { origin: ORIGIN }, payload: { token, name: 'X', password: 'senha-forte-123' } });
    const rs = await Promise.all([accept(), accept()]);
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const users = await t.db.platform.query('SELECT count(*) FROM users WHERE tenant_id = $1', [owner.tenantId]);
    expect(Number(users.rows[0].count)).toBe(2);
    const seats = await t.db.platform.query('SELECT seats_used FROM tenants WHERE id = $1', [owner.tenantId]);
    expect(seats.rows[0].seats_used).toBe(2);
  });

  it('quando o plano (Starter: 3 usuários) está cheio e dois convites são aceitos ao mesmo tempo, então só um entra', async () => {
    const owner = await signup(t.app);
    await addMember(t.app, owner, 'seller'); // 2/3
    const tokens = [];
    for (const e of ['a@x.com', 'b@x.com']) {
      const inv = (await call(t.app, owner, 'POST', '/api/invites', { email: e, role: 'seller' })).json();
      tokens.push(new URL(inv.url).searchParams.get('token'));
    }
    const rs = await Promise.all(tokens.map((token) => t.app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { origin: ORIGIN }, payload: { token, name: 'X', password: 'senha-forte-123' } })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    const seats = await t.db.platform.query('SELECT seats_used FROM tenants WHERE id = $1', [owner.tenantId]);
    expect(seats.rows[0].seats_used).toBe(3);
  });

  it('quando o token de convite é inválido, então responde 410', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { origin: ORIGIN }, payload: { token: 'x'.repeat(43), name: 'X', password: 'senha-forte-123' } });
    expect(r.statusCode).toBe(410);
  });

  it('quando o mesmo usuário é desativado duas vezes ao mesmo tempo, então a vaga é devolvida uma vez só', async () => {
    const owner = await signup(t.app);
    const seller = await addMember(t.app, owner, 'seller');
    await Promise.all([1, 2].map(() => call(t.app, owner, 'PATCH', `/api/users/${seller.userId}`, { active: false })));
    const seats = await t.db.platform.query('SELECT seats_used FROM tenants WHERE id = $1', [owner.tenantId]);
    expect(seats.rows[0].seats_used).toBe(1);
  });
});
