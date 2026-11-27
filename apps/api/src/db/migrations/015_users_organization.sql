-- 015_users_organization.sql — Organização → Usuários
-- Cadastro completo do usuário (dados pessoais e profissionais), perfis da empresa
-- (cargo ligado a um dos 4 níveis de acesso que já existem), departamentos, squads,
-- "reporta a" e foto.
--
-- Dados existentes:
--  * cria, para cada empresa, 3 perfis: "Administrador" (nível admin), "Gerente"
--    (nível manager) e "Vendedor" (nível seller);
--  * liga cada usuário atual (menos o proprietário) ao perfil do MESMO nível que ele
--    já tem. Nenhum nível de acesso muda; nada é apagado.

-- ---------------------------------------------------------------------------
-- Cadastros da empresa
-- ---------------------------------------------------------------------------
CREATE TABLE user_profiles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  -- Nível de acesso que o perfil dá. "owner" nunca: proprietário é um só, por conta.
  role       text NOT NULL CHECK (role IN ('admin','manager','seller')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX user_profiles_name_uq ON user_profiles (tenant_id, lower(name));

CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX departments_name_uq ON departments (tenant_id, lower(name));

CREATE TABLE squads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX squads_name_uq ON squads (tenant_id, lower(name));

-- ---------------------------------------------------------------------------
-- Novos campos do usuário (todos opcionais)
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN nickname       text CHECK (nickname IS NULL OR length(nickname) BETWEEN 1 AND 60),
  ADD COLUMN mobile         text CHECK (mobile IS NULL OR mobile ~ '^[0-9]{10,13}$'),
  ADD COLUMN phone          text CHECK (phone IS NULL OR phone ~ '^[0-9]{10,13}$'),
  ADD COLUMN cpf            text CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$'),
  ADD COLUMN birth_date     date CHECK (birth_date IS NULL OR birth_date BETWEEN '1900-01-01' AND '2100-01-01'),
  ADD COLUMN linkedin_url   text CHECK (linkedin_url IS NULL OR (linkedin_url ~ '^https://' AND length(linkedin_url) <= 300)),
  ADD COLUMN meeting_url    text CHECK (meeting_url IS NULL OR (meeting_url ~ '^https://' AND length(meeting_url) <= 300)),
  ADD COLUMN color          text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
  -- Status "Terceiro": acesso igual ao ativo, só marca que é de fora da empresa.
  -- "Inativo" continua sendo active = false (bloqueia login), como já era.
  ADD COLUMN is_third_party boolean NOT NULL DEFAULT false,
  ADD COLUMN department_id  uuid,
  ADD COLUMN profile_id     uuid,
  ADD COLUMN admission_date date CHECK (admission_date IS NULL OR admission_date BETWEEN '1900-01-01' AND '2100-01-01'),
  ADD COLUMN reports_to     uuid CHECK (reports_to IS NULL OR reports_to <> id),
  ADD COLUMN bio            text CHECK (bio IS NULL OR length(bio) <= 1000),
  -- Apagar um departamento/perfil/gestor só esvazia o campo (não apaga o usuário)
  ADD CONSTRAINT users_department_fk FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id) ON DELETE SET NULL (department_id),
  ADD CONSTRAINT users_profile_fk    FOREIGN KEY (tenant_id, profile_id)    REFERENCES user_profiles (tenant_id, id) ON DELETE SET NULL (profile_id),
  ADD CONSTRAINT users_reports_to_fk FOREIGN KEY (tenant_id, reports_to)    REFERENCES users (tenant_id, id) ON DELETE SET NULL (reports_to);

CREATE TABLE user_squads (
  tenant_id uuid NOT NULL,
  user_id   uuid NOT NULL,
  squad_id  uuid NOT NULL,
  PRIMARY KEY (user_id, squad_id),
  FOREIGN KEY (tenant_id, user_id)  REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, squad_id) REFERENCES squads (tenant_id, id) ON DELETE CASCADE
);

-- Foto do usuário (mesmas regras da foto de produto)
CREATE TABLE user_avatars (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  mime       text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  content    bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 2097152),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- Convite carrega o cadastro feito pelo administrador; vira o usuário quando a
-- pessoa aceita e define a senha.
ALTER TABLE invites
  ADD COLUMN details    jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN profile_id uuid,
  ADD CONSTRAINT invites_profile_fk FOREIGN KEY (tenant_id, profile_id) REFERENCES user_profiles (tenant_id, id) ON DELETE SET NULL (profile_id);

-- ---------------------------------------------------------------------------
-- Isolamento e permissões
-- ---------------------------------------------------------------------------
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE squads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_squads   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_avatars  ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_profiles TO g360_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON departments   TO g360_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON squads        TO g360_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON user_squads   TO g360_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON user_avatars  TO g360_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles, departments, squads, user_squads, user_avatars TO g360_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles, departments, squads, user_squads, user_avatars TO g360_platform;
GRANT UPDATE (nickname, mobile, phone, cpf, birth_date, linkedin_url, meeting_url, color, is_third_party,
              department_id, profile_id, admission_date, reports_to, bio) ON users TO g360_app;
-- Mudar o nível de um perfil atualiza também os convites pendentes desse perfil
GRANT UPDATE (role) ON invites TO g360_app;

-- ---------------------------------------------------------------------------
-- Dados iniciais: 3 perfis por empresa e usuários atuais ligados ao do mesmo nível
-- ---------------------------------------------------------------------------
INSERT INTO user_profiles (tenant_id, name, role)
SELECT t.id, p.name, p.role
  FROM tenants t
 CROSS JOIN (VALUES ('Administrador', 'admin'), ('Gerente', 'manager'), ('Vendedor', 'seller')) AS p(name, role);

UPDATE users u SET profile_id = p.id
  FROM user_profiles p
 WHERE p.tenant_id = u.tenant_id AND p.role = u.role AND u.role <> 'owner';
