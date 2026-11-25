-- 012_marketing.sql — painel de Marketing (investimento por fonte, campanhas e metas)
-- Não altera dados existentes.

-- Campanha do lead (ex.: "Black Friday", "Remarketing"), para detalhar cada fonte
ALTER TABLE leads ADD COLUMN campaign text CHECK (campaign IS NULL OR length(campaign) BETWEEN 1 AND 120);
CREATE INDEX leads_tenant_channel_created_idx ON leads (tenant_id, channel, created_at);

-- Investimento (custo) lançado por fonte, opcionalmente por campanha
CREATE TABLE marketing_spend (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  source       text NOT NULL CHECK (length(source) BETWEEN 1 AND 40),
  campaign     text CHECK (campaign IS NULL OR length(campaign) BETWEEN 1 AND 120),
  spent_on     date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  notes        text CHECK (notes IS NULL OR length(notes) <= 500),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX marketing_spend_tenant_date_idx ON marketing_spend (tenant_id, spent_on);

-- Metas mensais por indicador (ex.: custo máximo, leads, CAC)
CREATE TABLE metric_goals (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  metric     text NOT NULL CHECK (metric IN ('cost','leads','deals','gains','cpl','cpd','cac','roi')),
  month      date NOT NULL CHECK (extract(day FROM month) = 1),
  target     numeric(16,4) NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, month)
);

-- Isolamento por empresa (mesmo padrão das demais tabelas)
ALTER TABLE marketing_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_goals    ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON marketing_spend TO g360_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON metric_goals TO g360_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, DELETE ON marketing_spend TO g360_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON metric_goals TO g360_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_spend, metric_goals TO g360_platform;
