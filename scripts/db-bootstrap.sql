-- Cria os papéis e o banco. Rode como superusuário do Postgres:
--   psql "$SUPERUSER_URL" -v db=gestao360 -v owner_pw="..." -v app_pw="..." -v platform_pw="..." -f scripts/db-bootstrap.sql
-- As senhas NÃO têm valor padrão: devem vir do seu cofre de segredos.
SELECT format('CREATE ROLE g360_owner LOGIN PASSWORD %L', :'owner_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'g360_owner') \gexec
SELECT format('CREATE ROLE g360_app LOGIN NOBYPASSRLS PASSWORD %L', :'app_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'g360_app') \gexec
SELECT format('CREATE ROLE g360_platform LOGIN BYPASSRLS PASSWORD %L', :'platform_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'g360_platform') \gexec
SELECT format('CREATE DATABASE %I OWNER g360_owner', :'db')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
