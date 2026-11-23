-- PROPOSTA — NÃO APLICADA. Aguarda revisão.
-- Achado RC-01: POST /api/stages calcula max(position)+1 e grava (ler-decidir-gravar).
-- Duas criações simultâneas recebem a mesma posição (reproduzido: posições 7,7,8,8,8).
--
-- Correção (preferência a): constraint única por (tenant, posição), DEFERRABLE para que
-- a reordenação via PATCH possa trocar posições dentro de uma transação.
-- Junto, no código (preferência c): travar a linha do tenant antes de calcular max()
--   SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE;
-- assim a 2ª criação espera a 1ª e calcula a posição seguinte (sem erro para o usuário).
--
-- ATENÇÃO: o banco de DEV já tem duplicados (tenant 1a67ac27-…, posições 7 e 8).
-- A constraint falha enquanto eles existirem. Limpeza proposta (NÃO executada),
-- renumera sem apagar nada, preservando a ordem atual (position, created_at):
--
--   WITH r AS (
--     SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY position, created_at) - 1 AS pos
--     FROM pipeline_stages)
--   UPDATE pipeline_stages s SET position = r.pos FROM r WHERE r.id = s.id AND s.position <> r.pos;
--
-- Conferir antes:
--   SELECT tenant_id, position, count(*) FROM pipeline_stages GROUP BY 1,2 HAVING count(*) > 1;

ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_position_uq UNIQUE (tenant_id, position) DEFERRABLE INITIALLY IMMEDIATE;
