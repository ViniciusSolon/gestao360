-- 007_plan_counters_definer.sql — SEC-03: contadores de limite do plano só mudam por função
-- Antes: g360_app tinha UPDATE nas colunas seats_used/leads_count (com uma SQLi, daria
-- para zerar os contadores e passar do limite do plano).
-- Agora: quatro funções SECURITY DEFINER que só incrementam/decrementam respeitando o
-- limite, sempre no tenant da transação corrente (app_current_tenant()) — não recebem
-- tenant por parâmetro, então não alcançam outra empresa. O GRANT de coluna é revogado.
-- A semântica é a mesma de lib/limits.ts (UPDATE atômico com o limite no WHERE).

CREATE FUNCTION consume_seat() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE tenants t SET seats_used = t.seats_used + 1
    FROM plans p
   WHERE t.id = app_current_tenant() AND p.id = t.plan_id AND t.seats_used < p.max_users;
  RETURN FOUND;
END $$;

CREATE FUNCTION release_seat() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE tenants SET seats_used = seats_used - 1 WHERE id = app_current_tenant() AND seats_used > 0;
  RETURN FOUND;
END $$;

CREATE FUNCTION consume_lead() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE tenants t SET leads_count = t.leads_count + 1
    FROM plans p
   WHERE t.id = app_current_tenant() AND p.id = t.plan_id
     AND (p.max_leads IS NULL OR t.leads_count < p.max_leads);
  RETURN FOUND;
END $$;

CREATE FUNCTION release_lead() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE tenants SET leads_count = leads_count - 1 WHERE id = app_current_tenant() AND leads_count > 0;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION consume_seat(), release_seat(), consume_lead(), release_lead() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_seat(), release_seat(), consume_lead(), release_lead() TO g360_app;

REVOKE UPDATE (seats_used, leads_count) ON tenants FROM g360_app;
