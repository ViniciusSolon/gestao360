-- 009_rls_seller_leads.sql — SEC-01: visibilidade de leads por vendedor no próprio banco
-- (migration separada só com policies, como pedido)
--
-- Antes: o RLS isolava empresas; "vendedor só vê os próprios leads e os sem dono" era
-- só um filtro no código (leadScope). Uma rota que esquecesse o filtro vazaria a carteira.
-- Agora: policy RESTRICTIVE (combinada com AND à tenant_isolation). A API informa o
-- usuário e o papel por transação (set_config app.user_id / app.role em Db.withAuth).
--
-- Em português:
--   * owner/admin/gerente: leem e alteram todos os leads da empresa (como antes);
--   * vendedor: lê, cria, altera e apaga só leads sem dono ou cujo dono é ele;
--     não consegue gravar um lead atribuído a outra pessoa;
--   * sem papel definido na transação: tratado como VENDEDOR (o mais restrito) — vê só
--     os leads do usuário da transação e os sem dono; sem usuário, só os sem dono;
--   * painel/worker (g360_platform, BYPASSRLS) e funções de auth (dono) não são afetados.
-- Não altera dados.

CREATE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_current_role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('app.role', true), ''), 'seller') $$;

GRANT EXECUTE ON FUNCTION app_current_user(), app_current_role() TO g360_app;

CREATE POLICY seller_own_leads ON leads AS RESTRICTIVE TO g360_app
  USING (app_current_role() <> 'seller' OR owner_id IS NULL OR owner_id = app_current_user())
  WITH CHECK (app_current_role() <> 'seller' OR owner_id IS NULL OR owner_id = app_current_user());
