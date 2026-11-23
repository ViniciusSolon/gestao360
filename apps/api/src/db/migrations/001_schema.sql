-- 001_schema.sql — Gestão 360° (MVP)
-- Executado pelo papel dono do schema (g360_owner). A aplicação conecta como
-- g360_app (sujeito a RLS) e o painel da plataforma/worker como g360_platform.

-- ---------------------------------------------------------------------------
-- Função que lê o tenant corrente (definido por transação com set_config)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Planos (catálogo da plataforma, só leitura para os tenants)
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  price_cents      integer NOT NULL CHECK (price_cents >= 0),
  max_users        integer NOT NULL CHECK (max_users > 0),
  max_leads        integer CHECK (max_leads IS NULL OR max_leads > 0),
  gateway_price_id text,
  public           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tenants (empresas clientes)
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id                  uuid PRIMARY KEY,
  name                text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status              text NOT NULL DEFAULT 'trialing'
                      CHECK (status IN ('trialing','active','past_due','suspended','canceled')),
  plan_id             uuid NOT NULL REFERENCES plans(id),
  seats_used          integer NOT NULL DEFAULT 0 CHECK (seats_used >= 0),
  leads_count         integer NOT NULL DEFAULT 0 CHECK (leads_count >= 0),
  trial_ends_at       timestamptz NOT NULL DEFAULT now() + interval '14 days',
  billing_customer_id text UNIQUE,
  suspended_reason    text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Usuários (um e-mail = um usuário em toda a plataforma)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email         text NOT NULL CHECK (position('@' in email) > 1),
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','admin','manager','seller')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
-- Exatamente um owner por tenant
CREATE UNIQUE INDEX users_one_owner_uq ON users (tenant_id) WHERE role = 'owner';

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sessions_user_idx ON sessions (tenant_id, user_id);

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin','manager','seller')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
-- No máximo um convite pendente por e-mail em cada tenant (duplo clique não duplica)
CREATE UNIQUE INDEX invites_pending_uq ON invites (tenant_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- CRM: funil, leads, histórico, atividades
-- ---------------------------------------------------------------------------
CREATE TABLE pipeline_stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position    integer NOT NULL CHECK (position >= 0),
  probability integer NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  kind        text NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX pipeline_stages_tenant_idx ON pipeline_stages (tenant_id, position);

CREATE TABLE leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  company             text,
  email               text,
  phone               text,
  channel             text NOT NULL DEFAULT 'outro',
  owner_id            uuid,
  stage_id            uuid NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  is_mql              boolean NOT NULL DEFAULT false,
  score               integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  value_cents         bigint NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
  expected_close_date date,
  lost_reason         text,
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES pipeline_stages (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX leads_tenant_stage_idx ON leads (tenant_id, stage_id);
CREATE INDEX leads_tenant_created_idx ON leads (tenant_id, created_at);

CREATE TABLE lead_events (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  lead_id    uuid NOT NULL,
  user_id    uuid,
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX lead_events_lead_idx ON lead_events (tenant_id, lead_id, created_at);

CREATE TABLE activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  lead_id     uuid,
  type        text NOT NULL CHECK (type IN ('task','call','meeting','email','note')),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  notes       text,
  due_at      timestamptz,
  done_at     timestamptz,
  assigned_to uuid NOT NULL,
  meeting_url text CHECK (meeting_url IS NULL OR meeting_url ~ '^https://'),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, assigned_to) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX activities_tenant_due_idx ON activities (tenant_id, assigned_to, due_at);

-- ---------------------------------------------------------------------------
-- Catálogo e propostas
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  sku         text NOT NULL CHECK (length(sku) BETWEEN 1 AND 60),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text,
  price_cents bigint NOT NULL CHECK (price_cents >= 0),
  ncm         text CHECK (ncm IS NULL OR ncm ~ '^[0-9]{8}$'),
  tax_rate_bp integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  photo_url   text CHECK (photo_url IS NULL OR photo_url ~ '^https://'),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX products_sku_uq ON products (tenant_id, lower(sku));

-- Contadores por tenant (numeração sequencial de propostas etc.)
CREATE TABLE tenant_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name      text NOT NULL,
  value     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE proposals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  number         bigint NOT NULL,
  lead_id        uuid NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected')),
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents bigint NOT NULL CHECK (discount_cents >= 0),
  tax_cents      bigint NOT NULL CHECK (tax_cents >= 0),
  freight_cents  bigint NOT NULL CHECK (freight_cents >= 0),
  total_cents    bigint NOT NULL CHECK (total_cents >= 0),
  payment_terms  text,
  valid_until    date,
  notes          text,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  decided_at     timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
-- Só uma proposta aceita por lead
CREATE UNIQUE INDEX proposals_one_accepted_per_lead_uq ON proposals (tenant_id, lead_id) WHERE status = 'accepted';

CREATE TABLE proposal_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  proposal_id      uuid NOT NULL,
  product_id       uuid NOT NULL,
  description      text NOT NULL,
  quantity         numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  discount_bp      integer NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  tax_rate_bp      integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  total_cents      bigint NOT NULL CHECK (total_cents >= 0),
  position         integer NOT NULL,
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Idempotência de endpoints do app (header Idempotency-Key)
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  key           text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  user_id       uuid NOT NULL,
  endpoint      text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer,
  response      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  PRIMARY KEY (tenant_id, key)
);

-- ---------------------------------------------------------------------------
-- Cobrança (assinatura SaaS)
-- ---------------------------------------------------------------------------
CREATE TABLE billing_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  kind            text NOT NULL CHECK (kind IN ('checkout')),
  plan_id         uuid NOT NULL REFERENCES plans(id),
  idempotency_key uuid NOT NULL UNIQUE,
  provider_ref    text,
  checkout_url    text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Uma operação de negócio pendente por (tenant, tipo, plano): retentativas reaproveitam a mesma chave
CREATE UNIQUE INDEX billing_operations_pending_uq ON billing_operations (tenant_id, kind, plan_id)
  WHERE status = 'pending';

CREATE TABLE subscriptions (
  tenant_id                uuid PRIMARY KEY REFERENCES tenants(id),
  provider_subscription_id text NOT NULL UNIQUE,
  status                   text NOT NULL,
  plan_id                  uuid NOT NULL REFERENCES plans(id),
  current_period_end       timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- ---------------------------------------------------------------------------
-- Fila de jobs no próprio Postgres (FOR UPDATE SKIP LOCKED)
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  last_error   text,
  dedupe_key   text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';

-- ---------------------------------------------------------------------------
-- Auditoria (LGPD / rastreabilidade)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid,
  actor_type  text NOT NULL CHECK (actor_type IN ('user','platform_admin','system')),
  actor_id    uuid,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Painel da plataforma (equipe interna). Sem nenhum GRANT para g360_app.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('superadmin','support')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email_uq ON platform_admins (lower(email));

CREATE TABLE platform_sessions (
  token_hash text PRIMARY KEY,
  admin_id   uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Seed de planos (preços em centavos)
-- ---------------------------------------------------------------------------
INSERT INTO plans (code, name, price_cents, max_users, max_leads) VALUES
  ('starter', 'Starter', 14900, 3, 1000),
  ('pro',     'Pro',     39900, 10, NULL),
  ('business','Business',89900, 30, NULL);
