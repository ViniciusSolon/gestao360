-- 002_rls_and_grants.sql — isolamento de tenant (RLS) e privilégios mínimos
--
-- Papéis (criados fora das migrations, ver scripts/db-bootstrap.sql):
--   g360_owner    : dono das tabelas; roda migrations. Nunca usado pela API.
--   g360_app      : API dos tenants. NOBYPASSRLS. Só enxerga o tenant de app.tenant_id.
--   g360_platform : painel interno, webhooks e worker. BYPASSRLS. Nunca exposto a tenants.

-- ---------------------------------------------------------------------------
-- RLS em todas as tabelas com dados de tenant
-- ---------------------------------------------------------------------------
ALTER TABLE tenants            ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads              ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE products           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_counters    ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys   ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log          ENABLE ROW LEVEL SECURITY;
-- Tabelas só da plataforma: RLS ligado e NENHUMA policy para g360_app (nega tudo)
ALTER TABLE webhook_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins    ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_sessions  ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants TO g360_app
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sessions','invites','pipeline_stages','leads','lead_events',
    'activities','products','tenant_counters','proposals','proposal_items','idempotency_keys',
    'billing_operations','subscriptions','jobs','audit_log']
  LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO g360_app
         USING (tenant_id = app_current_tenant())
         WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Privilégios mínimos para g360_app (colunas sensíveis não são graváveis)
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO g360_app, g360_platform;

GRANT SELECT ON plans TO g360_app;

-- status, plan_id, trial_ends_at, billing_customer_id: só a plataforma altera
GRANT SELECT ON tenants TO g360_app;
GRANT INSERT (id, name, slug, plan_id) ON tenants TO g360_app;
GRANT UPDATE (name, seats_used, leads_count) ON tenants TO g360_app;

GRANT SELECT, INSERT ON users TO g360_app;
GRANT UPDATE (name, role, active, password_hash) ON users TO g360_app;

GRANT SELECT, INSERT, DELETE ON sessions TO g360_app;
GRANT SELECT, INSERT ON invites TO g360_app;
GRANT UPDATE (accepted_at, revoked_at) ON invites TO g360_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_stages TO g360_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO g360_app;
GRANT SELECT, INSERT ON lead_events TO g360_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON activities TO g360_app;
GRANT SELECT, INSERT ON products TO g360_app;
GRANT UPDATE (sku, name, description, price_cents, ncm, tax_rate_bp, photo_url, active) ON products TO g360_app;
GRANT SELECT, INSERT, UPDATE ON tenant_counters TO g360_app;

-- Valores de proposta são imutáveis depois de criados
GRANT SELECT, INSERT ON proposals TO g360_app;
GRANT UPDATE (status, sent_at, decided_at) ON proposals TO g360_app;
GRANT SELECT, INSERT ON proposal_items TO g360_app;

GRANT SELECT, INSERT, DELETE ON idempotency_keys TO g360_app;
GRANT UPDATE (status_code, response, completed_at) ON idempotency_keys TO g360_app;

GRANT SELECT, INSERT ON billing_operations TO g360_app;
GRANT UPDATE (provider_ref, checkout_url) ON billing_operations TO g360_app;
GRANT SELECT ON subscriptions TO g360_app;

-- SELECT só da coluna de dedupe: exigido pelo ON CONFLICT (dedupe_key); RLS ainda restringe ao tenant
GRANT INSERT, SELECT (dedupe_key) ON jobs TO g360_app;
GRANT SELECT, INSERT ON audit_log TO g360_app;

GRANT USAGE ON SEQUENCE lead_events_id_seq, jobs_id_seq, audit_log_id_seq TO g360_app;

-- ---------------------------------------------------------------------------
-- Plataforma: acesso total, BYPASSRLS definido no papel
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO g360_platform;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO g360_platform;

-- ---------------------------------------------------------------------------
-- Funções de autenticação (antes de existir tenant no contexto)
-- SECURITY DEFINER: rodam como dono (sem RLS) e devolvem só o mínimo.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth_login_lookup(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.active
  FROM users u WHERE lower(u.email) = lower(p_email)
$$;

CREATE FUNCTION auth_session_lookup(p_token_hash text)
RETURNS TABLE (user_id uuid, tenant_id uuid, name text, email text, role text,
               tenant_name text, tenant_status text, trial_ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.name, u.email, u.role, t.name, t.status, t.trial_ends_at
  FROM sessions s
  JOIN users u   ON u.id = s.user_id AND u.tenant_id = s.tenant_id
  JOIN tenants t ON t.id = s.tenant_id
  WHERE s.token_hash = p_token_hash AND s.expires_at > now() AND u.active
$$;

CREATE FUNCTION auth_invite_lookup(p_token_hash text)
RETURNS TABLE (invite_id uuid, tenant_id uuid, email text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.tenant_id, i.email, i.role FROM invites i
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL
    AND i.revoked_at IS NULL AND i.expires_at > now()
$$;

REVOKE ALL ON FUNCTION auth_login_lookup(text), auth_session_lookup(text), auth_invite_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login_lookup(text), auth_session_lookup(text), auth_invite_lookup(text) TO g360_app;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO g360_app, g360_platform;
