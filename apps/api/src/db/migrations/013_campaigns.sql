-- 013_campaigns.sql — Campanhas de E-mail, WhatsApp e SMS
-- Cada empresa cliente conecta as PRÓPRIAS contas (Resend, WhatsApp Cloud API da Meta,
-- Zenvia). As credenciais ficam cifradas (AES-256-GCM, chave CHANNEL_SECRETS_KEY fora
-- do banco) e nunca voltam para o navegador.
-- Não altera dados existentes.

-- Canais conectados por empresa (um registro por canal)
CREATE TABLE tenant_channels (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  channel        text NOT NULL CHECK (channel IN ('email','whatsapp','sms')),
  provider       text NOT NULL CHECK (provider IN ('resend','meta','zenvia')),
  -- dados não secretos (remetente, ids de conta) — podem ir para a tela
  settings       jsonb NOT NULL DEFAULT '{}',
  -- segredo cifrado (token/chave de API); só o servidor decifra
  secret_enc     text NOT NULL,
  secret_hint    text,               -- últimos 4 caracteres, para a tela mostrar "••••1a2b"
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel),
  CHECK ((channel = 'email' AND provider = 'resend') OR (channel = 'whatsapp' AND provider = 'meta') OR (channel = 'sms' AND provider = 'zenvia'))
);

-- Descadastro (LGPD): por endereço, para valer mesmo se o contato for cadastrado de novo
CREATE TABLE contact_opt_outs (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  channel    text NOT NULL CHECK (channel IN ('email','whatsapp','sms')),
  address    text NOT NULL CHECK (length(address) BETWEEN 3 AND 254),  -- e-mail em minúsculas ou telefone E.164 só dígitos
  source     text NOT NULL CHECK (source IN ('link','manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, address)
);

CREATE TABLE campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  channel     text NOT NULL CHECK (channel IN ('email','whatsapp','sms')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','canceled')),
  audience    jsonb NOT NULL DEFAULT '{}',   -- filtros (etapas, fontes, status, MQL)
  content     jsonb NOT NULL DEFAULT '{}',   -- assunto/texto/template conforme o canal
  scheduled_at timestamptz,
  started_at  timestamptz,
  finished_at timestamptz,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX campaigns_tenant_created_idx ON campaigns (tenant_id, created_at DESC);

-- Destinatários "congelados" no momento do envio. UNIQUE(campaign, lead) garante que
-- ninguém recebe a mesma campanha duas vezes, mesmo com cliques ou workers simultâneos.
CREATE TABLE campaign_recipients (
  id                  bigserial PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  campaign_id         uuid NOT NULL,
  lead_id             uuid NOT NULL,
  address             text NOT NULL,
  vars                jsonb NOT NULL DEFAULT '{}',   -- nome/empresa no momento do envio
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')),
  provider_message_id text,
  error               text,
  attempts            integer NOT NULL DEFAULT 0,
  claimed_at          timestamptz,   -- quando o worker pegou para enviar (detecta envio interrompido)
  sent_at             timestamptz,
  UNIQUE (campaign_id, lead_id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX campaign_recipients_pending_idx ON campaign_recipients (campaign_id) WHERE status IN ('pending','sending');

-- Isolamento por empresa
ALTER TABLE tenant_channels     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_opt_outs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns           ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_channels TO g360_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON contact_opt_outs TO g360_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON campaigns TO g360_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON campaign_recipients TO g360_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- API dos clientes: monta campanhas e lê resultados. Quem ENVIA é o worker (papel da plataforma).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_channels TO g360_app;
GRANT SELECT, INSERT, DELETE ON contact_opt_outs TO g360_app;
GRANT SELECT, INSERT, DELETE ON campaigns TO g360_app;
GRANT UPDATE (name, audience, content, scheduled_at, status, finished_at, updated_at) ON campaigns TO g360_app;
GRANT SELECT, INSERT ON campaign_recipients TO g360_app;
-- Só para o cancelamento marcar os pendentes como "não enviados" na hora
GRANT UPDATE (status, error) ON campaign_recipients TO g360_app;
GRANT USAGE ON SEQUENCE campaign_recipients_id_seq TO g360_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_channels, contact_opt_outs, campaigns, campaign_recipients TO g360_platform;
GRANT USAGE ON SEQUENCE campaign_recipients_id_seq TO g360_platform;

-- Descadastro pelo link do e-mail (pessoa SEM login). O link é assinado pela API
-- (HMAC); esta função só grava o descadastro, nada mais.
CREATE FUNCTION record_opt_out(p_tenant uuid, p_channel text, p_address text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO contact_opt_outs (tenant_id, channel, address, source)
  VALUES (p_tenant, p_channel, lower(p_address), 'link')
  ON CONFLICT DO NOTHING
$$;
REVOKE ALL ON FUNCTION record_opt_out(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_opt_out(uuid, text, text) TO g360_app;
