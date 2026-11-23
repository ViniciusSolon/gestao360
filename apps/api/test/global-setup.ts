import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate.js';

/**
 * Prepara um banco de TESTE descartável. Regras de segurança:
 * - exige TEST_DATABASE_ADMIN_URL explícito (nunca usa DATABASE_*_URL da app);
 * - o nome do banco precisa terminar em _test;
 * - só aceita host local, a menos que ALLOW_REMOTE_TEST_DB=1.
 */
export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5434/postgres';
  const dbName = process.env.TEST_DATABASE_NAME ?? 'gestao360_test';
  const u = new URL(adminUrl);
  if (!dbName.endsWith('_test')) throw new Error('TEST_DATABASE_NAME precisa terminar em _test');
  if (!['127.0.0.1', 'localhost', 'postgres-test'].includes(u.hostname) && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
    throw new Error(`Banco de teste precisa ser local (host=${u.hostname}). Nunca aponte para produção.`);
  }

  const pw = () => randomBytes(18).toString('base64url');
  const pws = { owner: pw(), app: pw(), platform: pw() };
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // Os papéis g360_* são do cluster inteiro e têm a senha redefinida aqui.
  // Se o cluster tiver qualquer banco da aplicação que não seja de teste, abortamos.
  const foreign = await admin.query(
    `SELECT d.datname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
      WHERE r.rolname = 'g360_owner' AND d.datname NOT LIKE '%\\_test'`,
  );
  if (foreign.rowCount) {
    await admin.end();
    throw new Error(
      `O cluster de teste contém bancos não-teste (${foreign.rows.map((r) => r.datname).join(', ')}). ` +
        'Use um Postgres dedicado para testes (ex.: serviço postgres-test do docker-compose, porta 5434).',
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  for (const [role, extra] of [['g360_owner', ''], ['g360_app', 'NOBYPASSRLS'], ['g360_platform', 'BYPASSRLS']] as const) {
    const key = role.replace('g360_', '') as keyof typeof pws;
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
    const sql = `${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN ${extra} PASSWORD '${pws[key]}'`;
    await admin.query(sql);
  }
  await admin.query(`CREATE DATABASE ${dbName} OWNER g360_owner`);
  await admin.end();

  const url = (role: string, p: string) => {
    const x = new URL(adminUrl);
    x.username = role;
    x.password = p;
    x.pathname = `/${dbName}`;
    return x.toString();
  };
  await migrate(url('g360_owner', pws.owner), () => {});
  project.provide('dbUrls', { app: url('g360_app', pws.app), platform: url('g360_platform', pws.platform), owner: url('g360_owner', pws.owner) });
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrls: { app: string; platform: string; owner: string };
  }
}
