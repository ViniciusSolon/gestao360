import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Aplica migrations pendentes em ordem, cada uma em transação, como g360_owner. */
export async function migrate(ownerUrl: string, log = console.log) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Serializa execuções concorrentes de migrate (ex.: várias réplicas subindo juntas)
    await client.query(`SELECT pg_advisory_lock(360360)`);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`migration aplicada: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`falha na migration ${f}: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(360360)`).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL é obrigatório para rodar migrations');
  migrate(url).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
}
