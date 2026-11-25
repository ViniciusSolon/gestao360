import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { inject } from 'vitest';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { FakeGateway, signPayload } from '../src/billing/gateway.js';
import type { EmailMessage, EmailSender } from '../src/email/email.js';
import type { Deps } from '../src/deps.js';
import { provisionTenant } from '../src/lib/tenants.js';
import { FakeProviders } from '../src/messaging/providers.js';

export const WEBHOOK_SECRET = 'whsec_test_' + 'x'.repeat(32);
export const ORIGIN = 'http://localhost:5173';
export const MFA_KEY = 'ab'.repeat(32);
export const CHANNEL_KEY = 'cd'.repeat(32);

/** Serviço externo simulado: e-mail (só registra o que seria enviado). */
export class RecordingEmail implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
  }
}

/** Permite ao helper signup() achar o banco a partir do app. */
const ctxByApp = new WeakMap<FastifyInstance, TestCtx>();

export interface TestCtx {
  app: FastifyInstance;
  deps: Deps;
  gateway: FakeGateway;
  email: RecordingEmail;
  db: Db;
  messaging: FakeProviders;
}

export async function createTestApp(env: Record<string, string | undefined> = {}): Promise<TestCtx> {
  const urls = inject('dbUrls');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_APP_URL: urls.app,
    DATABASE_PLATFORM_URL: urls.platform,
    DB_POOL_MAX: '10',
    BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET,
    WEB_ORIGINS: ORIGIN,
    API_SURFACE: 'all',
    PLATFORM_MFA_KEY: MFA_KEY,
    CHANNEL_SECRETS_KEY: CHANNEL_KEY,
    MESSAGING_MODE: 'fake',
    AUTH_RATE_LIMIT_PER_MIN: '10000',
    ...env,
  });
  const db = new Db(config.DATABASE_APP_URL, config.DATABASE_PLATFORM_URL, config.DB_POOL_MAX);
  const gateway = new FakeGateway();
  const email = new RecordingEmail();
  const messaging = new FakeProviders();
  const deps: Deps = { config, db, gateway, email, messaging };
  const app = await buildApp(deps);
  const ctx = { app, deps, gateway, email, db, messaging };
  ctxByApp.set(app, ctx);
  return ctx;
}

/** Limpa os dados entre testes (mantém planos e migrations). */
export async function resetDb(_db: Db) {
  const owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  await owner.connect();
  try {
    const { rows } = await owner.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('plans','schema_migrations')`,
    );
    await owner.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await owner.end();
  }
}

export function cookieOf(res: LightMyRequestResponse, name = 'g360_sid'): string {
  const c = res.cookies.find((x) => x.name === name);
  if (!c) throw new Error(`cookie ${name} ausente (status ${res.statusCode}: ${res.body})`);
  return `${name}=${c.value}`;
}

export interface Session {
  cookie: string;
  tenantId: string;
  userId: string;
}

let seq = 0;
/**
 * Cria uma empresa cliente como no fluxo real: a PLATAFORMA cadastra (provisionTenant)
 * e o responsável define a senha pelo link de acesso (POST /api/auth/accept-invite).
 * Devolve a sessão do responsável (owner).
 */
export async function signup(app: FastifyInstance, overrides: Partial<{ companyName: string; slug: string; email: string; name: string; planCode: string }> = {}): Promise<Session> {
  seq++;
  const id = `${Date.now().toString(36)}${seq}`;
  const ctx = ctxByApp.get(app);
  if (!ctx) throw new Error('app de teste desconhecido');
  const created = await ctx.db.withPlatform((c) =>
    provisionTenant(
      c,
      {
        companyName: overrides.companyName ?? `Empresa ${id}`,
        slug: overrides.slug ?? `empresa-${id}`,
        ownerName: overrides.name ?? 'Dona',
        ownerEmail: overrides.email ?? `owner-${id}@exemplo.com`,
        planCode: overrides.planCode ?? 'starter',
      },
      ctx.deps.config.APP_PUBLIC_URL,
      null,
    ),
  );
  const token = new URL(created.url).searchParams.get('token')!;
  const res = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { origin: ORIGIN }, payload: { token, password: 'senha-forte-123' } });
  if (res.statusCode !== 201) throw new Error(`definir senha falhou: ${res.statusCode} ${res.body}`);
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieOf(res) } });
  return { cookie: cookieOf(res), tenantId: created.tenantId, userId: me.json().user.id };
}

/** Requisição autenticada como usuário do tenant. */
export function call(app: FastifyInstance, s: Session | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { origin: ORIGIN, ...(s ? { cookie: s.cookie } : {}), ...headers },
  });
}

/** Convida e aceita: devolve sessão do novo usuário com o papel pedido. */
export async function addMember(app: FastifyInstance, owner: Session, role: 'admin' | 'manager' | 'seller', email = `${role}-${randomUUID().slice(0, 8)}@exemplo.com`): Promise<Session> {
  const inv = await call(app, owner, 'POST', '/api/invites', { email, role });
  if (inv.statusCode !== 201) throw new Error(`convite falhou: ${inv.statusCode} ${inv.body}`);
  const token = new URL(inv.json().url).searchParams.get('token')!;
  const res = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { origin: ORIGIN }, payload: { token, name: role, password: 'senha-forte-123' } });
  if (res.statusCode !== 201) throw new Error(`aceite falhou: ${res.statusCode} ${res.body}`);
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieOf(res) } });
  return { cookie: cookieOf(res), tenantId: owner.tenantId, userId: me.json().user.id };
}

export async function stages(app: FastifyInstance, s: Session) {
  const r = await call(app, s, 'GET', '/api/stages');
  return r.json() as { id: string; name: string; kind: string }[];
}

export async function createLead(app: FastifyInstance, s: Session, payload: Record<string, unknown> = {}) {
  const r = await call(app, s, 'POST', '/api/leads', { name: 'Lead Teste', company: 'ACME', valueCents: 100000, ...payload });
  if (r.statusCode !== 201) throw new Error(`lead falhou: ${r.statusCode} ${r.body}`);
  return r.json();
}

export async function createProduct(app: FastifyInstance, s: Session, payload: Record<string, unknown> = {}) {
  const r = await call(app, s, 'POST', '/api/products', { sku: `SKU-${randomUUID().slice(0, 6)}`, name: 'Produto', priceCents: 10000, taxRateBp: 1000, ncm: '84713012', ...payload });
  if (r.statusCode !== 201) throw new Error(`produto falhou: ${r.statusCode} ${r.body}`);
  return r.json();
}

export function signedWebhook(app: FastifyInstance, event: object, secret = WEBHOOK_SECRET, sigOverride?: string) {
  const body = JSON.stringify(event);
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/billing',
    headers: { 'content-type': 'application/json', 'stripe-signature': sigOverride ?? signPayload(secret, body) },
    payload: body,
  });
}

export async function setTenantStatus(db: Db, tenantId: string, status: string, extra = '') {
  await db.platform.query(`UPDATE tenants SET status = $2 ${extra} WHERE id = $1`, [tenantId, status]);
}
