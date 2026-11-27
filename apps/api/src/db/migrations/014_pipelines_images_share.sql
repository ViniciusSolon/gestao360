-- 014_pipelines_images_share.sql
-- 1) Vários funis por empresa (cada etapa pertence a um funil)
-- 2) Foto do produto enviada pelo usuário (guardada no próprio Postgres)
-- 3) Link da proposta para o cliente (para enviar por WhatsApp/e-mail)
--
-- Dados existentes: cria UM funil "Funil comercial" para cada empresa que já tem
-- etapas e liga todas as etapas atuais a ele. Nenhuma etapa, lead ou proposta é
-- apagada ou alterada além disso.

-- ---------------------------------------------------------------------------
-- 1) Funis
-- ---------------------------------------------------------------------------
CREATE TABLE pipelines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position   integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX pipelines_tenant_idx ON pipelines (tenant_id, position);

ALTER TABLE pipeline_stages ADD COLUMN pipeline_id uuid;

-- Um funil por empresa que já tem etapas; todas as etapas atuais vão para ele
INSERT INTO pipelines (tenant_id, name, position)
SELECT DISTINCT tenant_id, 'Funil comercial', 0 FROM pipeline_stages;
UPDATE pipeline_stages s SET pipeline_id = p.id FROM pipelines p WHERE p.tenant_id = s.tenant_id;

ALTER TABLE pipeline_stages ALTER COLUMN pipeline_id SET NOT NULL;
-- Excluir um funil leva junto as etapas dele; se alguma etapa tiver lead,
-- a FK leads → etapa impede (nenhum lead é apagado).
ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_pipeline_fk FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines (tenant_id, id) ON DELETE CASCADE;
CREATE INDEX pipeline_stages_pipeline_idx ON pipeline_stages (pipeline_id, position);

ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pipelines TO g360_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON pipelines TO g360_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pipelines TO g360_platform;

-- ---------------------------------------------------------------------------
-- 2) Foto do produto (upload). Só JPEG/PNG/WebP, até 2 MB (o servidor confere
--    o conteúdo real do arquivo; SVG não é aceito porque pode conter script).
-- ---------------------------------------------------------------------------
CREATE TABLE product_images (
  tenant_id  uuid NOT NULL,
  product_id uuid NOT NULL,
  mime       text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  content    bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 2097152),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_images TO g360_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON product_images TO g360_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_images TO g360_platform;

-- ---------------------------------------------------------------------------
-- 3) Link da proposta para o cliente final (sem login).
--    Token aleatório de 256 bits; vence em 30 dias. O mesmo link é reaproveitado
--    enquanto vale (enviar por WhatsApp e depois por e-mail não quebra o primeiro).
-- ---------------------------------------------------------------------------
ALTER TABLE proposals
  ADD COLUMN share_token text UNIQUE CHECK (share_token IS NULL OR share_token ~ '^[A-Za-z0-9_-]{43}$'),
  ADD COLUMN share_expires_at timestamptz;
GRANT UPDATE (share_token, share_expires_at) ON proposals TO g360_app;

-- Leitura pública pelo link: devolve SÓ o necessário para montar o PDF daquela
-- proposta (nada de outras propostas, leads ou empresas).
CREATE FUNCTION proposal_by_share_token(p_token text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'tenantName', t.name,
    'proposal', to_jsonb(p) - 'share_token',
    'lead', jsonb_build_object('name', l.name, 'company', l.company, 'cnpj', l.cnpj),
    'items', coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.position) FROM proposal_items i WHERE i.proposal_id = p.id), '[]'::jsonb)
  )
    FROM proposals p
    JOIN tenants t ON t.id = p.tenant_id
    JOIN leads l ON l.tenant_id = p.tenant_id AND l.id = p.lead_id
   WHERE p.share_token = p_token
     AND p.share_expires_at > now()
     AND p.status IN ('sent', 'accepted')
     AND t.status IN ('active', 'past_due', 'trialing')
$$;
REVOKE ALL ON FUNCTION proposal_by_share_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_by_share_token(text) TO g360_app;
