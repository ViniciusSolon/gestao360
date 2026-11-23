import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { ZodError } from 'zod';
import type { Deps } from './deps.js';
import { AppError, forbidden, fromPg } from './lib/errors.js';
import { authRoutes } from './modules/auth.js';
import { userRoutes } from './modules/users.js';
import { pipelineRoutes } from './modules/pipeline.js';
import { leadRoutes } from './modules/leads.js';
import { activityRoutes } from './modules/activities.js';
import { productRoutes } from './modules/products.js';
import { proposalRoutes } from './modules/proposals.js';
import { dashboardRoutes } from './modules/dashboard.js';
import { billingRoutes } from './modules/billing.js';
import { webhookRoutes } from './modules/webhooks.js';
import { platformRoutes } from './modules/platform.js';

/** N proxies confiáveis = confiar só nos N saltos mais próximos (equivale ao trustProxy numérico). */
function trustProxyOption(v: false | number | string): boolean | string | ((addr: string, hop: number) => boolean) {
  if (typeof v === 'number') return (_addr, hop) => hop < v;
  return v;
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    bodyLimit: 1024 * 1024,
    // Só confia em X-Forwarded-For vindo dos proxies configurados (ver TRUST_PROXY em config.ts)
    trustProxy: trustProxyOption(deps.config.TRUST_PROXY),
  });

  // Só JSON é aceito como corpo (remove o parser text/plain usado em CSRF via <form>)
  app.removeContentTypeParser('text/plain');

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: deps.config.webOrigins, credentials: true });
  await app.register(cookie);

  // Defesa CSRF: requisições de escrita vindas de navegador precisam de Origin autorizada
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.url.startsWith('/api/webhooks/')) return; // server-to-server, autenticado por assinatura
    const origin = req.headers.origin;
    if (origin && !deps.config.webOrigins.includes(origin)) throw forbidden('Origem não autorizada');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation',
        message: 'Dados inválidos',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const pg = fromPg(err);
    if (pg) return reply.status(pg.status).send({ error: pg.code, message: pg.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: 'request_error', message: (err as Error).message });
    req.log.error(err);
    if (deps.config.NODE_ENV === 'test' && process.env.DEBUG_ERRORS) console.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Erro interno' });
  });

  app.get('/health', async () => {
    await deps.db.app.query('SELECT 1');
    return { ok: true };
  });

  const surface = deps.config.API_SURFACE;
  if (surface === 'tenant' || surface === 'all') {
    await app.register(
      async (api) => {
        await authRoutes(api, deps);
        await userRoutes(api, deps);
        await pipelineRoutes(api, deps);
        await leadRoutes(api, deps);
        await activityRoutes(api, deps);
        await productRoutes(api, deps);
        await proposalRoutes(api, deps);
        await dashboardRoutes(api, deps);
        await billingRoutes(api, deps);
      },
      { prefix: '/api' },
    );
    await app.register(async (wh) => webhookRoutes(wh, deps), { prefix: '/api/webhooks' });
  }
  if (surface === 'platform' || surface === 'all') {
    await app.register(async (p) => platformRoutes(p, deps), { prefix: '/api/platform' });
  }
  return app;
}
