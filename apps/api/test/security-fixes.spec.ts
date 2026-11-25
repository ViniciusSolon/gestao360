import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { addMember, call, cookieOf, createLead, createProduct, createTestApp, MFA_KEY, ORIGIN, resetDb, signup, stages, type TestCtx } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { provisionPlatformAdmin } from '../src/lib/platform-admin.js';
import { base32Decode, base32Encode, decryptSecret, encryptSecret, hotp, totp } from '../src/lib/totp.js';
import { purgeExpired } from '../src/jobs/runner.js';
import { provisionTenant } from '../src/lib/tenants.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); });

const post = (app: TestCtx['app'], url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as any, headers: { origin: ORIGIN, ...headers } });

// ---------------------------------------------------------------------------
describe('SEC-09 — MFA (TOTP) obrigatório no painel', () => {
  it('gera os códigos dos vetores oficiais do RFC 6238 (SHA-1, 8 dígitos)', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(secret, Math.floor(1234567890 / 30), 8)).toBe('89005924');
    expect(hotp(secret, Math.floor(20000000000 / 30), 8)).toBe('65353130');
  });

  it('base32 e a cifragem do segredo fazem ida e volta; segredo adulterado ou chave errada falham', () => {
    const s = Buffer.from('segredo-de-teste-160b');
    expect(base32Decode(base32Encode(s)).equals(s)).toBe(true);
    const enc = encryptSecret(s, MFA_KEY);
    expect(decryptSecret(enc, MFA_KEY).equals(s)).toBe(true);
    expect(() => decryptSecret(enc, 'cd'.repeat(32))).toThrow();
    const raw = Buffer.from(enc.slice(3), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret(`v1:${raw.toString('base64')}`, MFA_KEY)).toThrow();
  });

  async function setup(email = 'mfa@nossaempresa.com') {
    const r = await provisionPlatformAdmin(t.db.platform, { email, name: 'Adm', role: 'superadmin', password: 'senha-admin-forte-1' }, MFA_KEY);
    const login = await post(t.app, '/api/platform/auth/login', { email, password: 'senha-admin-forte-1' });
    return { ...r, login, challenge: login.json().challenge as string };
  }

  it('quando só a senha está certa, então não há sessão: recebe apenas um desafio', async () => {
    const { login } = await setup();
    expect(login.json().mfaRequired).toBe(true);
    expect(login.cookies).toHaveLength(0);
    const n = await t.db.platform.query('SELECT count(*) FROM platform_sessions');
    expect(Number(n.rows[0].count)).toBe(0);
  });

  it('quando o código está errado, então 401; depois de 5 erros nem o código certo vale', async () => {
    const { challenge, secret } = await setup();
    const wrong = totp(secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await post(t.app, '/api/platform/auth/mfa', { challenge, code: wrong })).statusCode).toBe(401);
    expect((await post(t.app, '/api/platform/auth/mfa', { challenge, code: totp(secret) })).statusCode).toBe(401);
  });

  it('quando o mesmo código é reutilizado num segundo login (replay), então é recusado', async () => {
    const { challenge, secret } = await setup();
    const code = totp(secret);
    expect((await post(t.app, '/api/platform/auth/mfa', { challenge, code })).statusCode).toBe(200);
    const login2 = await post(t.app, '/api/platform/auth/login', { email: 'mfa@nossaempresa.com', password: 'senha-admin-forte-1' });
    expect((await post(t.app, '/api/platform/auth/mfa', { challenge: login2.json().challenge, code })).statusCode).toBe(401);
  });

  it('quando o desafio já foi usado, então não cria outra sessão', async () => {
    const { challenge, secret, recoveryCodes } = await setup();
    expect((await post(t.app, '/api/platform/auth/mfa', { challenge, code: totp(secret) })).statusCode).toBe(200);
    expect((await post(t.app, '/api/platform/auth/mfa', { challenge, recoveryCode: recoveryCodes[0] })).statusCode).toBe(401);
  });

  it('quando o mesmo desafio e código chegam ao mesmo tempo, então só uma sessão é criada', async () => {
    const { challenge, secret } = await setup();
    const code = totp(secret);
    const rs = await Promise.all([1, 2, 3].map(() => post(t.app, '/api/platform/auth/mfa', { challenge, code })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const n = await t.db.platform.query('SELECT count(*) FROM platform_sessions');
    expect(Number(n.rows[0].count)).toBe(1);
  });

  it('quando usa código de recuperação, então entra uma vez; o mesmo código não vale de novo', async () => {
    const { challenge, recoveryCodes } = await setup();
    const r1 = await post(t.app, '/api/platform/auth/mfa', { challenge, recoveryCode: recoveryCodes[0].toUpperCase() });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().method).toBe('recovery');
    const login2 = await post(t.app, '/api/platform/auth/login', { email: 'mfa@nossaempresa.com', password: 'senha-admin-forte-1' });
    expect((await post(t.app, '/api/platform/auth/mfa', { challenge: login2.json().challenge, recoveryCode: recoveryCodes[0] })).statusCode).toBe(401);
  });

  it('quando o admin foi cadastrado sem MFA (dado antigo), então não consegue logar', async () => {
    await t.db.platform.query(`INSERT INTO platform_admins (email, name, password_hash, role) VALUES ('velho@x.com', 'V', 'scrypt$1$a$b', 'superadmin')`);
    const { hashPassword } = await import('../src/lib/crypto.js');
    await t.db.platform.query(`UPDATE platform_admins SET password_hash = $1 WHERE email = 'velho@x.com'`, [await hashPassword('senha-admin-forte-1')]);
    const r = await post(t.app, '/api/platform/auth/login', { email: 'velho@x.com', password: 'senha-admin-forte-1' });
    expect(r.statusCode).toBe(403);
  });

  it('quando o admin é reconfigurado pelo CLI, então as sessões abertas caem', async () => {
    const { challenge, secret } = await setup();
    const ok = await post(t.app, '/api/platform/auth/mfa', { challenge, code: totp(secret) });
    const ck = cookieOf(ok, 'g360_admin_sid');
    await provisionPlatformAdmin(t.db.platform, { email: 'mfa@nossaempresa.com', name: 'Adm', role: 'superadmin', password: 'outra-senha-forte-2' }, MFA_KEY);
    expect((await t.app.inject({ method: 'GET', url: '/api/platform/me', headers: { cookie: ck } })).statusCode).toBe(401);
  });

  it('quando o painel sobe sem PLATFORM_MFA_KEY, então não inicia', () => {
    const base = { NODE_ENV: 'test', DATABASE_APP_URL: 'postgres://a@h/d', DATABASE_PLATFORM_URL: 'postgres://b@h/d', BILLING_WEBHOOK_SECRET: 'whsec_' + 'k'.repeat(30) };
    expect(() => loadConfig({ ...base, API_SURFACE: 'all' })).toThrow(/PLATFORM_MFA_KEY/);
    expect(() => loadConfig({ ...base, API_SURFACE: 'platform', PLATFORM_MFA_KEY: 'curta' })).toThrow(/PLATFORM_MFA_KEY/);
    expect(loadConfig({ ...base, API_SURFACE: 'tenant' }).API_SURFACE).toBe('tenant');
  });
});

// ---------------------------------------------------------------------------
describe('SEC-01 — RLS impede vendedor de ver lead de outro dono (mesmo sem filtro no código)', () => {
  async function asRole(tenantId: string, userId: string, role: string | null, sql: string, params: unknown[] = []) {
    const c = new pg.Client({ connectionString: inject('dbUrls').app });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)`, [tenantId, userId, role ?? '']);
      return await c.query(sql, params);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  it('quando consulta leads direto no banco como vendedor, então só vê os próprios e os sem dono', async () => {
    const owner = await signup(t.app);
    const seller = await addMember(t.app, owner, 'seller');
    await createLead(t.app, owner, { name: 'Do owner', ownerId: owner.userId });
    await createLead(t.app, owner, { name: 'Sem dono', ownerId: null });
    await createLead(t.app, seller, { name: 'Do vendedor' });
    const names = async (uid: string, role: string | null) =>
      (await asRole(owner.tenantId, uid, role, 'SELECT name FROM leads ORDER BY name')).rows.map((r) => r.name);
    expect(await names(seller.userId, 'seller')).toEqual(['Do vendedor', 'Sem dono']);
    expect(await names(owner.userId, 'owner')).toEqual(['Do owner', 'Do vendedor', 'Sem dono']);
    // Sem papel na transação: tratado como vendedor (o mais restrito)
    expect(await names(seller.userId, null)).toEqual(['Do vendedor', 'Sem dono']);
    expect(await names(owner.userId, null)).toEqual(['Do owner', 'Sem dono']); // owner sem papel NÃO vê tudo
    expect(await names('', null)).toEqual(['Sem dono']); // sem usuário e sem papel
  });

  it('quando o vendedor tenta gravar ou reatribuir lead para outra pessoa direto no banco, então o RLS bloqueia', async () => {
    const owner = await signup(t.app);
    const seller = await addMember(t.app, owner, 'seller');
    const st = await stages(t.app, owner);
    await expect(
      asRole(owner.tenantId, seller.userId, 'seller', `INSERT INTO leads (tenant_id, name, stage_id, owner_id) VALUES ($1, 'x', $2, $3)`, [owner.tenantId, st[0].id, owner.userId]),
    ).rejects.toThrow(/row-level security/);
    const mine = await createLead(t.app, seller);
    await expect(
      asRole(owner.tenantId, seller.userId, 'seller', `UPDATE leads SET owner_id = $1 WHERE id = $2`, [owner.userId, mine.id]),
    ).rejects.toThrow(/row-level security/);
  });

  it('quando o vendedor usa a API normalmente, então nada muda (cria, edita e vê o próprio lead)', async () => {
    const owner = await signup(t.app);
    const seller = await addMember(t.app, owner, 'seller');
    const lead = await createLead(t.app, seller);
    expect((await call(t.app, seller, 'PATCH', `/api/leads/${lead.id}`, { valueCents: 5 })).statusCode).toBe(200);
    expect((await call(t.app, seller, 'GET', '/api/leads')).json()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('SEC-03 — contadores do plano só mudam pelas funções', () => {
  it('quando o papel da API tenta zerar os contadores, então é negado', async () => {
    const s = await signup(t.app);
    const c = new pg.Client({ connectionString: inject('dbUrls').app });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [s.tenantId]);
      await expect(c.query('UPDATE tenants SET seats_used = 0, leads_count = 0')).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
      // Sem tenant na transação, a função não age sobre ninguém
      const r = await c.query('SELECT consume_seat() AS ok');
      expect(r.rows[0].ok).toBe(false);
    } finally {
      await c.end();
    }
  });
});

// ---------------------------------------------------------------------------
describe('SEC-10 — rate limit no banco (por e-mail e entre réplicas)', () => {
  it('quando o atacante troca de IP mas mira o mesmo e-mail, então o limite por e-mail bloqueia', async () => {
    const a = await createTestApp({ AUTH_EMAIL_LIMIT_PER_15MIN: '3', TRUST_PROXY: '1' });
    try {
      const codes = [];
      for (let i = 1; i <= 5; i++) {
        codes.push((await post(a.app, '/api/auth/login', { email: 'vitima@exemplo.com', password: 'errada-123' }, { 'x-forwarded-for': `198.51.100.${i}` })).statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      const keys = await t.db.platform.query('SELECT key_hash FROM auth_throttle');
      expect(keys.rows.every((r) => /^[0-9a-f]{64}$/.test(r.key_hash))).toBe(true); // sem e-mail/IP em claro
    } finally {
      await a.app.close(); await a.db.close();
    }
  });

  it('quando duas réplicas recebem tentativas do mesmo IP, então o limite é compartilhado', async () => {
    const [r1, r2] = await Promise.all([createTestApp({ AUTH_RATE_LIMIT_PER_MIN: '4' }), createTestApp({ AUTH_RATE_LIMIT_PER_MIN: '4' })]);
    try {
      const codes = [];
      for (let i = 0; i < 6; i++) {
        const app = i % 2 ? r2.app : r1.app;
        codes.push((await post(app, '/api/auth/login', { email: `x${i}@exemplo.com`, password: 'errada-123' })).statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 401, 429, 429]);
    } finally {
      for (const x of [r1, r2]) { await x.app.close(); await x.db.close(); }
    }
  });

  it('quando 10 tentativas chegam ao mesmo tempo com limite 4, então exatamente 4 passam', async () => {
    const a = await createTestApp({ AUTH_RATE_LIMIT_PER_MIN: '4' });
    try {
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => post(a.app, '/api/auth/login', { email: `y${i}@exemplo.com`, password: 'errada-123' })));
      expect(rs.filter((r) => r.statusCode === 401)).toHaveLength(4);
      expect(rs.filter((r) => r.statusCode === 429)).toHaveLength(6);
    } finally {
      await a.app.close(); await a.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('SEC-11 — erros não expõem nomes internos', () => {
  it('quando um registro único se repete (SKU de produto), então o código é genérico (sem nome de constraint)', async () => {
    const s = await signup(t.app);
    await createProduct(t.app, s, { sku: 'DUP-1' });
    const r = await call(t.app, s, 'POST', '/api/products', { sku: 'dup-1', name: 'Outro', priceCents: 100 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('duplicate');
    expect(r.body).not.toMatch(/products_|_uq|constraint/);
  });
});

// ---------------------------------------------------------------------------
describe('SEC-12 — cookies com prefixo em HTTPS e limpeza de sessões', () => {
  it('quando COOKIE_SECURE=true, então a sessão usa __Host- (Secure, Path=/) e o painel __Secure-', async () => {
    const a = await createTestApp({ COOKIE_SECURE: 'true' });
    try {
      const created = await a.db.withPlatform((c) =>
        provisionTenant(c, { companyName: 'Seg Co', slug: 'seg-co', ownerName: 'A', ownerEmail: 'seg@exemplo.com', planCode: 'starter' }, 'http://localhost:5173', null),
      );
      const s = await post(a.app, '/api/auth/accept-invite', { token: new URL(created.url).searchParams.get('token'), password: 'senha-forte-123' });
      const ck = s.cookies.find((c) => c.name === '__Host-g360_sid')!;
      expect(ck).toBeDefined();
      expect([ck.secure, ck.path, ck.domain]).toEqual([true, '/', undefined]);
      // Cookie sem prefixo não autentica em modo seguro
      const plain = await a.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `g360_sid=${ck.value}` } });
      expect(plain.statusCode).toBe(401);
      expect((await a.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `__Host-g360_sid=${ck.value}` } })).statusCode).toBe(200);

      const { secret } = await provisionPlatformAdmin(a.db.platform, { email: 'seg-adm@x.com', name: 'A', role: 'support', password: 'senha-admin-forte-1' }, MFA_KEY);
      const login = await post(a.app, '/api/platform/auth/login', { email: 'seg-adm@x.com', password: 'senha-admin-forte-1' });
      const mfa = await post(a.app, '/api/platform/auth/mfa', { challenge: login.json().challenge, code: totp(secret) });
      const pc = mfa.cookies.find((c) => c.name === '__Secure-g360_admin_sid')!;
      expect([pc.secure, pc.path, pc.httpOnly]).toEqual([true, '/api/platform', true]);
    } finally {
      await a.app.close(); await a.db.close();
    }
  });

  it('quando a limpeza roda, então remove só sessões, desafios e contadores vencidos', async () => {
    const s = await signup(t.app);
    await t.db.platform.query(`INSERT INTO sessions (token_hash, tenant_id, user_id, expires_at) VALUES ('velha', $1, $2, now() - interval '3 days')`, [s.tenantId, s.userId]);
    // preparo com o papel dono: g360_platform só tem SELECT/DELETE nessa tabela (por design)
    const owner = new pg.Client({ connectionString: inject('dbUrls').owner });
    await owner.connect();
    await owner.query(`INSERT INTO auth_throttle (key_hash, window_start, hits) VALUES (repeat('a', 64), now() - interval '2 days', 9)`);
    await owner.end();
    const r = await purgeExpired(t.deps);
    expect(r.sessions).toBe(1);
    expect(r.throttle).toBe(1);
    expect((await call(t.app, s, 'GET', '/api/auth/me')).statusCode).toBe(200); // sessão válida continua
  });
});
