-- 010_lead_cnpj.sql — CNPJ no lead
-- Guardado sem máscara e em maiúsculas: 14 posições, as 12 primeiras 0–9/A–Z
-- (CNPJ alfanumérico, emitido desde julho/2026) e os 2 dígitos verificadores
-- numéricos. A validação completa dos dígitos fica na API (lib/cnpj.ts); o CHECK
-- garante o formato mesmo se algo gravar direto no banco.
-- NÃO é único: uma empresa pode ter mais de uma oportunidade no funil.
-- Não altera dados existentes (a coluna nasce vazia).

ALTER TABLE leads
  ADD COLUMN cnpj text CHECK (cnpj IS NULL OR cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$');

-- Busca por CNPJ dentro da empresa
CREATE INDEX leads_tenant_cnpj_idx ON leads (tenant_id, cnpj) WHERE cnpj IS NOT NULL;
