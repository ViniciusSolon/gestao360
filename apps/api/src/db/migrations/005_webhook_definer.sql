-- 005_webhook_definer.sql — revisada e aprovada em 23/11/2026.
-- Achado SEC-02: a API pública dos clientes recebia DATABASE_PLATFORM_URL (papel
-- g360_platform, BYPASSRLS) só porque o webhook de pagamento grava em
-- webhook_events/jobs, tabelas que g360_app não pode tocar.
--
-- Correção: uma função SECURITY DEFINER que faz SOMENTE essas duas gravações.
-- A API passa a chamá-la com o papel g360_app (sem BYPASSRLS) e o processo público
-- deixa de precisar da credencial da plataforma.
--
-- O que a função NÃO permite (mesmo se a API for comprometida):
--   * ler qualquer tabela;
--   * alterar tenant, plano, status ou assinatura — ela só enfileira um job de
--     sincronização, e o worker busca o estado REAL no gateway (o payload não é confiado);
--   * enfileirar outro tipo de job (o tipo é fixo no SQL).
-- O pior caso de abuso é enfileirar sincronizações de IDs de assinatura
-- inexistentes, que falham no worker sem efeito.
--
-- Comportamento idêntico ao atual (webhooks.ts:40-52):
--   1) grava o ID do evento primeiro (PK provider+event_id);
--   2) se já existia → retorna false (a rota responde 200 duplicate);
--   3) se novo e tem assinatura → enfileira billing.sync_subscription com o MESMO
--      dedupe_key de hoje ('webhook:<provider>:<event_id>');
--   4) tudo na mesma transação.
-- A migration NÃO altera dados existentes; só cria a função e o GRANT.

CREATE FUNCTION record_billing_webhook(
  p_provider        text,
  p_event_id        text,
  p_type            text,
  p_subscription_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'provider inválido' USING ERRCODE = '22023';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'event_id inválido' USING ERRCODE = '22023';
  END IF;
  IF p_type IS NULL OR length(p_type) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'type inválido' USING ERRCODE = '22023';
  END IF;
  IF p_subscription_id IS NOT NULL AND length(p_subscription_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'subscription_id inválido' USING ERRCODE = '22023';
  END IF;

  INSERT INTO webhook_events (provider, event_id, type)
  VALUES (p_provider, p_event_id, p_type)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    RETURN false; -- evento repetido: nenhum efeito
  END IF;

  IF p_subscription_id IS NOT NULL THEN
    INSERT INTO jobs (type, payload, dedupe_key)
    VALUES ('billing.sync_subscription',
            jsonb_build_object('subscriptionId', p_subscription_id),
            'webhook:' || p_provider || ':' || p_event_id)
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION record_billing_webhook(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_billing_webhook(text, text, text, text) TO g360_app;
