import type pg from 'pg';
import { sha256 } from './crypto.js';
import { tooManyRequests } from './errors.js';

export interface ThrottleRule {
  /** Chave lógica, ex.: `login:ip:1.2.3.4` ou `login:email:a@b.com`. Só o hash vai ao banco. */
  key: string;
  max: number;
  windowSeconds: number;
}

/**
 * Rate limit no Postgres (SEC-10): conta a tentativa com UPSERT atômico (função
 * auth_throttle_hit, migration 006) e recusa com 429 acima do limite. Vale para
 * qualquer número de réplicas e sobrevive a deploys. Todas as regras são contadas
 * antes de decidir, para o atacante não "economizar" tentativas numa chave.
 */
export async function throttle(pool: pg.Pool, rules: ThrottleRule[]): Promise<void> {
  let blocked = false;
  for (const r of rules) {
    const res = await pool.query<{ hits: number }>('SELECT auth_throttle_hit($1, $2) AS hits', [sha256(r.key), r.windowSeconds]);
    if (res.rows[0].hits > r.max) blocked = true;
  }
  if (blocked) throw tooManyRequests();
}
