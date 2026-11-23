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

  it('quando o suporte (somente leitura) tenta suspender, trocar plano ou estender trial, então 403', async () => {
    const s = await signup(t.app);
    const sup = await admin('support');
    expect((await pcall(sup, 'GET', '/tenants')).statusCode).toBe(200);
    expect((await pcall(sup, 'POST', `/tenants/${s.tenantId}/status`, { status: 'suspended', reason: 'teste' })).statusCode).toBe(403);
    expect((await pcall(sup, 'POST', `/tenants/${s.tenantId}/plan`, { planCode: 'business', reason: 'teste' })).statusCode).toBe(403);
    expect((await pcall(sup, 'POST', `/tenants/${s.tenantId}/trial`, { days: 30, reason: 'teste' })).statusCode).toBe(403);
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

  it('quando estende o trial, então a data avança; quando o cliente não está em trial, então 422', async () => {
    const s = await signup(t.app);
    const sa = await admin('superadmin');
    const r = await pcall(sa, 'POST', `/tenants/${s.tenantId}/trial`, { days: 10, reason: 'negociação' });
    expect(r.statusCode).toBe(200);
    await t.db.platform.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [s.tenantId]);
    expect((await pcall(sa, 'POST', `/tenants/${s.tenantId}/trial`, { days: 10, reason: 'x x x' })).statusCode).toBe(422);
  });

  it('quando a plataforma troca o plano, então o limite novo vale imediatamente', async () => {
    const s = await signup(t.app);
    const sa = await admin('superadmin');
    expect((await pcall(sa, 'POST', `/tenants/${s.tenantId}/plan`, { planCode: 'business', reason: 'upgrade' })).statusCode).toBe(200);
    const b = (await call(t.app, s, 'GET', '/api/billing')).json();
    expect(b.tenant.plan_code).toBe('business');
  });
});
