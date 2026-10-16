-- Foundation security: tenant context, RLS, grants, audit hash chain, ledger integrity,
-- gapless numbering, and narrow cross-tenant helper functions.
-- Requires roles from infra/db/bootstrap-roles.sql (autohub_app must exist).

-- ── Tenant/user context (transaction-local settings set by the API) ──────────────────────
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Standard tenant policy. When app.tenant_id is unset, app_current_tenant() is NULL and
-- "tenant_id = NULL" is never true → default deny.
CREATE OR REPLACE FUNCTION app_enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
    tbl);
END $$;

SELECT app_enable_tenant_rls(t) FROM unnest(ARRAY[
  'branches', 'roles', 'membership_branches', 'audit_logs', 'audit_chain_heads', 'number_sequences',
  'idempotency_keys', 'files', 'tenant_subscriptions', 'ledger_accounts', 'journal_entries', 'journal_lines'
]::regclass[]) AS t;

-- memberships: tenant-scoped, plus a user may read their own memberships (needed at login).
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY own_membership_read ON memberships FOR SELECT
  USING (user_id = app_current_user());

-- tenants: the active tenant row, plus read access to tenants the user belongs to.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
CREATE POLICY tenant_member_read ON tenants FOR SELECT
  USING (id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app_current_user() AND m.status = 'active'));

-- ── Grants ────────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO autohub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autohub_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO autohub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autohub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO autohub_app;

-- Append-only tables: the application may only read and insert.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, journal_entries, journal_lines FROM autohub_app;
-- Chain heads are maintained exclusively by the SECURITY DEFINER audit trigger.
REVOKE ALL ON audit_chain_heads FROM autohub_app;

-- ── Immutability (applies to the owner too, except via superuser trigger disabling) ─────
CREATE OR REPLACE FUNCTION app_reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record: % on % is not allowed', TG_OP, TG_TABLE_NAME USING ERRCODE = 'AH001';
END $$;

CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_modification();

-- ── Audit hash chain ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_hash_input(r audit_logs) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT concat_ws('|',
    r.prev_hash, r.seq::text, r.tenant_id::text, coalesce(r.actor_user_id::text, ''), r.action, r.entity_type,
    coalesce(r.entity_id, ''), coalesce(r.summary, ''), coalesce(r.before::text, ''), coalesce(r.after::text, ''),
    coalesce(r.metadata::text, ''), to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))
$$;

CREATE OR REPLACE FUNCTION audit_logs_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_seq bigint;
  v_hash text;
BEGIN
  INSERT INTO audit_chain_heads (tenant_id, last_seq, last_hash)
  VALUES (NEW.tenant_id, 0, repeat('0', 64))
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT last_seq, last_hash INTO v_seq, v_hash
  FROM audit_chain_heads WHERE tenant_id = NEW.tenant_id FOR UPDATE;

  NEW.seq := v_seq + 1;
  NEW.prev_hash := v_hash;
  NEW.created_at := date_trunc('microseconds', clock_timestamp());
  NEW.hash := encode(sha256(convert_to(audit_hash_input(NEW), 'UTF8')), 'hex');

  UPDATE audit_chain_heads SET last_seq = NEW.seq, last_hash = NEW.hash WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_before_insert();

-- Verifies the current tenant's chain: contiguous sequence, prev-hash linkage, row hashes,
-- and agreement with the chain head (detects removed tail rows).
CREATE OR REPLACE FUNCTION audit_verify_chain()
RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_tenant uuid := app_current_tenant();
  v_prev text := repeat('0', 64);
  v_expected bigint := 1;
  v_n bigint := 0;
  v_head_seq bigint;
  v_head_hash text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;
  FOR r IN
    SELECT a.seq, a.prev_hash, a.hash, audit_hash_input(a) AS hin
    FROM audit_logs a WHERE a.tenant_id = v_tenant ORDER BY a.seq
  LOOP
    v_n := v_n + 1;
    IF r.seq <> v_expected THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'sequence_gap'::text; RETURN;
    END IF;
    IF r.prev_hash <> v_prev THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'prev_hash_mismatch'::text; RETURN;
    END IF;
    IF r.hash <> encode(sha256(convert_to(r.hin, 'UTF8')), 'hex') THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'hash_mismatch'::text; RETURN;
    END IF;
    v_prev := r.hash;
    v_expected := v_expected + 1;
  END LOOP;

  SELECT last_seq, last_hash INTO v_head_seq, v_head_hash FROM audit_chain_heads WHERE tenant_id = v_tenant;
  IF coalesce(v_head_seq, 0) <> v_n OR coalesce(v_head_hash, repeat('0', 64)) <> v_prev THEN
    RETURN QUERY SELECT false, v_n, coalesce(v_head_seq, 0), 'head_mismatch'::text; RETURN;
  END IF;
  RETURN QUERY SELECT true, v_n, NULL::bigint, NULL::text;
END $$;

-- ── Ledger integrity: every journal entry must balance and have >= 2 lines at COMMIT ───────
CREATE OR REPLACE FUNCTION journal_check_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entry uuid;
  v_debit numeric;
  v_credit numeric;
  v_count int;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN v_entry := NEW.id; ELSE v_entry := NEW.entry_id; END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO v_debit, v_credit, v_count
  FROM journal_lines WHERE entry_id = v_entry;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'unbalanced_journal: entry % has % line(s)', v_entry, v_count USING ERRCODE = 'AH002';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'unbalanced_journal: entry % debit % <> credit %', v_entry, v_debit, v_credit USING ERRCODE = 'AH002';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
             WHERE l.entry_id = v_entry AND l.tenant_id <> e.tenant_id) THEN
    RAISE EXCEPTION 'journal tenant mismatch for entry %', v_entry USING ERRCODE = 'AH002';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();

-- ── Gapless per-tenant numbering (row lock on the counter; rollback returns the number) ───
CREATE OR REPLACE FUNCTION app_next_number(p_key text) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  INSERT INTO number_sequences AS s (tenant_id, key, next_value)
  VALUES (app_current_tenant(), p_key, 2)
  ON CONFLICT (tenant_id, key) DO UPDATE SET next_value = s.next_value + 1
  RETURNING s.next_value - 1
$$;

-- ── Narrow cross-tenant helpers (return identifiers only) ───────────────────────────────
CREATE OR REPLACE FUNCTION app_active_tenants()
RETURNS TABLE (id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, coalesce(t.settings->>'timezone', 'UTC') FROM tenants t WHERE t.status = 'active'
$$;

CREATE OR REPLACE FUNCTION app_tenant_id_by_slug(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id FROM tenants t WHERE t.slug = lower(p_slug) AND t.status = 'active'
$$;

CREATE OR REPLACE FUNCTION app_showroom_tenant_id(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id FROM tenants t
  WHERE t.slug = lower(p_slug) AND t.status = 'active'
    AND coalesce((t.settings->'showroom'->>'enabled')::boolean, false)
$$;

CREATE OR REPLACE FUNCTION app_slug_taken(p_slug text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenants WHERE slug = lower(p_slug))
$$;

-- Number of companies a user belongs to (used to block cross-tenant credential changes).
CREATE OR REPLACE FUNCTION app_user_membership_count(p_user uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int FROM memberships WHERE user_id = p_user
$$;

-- Platform administration summary (the API restricts the caller to platform admins).
CREATE OR REPLACE FUNCTION app_platform_tenants()
RETURNS TABLE (id uuid, name text, slug text, market text, base_currency text, status text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, t.slug, t.market, t.base_currency, t.status, t.created_at FROM tenants t ORDER BY t.created_at
$$;

REVOKE ALL ON FUNCTION app_active_tenants(), app_tenant_id_by_slug(text), app_showroom_tenant_id(text),
  app_slug_taken(text), app_platform_tenants(), audit_verify_chain(), app_user_membership_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_active_tenants(), app_tenant_id_by_slug(text), app_showroom_tenant_id(text),
  app_slug_taken(text), app_platform_tenants(), audit_verify_chain(), app_user_membership_count(uuid) TO autohub_app;

-- Platform subscription plans (global catalog, not tenant data).
INSERT INTO subscription_plans (code, name_en, name_ar, max_users, max_branches, max_vehicles, features)
VALUES
  ('starter', 'Starter', 'الأساسية', 5, 1, 150, ARRAY['inventory', 'crm', 'sales']),
  ('professional', 'Professional', 'الاحترافية', 25, 5, 1000, ARRAY['inventory', 'crm', 'sales', 'installments', 'showroom', 'reports']),
  ('enterprise', 'Enterprise', 'المؤسسات', NULL, NULL, NULL, ARRAY['inventory', 'crm', 'sales', 'installments', 'showroom', 'reports', 'integrations'])
ON CONFLICT (code) DO NOTHING;
REVOKE INSERT, UPDATE, DELETE ON subscription_plans FROM autohub_app;
