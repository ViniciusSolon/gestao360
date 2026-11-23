import pg from 'pg';

export type Client = pg.PoolClient;

/**
 * Dois pools com papéis diferentes no Postgres:
 * - app: g360_app, sujeito a RLS. Toda query de tenant passa por withTenant().
 * - platform: g360_platform (BYPASSRLS). Só painel interno e worker. É OPCIONAL:
 *   o processo público (API_SURFACE=tenant) roda sem essa credencial.
 */
export class Db {
  readonly app: pg.Pool;
  private readonly platformPool: pg.Pool | null;

  constructor(appUrl: string, platformUrl: string | undefined, max = 10) {
    this.app = new pg.Pool({ connectionString: appUrl, max });
    this.platformPool = platformUrl ? new pg.Pool({ connectionString: platformUrl, max: Math.max(2, Math.ceil(max / 2)) }) : null;
  }

  /** Pool BYPASSRLS. Falha alto se este processo não recebeu a credencial. */
  get platform(): pg.Pool {
    if (!this.platformPool) throw new Error('Este processo não tem acesso ao banco da plataforma (DATABASE_PLATFORM_URL ausente)');
    return this.platformPool;
  }

  /**
   * Transação de um usuário autenticado: fixa empresa, usuário e papel. O RLS usa os
   * três (isolamento por empresa + policy de leads por vendedor, migration 009).
   * Use SEMPRE esta forma nas rotas autenticadas.
   */
  withAuth<T>(auth: { tenantId: string; userId: string; role: string }, fn: (c: Client) => Promise<T>): Promise<T> {
    return this.withTenant(auth.tenantId, fn, auth.userId, auth.role);
  }

  /**
   * Transação com o tenant fixado (SET LOCAL via set_config(..., true)). Sem papel,
   * o banco trata a transação como vendedor sem usuário (falha segura). Use só em
   * fluxos sem sessão (cadastro, login, aceite de convite).
   */
  async withTenant<T>(tenantId: string, fn: (c: Client) => Promise<T>, userId?: string, role?: string): Promise<T> {
    const c = await this.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)`,
        [tenantId, userId ?? '', role ?? ''],
      );
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /** Transação sem tenant no papel g360_app (só consegue chamar as funções auth_*). */
  async withAnon<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.app.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /** Transação no papel da plataforma (BYPASSRLS). */
  async withPlatform<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.platform.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async close() {
    await Promise.all([this.app.end(), this.platformPool?.end()]);
  }
}
