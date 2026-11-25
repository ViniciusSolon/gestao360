import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, cookieOf, createLead, createTestApp, MFA_KEY, ORIGIN, resetDb, signup, type TestCtx } from './helpers.js';
import { provisionPlatformAdmin } from '../src/lib/platform-admin.js';
import { totp } from '../src/lib/totp.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); });

async function admin(role: 'superadmin' | 'support') {
  const email = `${role}@nossaempresa.com`;
  // Cadastro do admin passa pelo mesmo caminho do CLI (já com MFA TOTP)
  const { secret } = await provisionPlatformAdmin(t.db.platform, { email, name: role, role, password: 'senha-admin-forte-1' }, MFA_KEY);
  const login = await t.app.inject({ method: 'POST', url: '/api/platform/auth/login', headers: { origin: ORIGIN }, payload: { email, password: 'senha-admin-forte-1' } });
  expect(login.statusCode).toBe(200);
  const r = await t.app.inject({ method: 'POST', url: '/api/platform/auth/mfa', headers: { origin: ORIGIN }, payload: { challenge: login.json().challenge, code: totp(secret) } });
  expect(r.statusCode).toBe(200);
  const ck = r.cookies.find((c) => c.name === 'g360_admin_sid')!;
  expect(ck.path).toBe('/api/platform');
  expect(ck.httpOnly).toBe(true);
  return cookieOf(r, 'g360_admin_sid');
}
const pcall = (cookie: string | null, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as any, url: `/api/platform${url}`, payload: payload as any, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });

describe('Painel da plataforma — autenticação e papéis', () => {
  it('quando não está logado, então 401 em todas as rotas', async () => {
    for (const u of ['/metrics', '/tenants', '/audit', '/plans']) expect((await pcall(null, 'GET', u)).statusCode, u).toBe(401);
  });

  it('quando um usuário de empresa cliente (mesmo owner) usa seu cookie no painel, então 401', async () => {
    const s = await signup(t.app);
    const r = await t.app.inject({ method: 'GET', url: '/api/platform/tenants', headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(401);
  });

  it('quando a senha está errada, então 401', async () => {
    await admin('support');
    const r = await pcall(null, 'POST', '/auth/login', { email: 'support@nossaempresa.com', password: 'errada-errada' });
    expect(r.statusCode).toBe(401);
  });

  it('quando o suporte (somente leitura) tenta suspender, trocar plano, cadastrar cliente ou gerar link, então 403', async () => {
    const s = await signup(t.app);
    const sup = await admin('support');
    expect((await pcall(sup, 'GET', '/tenants')).statusCode).toBe(200);
    expect((await pcall(sup, 'POST', `/tenants/${s.tenantId}/status`, { status: 'suspended', reason: 'teste' })).statusCode).toBe(403);
    expect((await pcall(sup, 'POST', `/tenants/${s.tenantId}/plan`, { planCode: 'business', reason: 'teste' })).statusCode).toBe(403);
    expect((await pcall(sup, 'POST', '/tenants', { companyName: 'Nova', slug: 'nova-sup', ownerName: 'N', ownerEmail: 'n@n.com', planCode: 'pro' })).statusCode).toBe(403);
    expect((await pcall(sup, 'POST', `/tenants/${s.tenantId}/owner-link`)).statusCode).toBe(403);
    expect(Number((await t.db.platform.query(`SELECT count(*) FROM tenants WHERE slug = 'nova-sup'`)).rows[0].count)).toBe(0);
  });
});

describe('Painel da plataforma — controle dos clientes', () => {
  it('quando o superadmin suspende um cliente, então o cliente é bloqueado na hora e a ação fica auditada', async () => {
    const s = await signup(t.app);
    const sa = await admin('superadmin');
    expect((await call(t.app, s, 'GET', '/api/leads')).statusCode).toBe(200);
    expect((await pcall(sa, 'POST', `/tenants/${s.tenantId}/status`, { status: 'suspended', reason: 'inadimplência' })).statusCode).toBe(200);
    expect((await call(t.app, s, 'GET', '/api/leads')).statusCode).toBe(402);
    const audit = (await pcall(sa, 'GET', `/audit?tenantId=${s.tenantId}`)).json();
    expect(audit.some((a: any) => a.action === 'platform.tenant_status' && a.actor_type === 'platform_admin')).toBe(true);
    expect((await pcall(sa, 'POST', `/tenants/${s.tenantId}/status`, { status: 'active', reason: 'pagou' })).statusCode).toBe(200);
    expect((await call(t.app, s, 'GET', '/api/leads')).statusCode).toBe(200);
  });

  it('quando lista clientes e métricas, então mostra plano, status, uso e MRR', async () => {
    const s = await signup(t.app, { companyName: 'Cliente Alfa' });
    await createLead(t.app, s);
    await t.db.platform.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [s.tenantId]);
    const sa = await admin('superadmin');
    const list = (await pcall(sa, 'GET', '/tenants?q=alfa')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Cliente Alfa', plan_code: 'starter', seats_used: 1, leads_count: 1 });
    const m = (await pcall(sa, 'GET', '/metrics')).json();
    expect(m).toMatchObject({ tenants: 1, active: 1, mrr_cents: 14900 });
  });

  it('quando abre o detalhe do cliente, então NÃO expõe dados de negócio (leads), só metadados de uso', async () => {
    const s = await signup(t.app);
    await createLead(t.app, s, { name: 'Dado sensível do cliente' });
    const sa = await admin('superadmin');
    const d = (await pcall(sa, 'GET', `/tenants/${s.tenantId}`)).json();
    expect(JSON.stringify(d)).not.toContain('Dado sensível do cliente');
    expect(d.usage).toBeDefined();
  });

  it('quando o superadmin cadastra um cliente, então ele aparece pendente e o responsável define a senha pelo link', async () => {
    const sa = await admin('superadmin');
    const r = await pcall(sa, 'POST', '/tenants', { companyName: 'Usaplast Indústria', slug: 'usaplast', ownerName: 'Vini', ownerEmail: 'vini@usaplast.com.br', planCode: 'pro' });
    expect(r.statusCode).toBe(201);
    const { tenantId, accessUrl } = r.json();
    expect(accessUrl).toMatch(/\/convite\?token=/);
    let row = (await pcall(sa, 'GET', '/tenants?q=usaplast')).json()[0];
    expect(row).toMatchObject({ name: 'Usaplast Indústria', status: 'active', plan_code: 'pro', owner_email: 'vini@usaplast.com.br', owner_pending: true });
    expect((await pcall(sa, 'GET', `/tenants/${tenantId}`)).json().pendingOwner).toMatchObject({ name: 'Vini', email: 'vini@usaplast.com.br' });

    const token = new URL(accessUrl).searchParams.get('token');
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { origin: ORIGIN }, payload: { token, password: 'senha-forte-123' } })).statusCode).toBe(201);
    row = (await pcall(sa, 'GET', '/tenants?q=usaplast')).json()[0];
    expect(row.owner_pending).toBe(false);
    expect((await pcall(sa, 'GET', `/tenants/${tenantId}`)).json().pendingOwner).toBeNull();
    const audit = (await pcall(sa, 'GET', `/audit?tenantId=${tenantId}`)).json().map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['platform.tenant_created', 'platform.owner_access_link']));
  });

  it('quando gera um novo link de acesso, então o anterior deixa de valer; depois da senha definida, não gera mais', async () => {
    const sa = await admin('superadmin');
    const { tenantId, accessUrl } = (await pcall(sa, 'POST', '/tenants', { companyName: 'Link Co', slug: 'link-co', ownerName: 'L', ownerEmail: 'l@link.com', planCode: 'starter' })).json();
    const r2 = await pcall(sa, 'POST', `/tenants/${tenantId}/owner-link`);
    expect(r2.statusCode).toBe(200);
    const oldToken = new URL(accessUrl).searchParams.get('token');
    const newToken = new URL(r2.json().accessUrl).searchParams.get('token');
    expect((await t.app.inject({ method: 'GET', url: `/api/auth/invite?token=${oldToken}` })).statusCode).toBe(410);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { origin: ORIGIN }, payload: { token: newToken, password: 'senha-forte-123' } })).statusCode).toBe(201);
    const again = await pcall(sa, 'POST', `/tenants/${tenantId}/owner-link`);
    expect([again.statusCode, again.json().message]).toEqual([409, 'Esta empresa já tem responsável com senha definida']);
  });

  it('quando o identificador ou o e-mail já estão em uso, então 409 com mensagem clara e nada é criado', async () => {
    const sa = await admin('superadmin');
    await pcall(sa, 'POST', '/tenants', { companyName: 'Empresa A', slug: 'mesmo-slug', ownerName: 'A', ownerEmail: 'a@a.com', planCode: 'starter' });
    const dupSlug = await pcall(sa, 'POST', '/tenants', { companyName: 'Empresa B', slug: 'mesmo-slug', ownerName: 'B', ownerEmail: 'b@b.com', planCode: 'starter' });
    expect([dupSlug.statusCode, dupSlug.json().message]).toEqual([409, 'Identificador já está em uso por outro cliente']);
    const dupEmail = await pcall(sa, 'POST', '/tenants', { companyName: 'Empresa C', slug: 'outro-slug', ownerName: 'C', ownerEmail: 'A@a.com', planCode: 'starter' });
    expect(dupEmail.statusCode).toBe(409);
    expect(Number((await t.db.platform.query('SELECT count(*) FROM tenants')).rows[0].count)).toBe(1);
  });

  it('quando os dados do cliente são inválidos ou o plano não existe, então 400/422', async () => {
    const sa = await admin('superadmin');
    expect((await pcall(sa, 'POST', '/tenants', { companyName: 'X', slug: 'Com Espaço', ownerName: 'X', ownerEmail: 'nao-email', planCode: 'starter' })).statusCode).toBe(400);
    expect((await pcall(sa, 'POST', '/tenants', { companyName: 'Xy', slug: 'xy-co', ownerName: 'X', ownerEmail: 'x@x.com', planCode: 'plano-falso' })).statusCode).toBe(422);
  });

  it('quando um admin da empresa tenta listar ou revogar um link de responsável pela API de convites, então não vê nem encontra', async () => {
    const owner = await signup(t.app);
    const pend = await t.db.platform.query(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at) VALUES ($1, 'x@x.com', 'owner', 'hash-qualquer', now() + interval '1 day') RETURNING id`,
      [owner.tenantId],
    );
    expect((await call(t.app, owner, 'GET', '/api/invites')).json().some((i: any) => i.role === 'owner')).toBe(false);
    expect((await call(t.app, owner, 'DELETE', `/api/invites/${pend.rows[0].id}`)).statusCode).toBe(404);
    const still = await t.db.platform.query('SELECT revoked_at FROM invites WHERE id = $1', [pend.rows[0].id]);
    expect(still.rows[0].revoked_at).toBeNull();
  });

  it('quando a plataforma troca o plano, então o limite novo vale imediatamente', async () => {
    const s = await signup(t.app);
    const sa = await admin('superadmin');
    expect((await pcall(sa, 'POST', `/tenants/${s.tenantId}/plan`, { planCode: 'business', reason: 'upgrade' })).statusCode).toBe(200);
    const b = (await call(t.app, s, 'GET', '/api/billing')).json();
    expect(b.tenant.plan_code).toBe('business');
  });
});
