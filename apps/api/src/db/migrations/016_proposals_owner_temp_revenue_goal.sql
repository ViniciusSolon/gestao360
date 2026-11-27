-- 016_proposals_owner_temp_revenue_goal.sql
-- 1) Proposta ganha: responsável (vendedor), temperatura (quente/morno/frio) e
--    previsão de fechamento.
-- 2) Meta mensal de receita (gráfico Metas x Receita em Indicadores → Comercial),
--    guardada na mesma tabela de metas do Marketing.
--
-- Dados existentes: o responsável das propostas que já existem passa a ser quem
-- as criou (created_by). Nada é apagado; valores e status não mudam.

ALTER TABLE proposals
  ADD COLUMN owner_id            uuid,
  ADD COLUMN temperature         text CHECK (temperature IS NULL OR temperature IN ('hot','warm','cold')),
  ADD COLUMN expected_close_date date CHECK (expected_close_date IS NULL OR expected_close_date BETWEEN '2000-01-01' AND '2100-12-31'),
  ADD CONSTRAINT proposals_owner_fk FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id);

UPDATE proposals SET owner_id = created_by WHERE owner_id IS NULL;

CREATE INDEX proposals_tenant_owner_idx ON proposals (tenant_id, owner_id);
CREATE INDEX proposals_tenant_close_idx ON proposals (tenant_id, expected_close_date) WHERE status IN ('draft','sent');

GRANT UPDATE (owner_id, temperature, expected_close_date) ON proposals TO g360_app;

-- Meta de receita: novo indicador "revenue" (em centavos) na tabela de metas
ALTER TABLE metric_goals DROP CONSTRAINT metric_goals_metric_check;
ALTER TABLE metric_goals ADD CONSTRAINT metric_goals_metric_check
  CHECK (metric IN ('cost','leads','deals','gains','cpl','cpd','cac','roi','revenue'));
