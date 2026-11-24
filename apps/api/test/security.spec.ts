import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createTestApp, ORIGIN, resetDb, signedWebhook, signup, type TestCtx } from './helpers.js';
import { loadConfig } from '../src/config.js';

const tryLogin = (t: TestCtx, xff?: string, remoteAddress = '127.0.0.1') =>
  t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress,
    headers: { origin: ORIGIN, ...(xff ? { 'x-forwarded-for': xff } : {}) },
    payload: { email: 'alvo@exemplo.com', password: 'senha-errada-123' },
  });

describe('SEC-08 — rate limit de login não pode ser contornado com X-Forwarded-For', () => {
  describe('sem proxy configurado (padrão)', () => {
    let t: TestCtx;
    beforeAll(async () => { t = await createTestApp({ AUTH_RATE_LIMIT_PER_MIN: '3' }); });
    afterAll(async () => { await t.app.close(); await t.db.close(); });
    beforeEach(async () => { await resetDb(t.db); });

    it('quando o atacante varia o X-Forwarded-For a cada tentativa, então ainda recebe 429 após o limite', async () => {
      const codes = [];
      for (let i = 1; i <= 5; i++) codes.push((await tryLogin(t, `10.0.0.${i}`)).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    });

    it('quando o painel da plataforma recebe X-Forwarded-For variando, então também limita', async () => {
      const codes = [];
      for (let i = 1; i <= 3; i++) {
        const r = await t.app.inject({
          method: 'POST', url: '/api/platform/auth/login', headers: { origin: ORIGIN, 'x-forwarded-for': `10.1.0.${i}` },
          payload: { email: 'adm@x.com', password: 'errada-errada' },
        });
        codes.push(r.statusCode);
      }
      expect(codes).toContain(429);
    });

    it('quando grava a auditoria, então usa o IP da conexão e ignora o cabeçalho forjado', async () => {
      await signup(t.app, { email: 'ip@exemplo.com' });
      await t.app.inject({
        method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.7',
        headers: { origin: ORIGIN, 'x-forwarded-for': '6.6.6.6' },
        payload: { email: 'ip@exemplo.com', password: 'senha-forte-123' },
      });
      const r = await t.db.platform.query(`SELECT ip FROM audit_log WHERE action = 'user.login'`);
      expect(r.rows[0].ip).toBe('203.0.113.7');
    });
  });

  describe('atrás de 1 proxy (TRUST_PROXY=1, como no docker-compose)', () => {
    let t: TestCtx;
    beforeAll(async () => { t = await createTestApp({ AUTH_RATE_LIMIT_PER_MIN: '3', TRUST_PROXY: '1' }); });
    afterAll(async () => { await t.app.close(); await t.db.close(); });

    it('quando o cliente injeta IPs à esquerda, então vale só o IP adicionado pelo proxy e o limite se mantém', async () => {
      const codes = [];
      for (let i = 1; i <= 5; i++) codes.push((await tryLogin(t, `10.0.0.${i}, 198.51.100.9`)).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    });

    it('quando dois clientes reais diferentes passam pelo proxy, então cada um tem a própria cota', async () => {
      for (let i = 0; i < 3; i++) await tryLogin(t, '198.51.100.20');
      expect((await tryLogin(t, '198.51.100.20')).statusCode).toBe(429);
      expect((await tryLogin(t, '198.51.100.21')).statusCode).toBe(401);
    });
  });

  it('quando TRUST_PROXY=true, então o servidor não sobe', () => {
    expect(() =>
      loadConfig({ DATABASE_APP_URL: 'postgres://a@h/d', DATABASE_PLATFORM_URL: 'postgres://b@h/d', BILLING_WEBHOOK_SECRET: 'whsec_' + 'k'.repeat(30), TRUST_PROXY: 'true' }),
    ).toThrow(/TRUST_PROXY/);
  });
});

describe('SEC-04/SEC-05 — simulador de pagamento não pode liberar plano fora de dev', () => {
  const base = { DATABASE_APP_URL: 'postgres://a@h/d', DATABASE_PLATFORM_URL: 'postgres://b@h/d', BILLING_WEBHOOK_SECRET: 'whsec_' + 'k'.repeat(30) };

  async function pagarSemGateway(t: TestCtx) {
    const s = await signup(t.app);
    const ck = await t.app.inject({
      method: 'POST', url: '/api/billing/checkout',
      headers: { origin: ORIGIN, cookie: s.cookie, 'idempotency-key': 'sec04-chave-0001' }, payload: { planCode: 'pro' },
    });
    const sim = await t.app.inject({ method: 'POST', url: `/api/webhooks/dev/fake-checkout/${ck.json().sessionId}/complete`, headers: { origin: ORIGIN } });
    const st = await t.db.platform.query('SELECT status FROM tenants WHERE id = $1', [s.tenantId]);
    return { simStatus: sim.statusCode, tenantStatus: st.rows[0].status };
  }

  it('quando NODE_ENV=development e gateway fake SEM a flag, então a rota não existe (404) e a conta não é ativada', async () => {
    const t = await createTestApp({ NODE_ENV: 'development' });
    try {
      await resetDb(t.db);
      const r = await pagarSemGateway(t);
      expect(r.simStatus).toBe(404);
      expect(r.tenantStatus).toBe('trialing');
    } finally { await t.app.close(); await t.db.close(); }
  });

  it('quando a flag ENABLE_FAKE_CHECKOUT=true está ligada em development, então o simulador funciona (uso local)', async () => {
    const t = await createTestApp({ NODE_ENV: 'development', ENABLE_FAKE_CHECKOUT: 'true' });
    try {
      await resetDb(t.db);
      const r = await pagarSemGateway(t);
      expect(r.simStatus).toBe(200);
    } finally { await t.app.close(); await t.db.close(); }
  });

  it('quando NODE_ENV não é definido, então o padrão é produção e o gateway fake é recusado', () => {
    expect(() => loadConfig({ ...base })).toThrow(/BILLING_PROVIDER/);
    expect(() => loadConfig({ ...base, BILLING_PROVIDER: 'fake' })).toThrow(/gateway fake/);
  });

  it('quando a flag é ligada fora de development ou sem gateway fake, então o servidor não sobe', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'test', ENABLE_FAKE_CHECKOUT: 'true' })).toThrow(/ENABLE_FAKE_CHECKOUT/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_live_x', ENABLE_FAKE_CHECKOUT: 'true' })).toThrow(/ENABLE_FAKE_CHECKOUT/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x', ENABLE_FAKE_CHECKOUT: 'true' })).toThrow(/ENABLE_FAKE_CHECKOUT/);
  });
});

describe('SEC-02 — API pública roda sem a credencial BYPASSRLS', () => {
  const base = { DATABASE_APP_URL: 'postgres://a@h/d', BILLING_WEBHOOK_SECRET: 'whsec_' + 'k'.repeat(30), NODE_ENV: 'test' };
  let pub: TestCtx; // API_SURFACE=tenant, sem DATABASE_PLATFORM_URL
  let ver: TestCtx; // só para conferir o banco
  beforeAll(async () => {
    pub = await createTestApp({ API_SURFACE: 'tenant', DATABASE_PLATFORM_URL: undefined });
    ver = await createTestApp();
  });
  afterAll(async () => {
    await pub.app.close(); await pub.db.close();
    await ver.app.close(); await ver.db.close();
  });
  beforeEach(async () => { await resetDb(ver.db); });

  const evento = (id: string, sub: string | null = 'sub_123') => ({
    id, type: 'customer.subscription.updated', data: { object: sub ? { id: sub } : {} },
  });

  it('quando o processo público não tem DATABASE_PLATFORM_URL, então ele nem tem acesso ao pool da plataforma', () => {
    expect(() => pub.db.platform).toThrow(/DATABASE_PLATFORM_URL/);
  });

  it('quando recebe um webhook válido, então grava o evento e enfileira a sincronização uma única vez', async () => {
    const r1 = await signedWebhook(pub.app, evento('evt_sec02_a'));
    const r2 = await signedWebhook(pub.app, evento('evt_sec02_a'));
    expect([r1.statusCode, r1.json().duplicate]).toEqual([200, false]);
    expect([r2.statusCode, r2.json().duplicate]).toEqual([200, true]);
    const jobs = await ver.db.platform.query(`SELECT type, payload, dedupe_key FROM jobs`);
    expect(jobs.rows).toEqual([{ type: 'billing.sync_subscription', payload: { subscriptionId: 'sub_123' }, dedupe_key: 'webhook:fake:evt_sec02_a' }]);
  });

  it('quando o mesmo evento chega 3 vezes ao mesmo tempo, então só um é aceito', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => signedWebhook(pub.app, evento('evt_sec02_b'))));
    expect(rs.map((r) => r.json().duplicate).filter((d) => d === false)).toHaveLength(1);
    const n = await ver.db.platform.query(`SELECT count(*) FROM jobs`);
    expect(Number(n.rows[0].count)).toBe(1);
  });

  it('quando o evento não tem assinatura, então registra o evento sem enfileirar job', async () => {
    expect((await signedWebhook(pub.app, evento('evt_sec02_c', null))).statusCode).toBe(200);
    const ev = await ver.db.platform.query(`SELECT count(*) FROM webhook_events`);
    const jobs = await ver.db.platform.query(`SELECT count(*) FROM jobs`);
    expect([Number(ev.rows[0].count), Number(jobs.rows[0].count)]).toEqual([1, 0]);
  });

  it('quando o ID do evento passa de 255 caracteres, então 400 e nada é gravado', async () => {
    expect((await signedWebhook(pub.app, evento('e'.repeat(256)))).statusCode).toBe(400);
    const ev = await ver.db.platform.query(`SELECT count(*) FROM webhook_events`);
    expect(Number(ev.rows[0].count)).toBe(0);
  });

  it('quando o processo público recebe rotas do painel, então elas não existem (404)', async () => {
    expect((await pub.app.inject({ method: 'GET', url: '/api/platform/tenants' })).statusCode).toBe(404);
  });

  it('quando o papel g360_app tenta gravar direto em webhook_events ou jobs de outro tipo, então é negado; a função valida a entrada', async () => {
    const c = new pg.Client({ connectionString: inject('dbUrls').app });
    await c.connect();
    try {
      await expect(c.query(`INSERT INTO webhook_events (provider, event_id, type) VALUES ('fake','x','y')`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`SELECT * FROM webhook_events`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`SELECT record_billing_webhook('Fake Provider!', 'evt', 't', null)`)).rejects.toThrow(/provider inválido/);
      const ok = await c.query(`SELECT record_billing_webhook('fake', 'evt_direto', 't', null) AS r`);
      expect(ok.rows[0].r).toBe(true);
    } finally {
      await c.end();
    }
  });

  it('quando falta DATABASE_PLATFORM_URL com painel ou worker embutido, então não sobe; só a API pública sobe sem ela', () => {
    expect(loadConfig({ ...base }).API_SURFACE).toBe('tenant');
    expect(() => loadConfig({ ...base, API_SURFACE: 'all' })).toThrow(/DATABASE_PLATFORM_URL/);
    expect(() => loadConfig({ ...base, API_SURFACE: 'platform' })).toThrow(/DATABASE_PLATFORM_URL/);
    expect(() => loadConfig({ ...base, WORKER_INLINE: 'true' })).toThrow(/DATABASE_PLATFORM_URL/);
  });
});

describe('Deploy na VPS — cadeia Caddy → nginx → API (TRUST_PROXY=2)', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp({ AUTH_RATE_LIMIT_PER_MIN: '3', TRUST_PROXY: '2' }); });
  afterAll(async () => { await t.app.close(); await t.db.close(); });
  beforeEach(async () => { await resetDb(t.db); });

  // A API recebe a conexão do nginx (172.18.0.5); o nginx acrescentou o IP do Caddy (172.18.0.9);
  // o Caddy registrou o IP real do cliente. Tudo que o cliente inventar fica à esquerda.
  const viaCaddy = (clientIp: string, forjado?: string) =>
    tryLogin(t, [forjado, clientIp, '172.18.0.9'].filter(Boolean).join(', '), '172.18.0.5');

  it('quando clientes diferentes passam pelo Caddy, então cada um tem a própria cota (não dividem o IP do proxy)', async () => {
    for (let i = 0; i < 3; i++) await viaCaddy('203.0.113.10');
    expect((await viaCaddy('203.0.113.10')).statusCode).toBe(429);
    expect((await viaCaddy('203.0.113.11')).statusCode).toBe(401);
  });

  it('quando o atacante forja X-Forwarded-For, então continua limitado pelo IP real', async () => {
    const codes = [];
    for (let i = 1; i <= 5; i++) codes.push((await viaCaddy('198.51.100.77', `10.9.9.${i}`)).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });

  it('quando grava a auditoria, então registra o IP real do cliente', async () => {
    await signup(t.app, { email: 'vps@exemplo.com' });
    await t.app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '172.18.0.5',
      headers: { origin: ORIGIN, 'x-forwarded-for': '6.6.6.6, 203.0.113.50, 172.18.0.9' },
      payload: { email: 'vps@exemplo.com', password: 'senha-forte-123' },
    });
    const r = await t.db.platform.query(`SELECT ip FROM audit_log WHERE action = 'user.login'`);
    expect(r.rows[0].ip).toBe('203.0.113.50');
  });
});
