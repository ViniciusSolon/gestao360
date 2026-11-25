import type { Deps } from '../deps.js';
import { syncSubscription } from '../billing/sync.js';
import { templates } from '../email/email.js';

type Handler = (deps: Deps, payload: any) => Promise<void>;

export const handlers: Record<string, Handler> = {
  'billing.sync_subscription': (deps, p) => syncSubscription(deps, p.subscriptionId),
  'email.invite': (deps, p) => deps.email.send({ to: p.to, ...templates.invite(p) }),
  'email.owner_access': (deps, p) => deps.email.send({ to: p.to, ...templates.ownerAccess(p) }),
  'email.subscription_active': (deps, p) => deps.email.send({ to: p.to, ...templates.subscriptionActive(p) }),
};

/**
 * Pega o próximo job livre com FOR UPDATE SKIP LOCKED: vários workers em
 * paralelo nunca pegam o mesmo job. Jobs "presos" (worker morreu) voltam após 5 min.
 */
async function claim(deps: Deps) {
  return deps.db.withPlatform(async (c) => {
    const r = await c.query(
      `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
        WHERE id = (
          SELECT id FROM jobs
           WHERE (status = 'queued' AND run_at <= now())
              OR (status = 'running' AND locked_at < now() - interval '5 minutes')
           ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING id, type, payload, attempts, max_attempts`,
    );
    return r.rows[0] as { id: string; type: string; payload: any; attempts: number; max_attempts: number } | undefined;
  });
}

export async function runOneJob(deps: Deps): Promise<boolean> {
  const job = await claim(deps);
  if (!job) return false;
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`sem handler para ${job.type}`);
    await handler(deps, job.payload);
    await deps.db.platform.query(`UPDATE jobs SET status = 'done', last_error = NULL WHERE id = $1`, [job.id]);
  } catch (e) {
    const failed = job.attempts >= job.max_attempts;
    await deps.db.platform.query(
      `UPDATE jobs SET status = $2, last_error = $3,
              run_at = now() + (interval '10 seconds' * power(2, attempts))
        WHERE id = $1`,
      [job.id, failed ? 'failed' : 'queued', String((e as Error).message).slice(0, 2000)],
    );
  }
  return true;
}

/** Processa até a fila esvaziar (usado nos testes e no worker). */
export async function drainJobs(deps: Deps, max = 100): Promise<number> {
  let n = 0;
  while (n < max && (await runOneJob(deps))) n++;
  return n;
}

/**
 * Limpeza (SEC-12): sessões e desafios vencidos, chaves de idempotência antigas e
 * contadores de rate limit fora da janela. Idempotente; seguro com N workers.
 */
export async function purgeExpired(deps: Deps) {
  const q = (sql: string) => deps.db.platform.query(sql).then((r) => r.rowCount ?? 0);
  return {
    sessions: await q(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`),
    platformSessions: await q(`DELETE FROM platform_sessions WHERE expires_at < now() - interval '1 day'`),
    challenges: await q(`DELETE FROM platform_login_challenges WHERE expires_at < now() - interval '1 hour'`),
    idempotencyKeys: await q(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`),
    throttle: await q(`DELETE FROM auth_throttle WHERE window_start < now() - interval '1 day'`),
  };
}

const PURGE_EVERY_MS = 60 * 60 * 1000;

export function startWorkerLoop(deps: Deps, intervalMs = 1000) {
  let stopped = false;
  let lastPurge = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      await drainJobs(deps);
      if (Date.now() - lastPurge > PURGE_EVERY_MS) {
        lastPurge = Date.now();
        await purgeExpired(deps);
      }
    } catch (e) {
      console.error('[worker]', (e as Error).message);
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
  };
}
