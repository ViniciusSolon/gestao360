import type { FastifyRequest } from 'fastify';
import type { Client, Db } from '../db/db.js';
import type { TenantAuth } from '../auth/guards.js';
import { badRequest, conflict, unprocessable } from './errors.js';
import { sha256 } from './crypto.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

function keyFrom(req: FastifyRequest): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw badRequest('Header Idempotency-Key obrigatório (8 a 200 caracteres)', 'idempotency_key_required');
  }
  return key;
}

function hashRequest(endpoint: string, body: unknown) {
  return sha256(`${endpoint}\n${JSON.stringify(body ?? null)}`);
}

function replay(row: any, auth: TenantAuth, endpoint: string, requestHash: string): StoredResponse {
  if (row.user_id !== auth.userId || row.endpoint !== endpoint || row.request_hash !== requestHash) {
    throw unprocessable('Idempotency-Key já usada com outra requisição', 'idempotency_key_reused');
  }
  if (row.status_code == null) throw conflict('Requisição com esta chave ainda em processamento', 'idempotency_in_progress');
  return { status: row.status_code, body: row.response };
}

/**
 * Idempotência para operações 100% no banco: a chave é gravada na MESMA
 * transação do efeito. Uma segunda requisição concorrente bloqueia no índice
 * único até a primeira terminar e então devolve a resposta gravada.
 */
export async function idempotentTx(
  db: Db,
  req: FastifyRequest,
  auth: TenantAuth,
  endpoint: string,
  work: (c: Client) => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const key = keyFrom(req);
  const requestHash = hashRequest(endpoint, req.body);
  return db.withAuth(
    auth,
    async (c) => {
      const ins = await c.query(
        `INSERT INTO idempotency_keys (tenant_id, key, user_id, endpoint, request_hash)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING key`,
        [auth.tenantId, key, auth.userId, endpoint, requestHash],
      );
      if (!ins.rowCount) {
        const row = (await c.query('SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND key = $2', [auth.tenantId, key])).rows[0];
        return replay(row, auth, endpoint, requestHash);
      }
      const res = await work(c);
      await c.query(
        `UPDATE idempotency_keys SET status_code = $3, response = $4, completed_at = now()
          WHERE tenant_id = $1 AND key = $2`,
        [auth.tenantId, key, res.status, JSON.stringify(res.body)],
      );
      return res;
    },
  );
}

/**
 * Idempotência para operações que chamam serviço externo (não dá para
 * segurar a transação): grava a chave "em processamento", executa, grava a
 * resposta. Se falhar, libera a chave para nova tentativa.
 */
export async function idempotentExternal(
  db: Db,
  req: FastifyRequest,
  auth: TenantAuth,
  endpoint: string,
  work: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const key = keyFrom(req);
  const requestHash = hashRequest(endpoint, req.body);
  const existing = await db.withAuth(auth, async (c) => {
    const ins = await c.query(
      `INSERT INTO idempotency_keys (tenant_id, key, user_id, endpoint, request_hash)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING key`,
      [auth.tenantId, key, auth.userId, endpoint, requestHash],
    );
    if (ins.rowCount) return null;
    return (await c.query('SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND key = $2', [auth.tenantId, key])).rows[0];
  });
  if (existing) return replay(existing, auth, endpoint, requestHash);

  try {
    const res = await work();
    await db.withAuth(auth, (c) =>
      c.query(
        `UPDATE idempotency_keys SET status_code = $3, response = $4, completed_at = now()
          WHERE tenant_id = $1 AND key = $2`,
        [auth.tenantId, key, res.status, JSON.stringify(res.body)],
      ),
    );
    return res;
  } catch (e) {
    await db
      .withAuth(auth, (c) =>
        c.query('DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 AND status_code IS NULL', [auth.tenantId, key]),
      )
      .catch(() => {});
    throw e;
  }
}
