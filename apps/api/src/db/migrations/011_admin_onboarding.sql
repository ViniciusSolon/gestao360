-- 011_admin_onboarding.sql — clientes cadastrados pela plataforma; fim do teste grátis
--
-- 1) Não existe mais cadastro público: a equipe da plataforma cria a empresa e o
--    sistema gera um link para o responsável definir a senha. O link reaproveita a
--    tabela de convites (mesmo fluxo de aceite, atômico e de uso único), agora
--    também com o papel "owner" e com o nome da pessoa.
-- 2) Fim do período de teste de 14 dias: empresas novas já nascem ativas.
--
-- ALTERA DADOS: empresas hoje em "trialing" passam para "active" (senão seriam
-- bloqueadas quando o prazo antigo vencesse). Nenhuma linha é apagada.

-- (2) Teste grátis
ALTER TABLE tenants ALTER COLUMN status SET DEFAULT 'active';
UPDATE tenants SET status = 'active' WHERE status = 'trialing';

-- (1) Convite do responsável pela conta
ALTER TABLE invites DROP CONSTRAINT invites_role_check;
ALTER TABLE invites ADD CONSTRAINT invites_role_check CHECK (role IN ('owner','admin','manager','seller'));
-- Convite criado pela plataforma não tem um usuário da empresa como autor
ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL;
-- Nome de quem é convidado (aparece na tela "Você foi convidado para")
ALTER TABLE invites ADD COLUMN name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 120);
-- No máximo um convite de responsável pendente por empresa
CREATE UNIQUE INDEX invites_one_pending_owner_uq ON invites (tenant_id)
  WHERE role = 'owner' AND accepted_at IS NULL AND revoked_at IS NULL;
-- E um mesmo e-mail não pode ser responsável pendente de duas empresas: o usuário só
-- nasce quando a senha é definida, então sem isto dois cadastros com o mesmo e-mail
-- passariam na conferência e o segundo ficaria para sempre sem responsável.
CREATE UNIQUE INDEX invites_pending_owner_email_uq ON invites (lower(email))
  WHERE role = 'owner' AND accepted_at IS NULL AND revoked_at IS NULL;

-- A busca do convite pelo token passa a devolver também o nome e a empresa,
-- para a tela de aceite mostrar "Você foi convidado para: <nome>, <e-mail>, <papel>".
DROP FUNCTION auth_invite_lookup(text);
CREATE FUNCTION auth_invite_lookup(p_token_hash text)
RETURNS TABLE (invite_id uuid, tenant_id uuid, email text, role text, name text, tenant_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.tenant_id, i.email, i.role, i.name, t.name
    FROM invites i JOIN tenants t ON t.id = i.tenant_id
   WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL
     AND i.revoked_at IS NULL AND i.expires_at > now()
$$;
REVOKE ALL ON FUNCTION auth_invite_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_invite_lookup(text) TO g360_app;
