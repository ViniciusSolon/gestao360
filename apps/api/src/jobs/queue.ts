import type { Client } from '../db/db.js';

export interface NewJob {
  type: string;
  payload: Record<string, unknown>;
  tenantId?: string | null;
  /** Chave de deduplicação: o mesmo job nunca é enfileirado duas vezes. */
  dedupeKey?: string;
  runAt?: Date;
}

/** Enfileira dentro da transação corrente (outbox): só vale se a transação comitar. */
export async function enqueue(c: Client, job: NewJob): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO jobs (tenant_id, type, payload, dedupe_key, run_at)
     VALUES ($1, $2, $3, $4, coalesce($5, now()))
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [job.tenantId ?? null, job.type, JSON.stringify(job.payload), job.dedupeKey ?? null, job.runAt ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}
