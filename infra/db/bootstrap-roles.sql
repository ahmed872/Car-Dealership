-- Run ONCE as a PostgreSQL superuser (or your cloud provider's admin role) before migrations.
-- Usage: psql -v owner_password='…' -v app_password='…' -v db_name=autohub -f infra/db/bootstrap-roles.sql
--
-- autohub_owner : owns the schema, runs migrations. Never used by the running API.
-- autohub_app   : used by the API. NOT superuser, NOT BYPASSRLS, owns nothing → RLS always applies.
\set ON_ERROR_STOP on
SELECT format('CREATE ROLE autohub_owner LOGIN PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autohub_owner') \gexec
SELECT format('CREATE ROLE autohub_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autohub_app') \gexec
SELECT format('CREATE DATABASE %I OWNER autohub_owner ENCODING ''UTF8'' TEMPLATE template0', :'db_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO autohub_app', :'db_name') \gexec
