-- 006_auth_throttle.sql — SEC-10: rate limit de autenticação no Postgres
-- Antes: @fastify/rate-limit em memória (por instância; zera a cada deploy; N réplicas = N× o limite).
-- Agora: contador por chave numa tabela, incrementado de forma ATÔMICA (UPSERT numa
-- instrução), válido para qualquer número de réplicas. A chave (que contém IP ou
-- e-mail) é guardada só como hash SHA-256 — nada de dado pessoal em claro.

CREATE TABLE auth_throttle (
  key_hash     text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL
);
-- RLS ligado e sem policy: a API não lê nem grava a tabela diretamente
ALTER TABLE auth_throttle ENABLE ROW LEVEL SECURITY;

-- Registra uma tentativa e devolve quantas houve na janela corrente (janela fixa a partir da 1ª)
CREATE FUNCTION auth_throttle_hit(p_key_hash text, p_window_seconds integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hits integer;
BEGIN
  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'chave inválida' USING ERRCODE = '22023';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'janela inválida' USING ERRCODE = '22023';
  END IF;
  INSERT INTO auth_throttle AS t (key_hash, window_start, hits)
  VALUES (p_key_hash, now(), 1)
  ON CONFLICT (key_hash) DO UPDATE SET
    hits         = CASE WHEN t.window_start <= now() - make_interval(secs => p_window_seconds) THEN 1 ELSE t.hits + 1 END,
    window_start = CASE WHEN t.window_start <= now() - make_interval(secs => p_window_seconds) THEN now() ELSE t.window_start END
  RETURNING hits INTO v_hits;
  RETURN v_hits;
END $$;

REVOKE ALL ON FUNCTION auth_throttle_hit(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_throttle_hit(text, integer) TO g360_app, g360_platform;
-- Limpeza periódica pelo worker
GRANT SELECT, DELETE ON auth_throttle TO g360_platform;
