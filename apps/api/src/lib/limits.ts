import type { Client } from '../db/db.js';
import { unprocessable } from './errors.js';

/**
 * Limites do plano: operação ATÔMICA no banco via funções SECURITY DEFINER
 * (migration 007). Incrementa só se ainda houver espaço; duas requisições
 * simultâneas nunca passam do limite. As funções agem sobre o tenant da
 * transação (app.tenant_id) — a API não tem mais UPDATE nessas colunas.
 */
async function call(c: Client, fn: 'consume_seat' | 'release_seat' | 'consume_lead' | 'release_lead'): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(`SELECT ${fn}() AS ok`);
  return r.rows[0].ok;
}

export async function consumeSeat(c: Client) {
  if (!(await call(c, 'consume_seat'))) throw unprocessable('Limite de usuários do plano atingido', 'plan_seat_limit');
}

export async function releaseSeat(c: Client) {
  await call(c, 'release_seat');
}

export async function consumeLeadQuota(c: Client) {
  if (!(await call(c, 'consume_lead'))) throw unprocessable('Limite de leads do plano atingido', 'plan_lead_limit');
}

export async function releaseLeadQuota(c: Client) {
  await call(c, 'release_lead');
}

/** Próximo número sequencial por tenant (atômico: UPSERT + incremento numa única instrução). */
export async function nextCounter(c: Client, tenantId: string, name: string): Promise<number> {
  const r = await c.query(
    `INSERT INTO tenant_counters (tenant_id, name, value) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, name) DO UPDATE SET value = tenant_counters.value + 1
     RETURNING value`,
    [tenantId, name],
  );
  return Number(r.rows[0].value);
}

export async function audit(
  c: Client,
  e: { tenantId: string | null; actorType: 'user' | 'platform_admin' | 'system'; actorId?: string | null; action: string; targetType?: string; targetId?: string; metadata?: object; ip?: string },
) {
  await c.query(
    `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, target_type, target_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.tenantId, e.actorType, e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.metadata ?? {}), e.ip ?? null],
  );
}
