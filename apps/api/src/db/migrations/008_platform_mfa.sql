-- 008_platform_mfa.sql — SEC-09: MFA (TOTP) obrigatório no painel da plataforma
-- * Segredo TOTP cifrado (AES-256-GCM, chave PLATFORM_MFA_KEY fora do banco).
-- * totp_last_step impede reutilizar o mesmo código (replay).
-- * Códigos de recuperação de uso único, guardados só como hash.
-- * Login em duas etapas: a senha gera um "desafio" de 5 min / 5 tentativas; só o
--   código válido cria a sessão.
-- Nenhuma dessas tabelas tem GRANT para g360_app.
-- Dados existentes: admins já cadastrados ficam SEM MFA e, por isso, sem conseguir
-- logar até rodar `npm -w apps/api run platform:create-admin` de novo (que configura o TOTP).

ALTER TABLE platform_admins
  ADD COLUMN totp_secret_enc text,
  ADD COLUMN totp_last_step  bigint;

CREATE TABLE platform_recovery_codes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id  uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  used_at   timestamptz
);

CREATE TABLE platform_login_challenges (
  token_hash text PRIMARY KEY,
  admin_id   uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_recovery_codes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_login_challenges ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_recovery_codes, platform_login_challenges TO g360_platform;
