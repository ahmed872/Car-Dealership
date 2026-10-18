-- Phase 8 (KI-001): references between a company's records can never point at another company's
-- records, enforced by the database itself rather than only by RLS-filtered lookups in services.
-- (A foreign-key check bypasses RLS, so a single-column FK accepted another company's id.)
--
-- * Between two tenant tables (tenant_id NOT NULL on both): a composite FK (tenant_id, col) →
--   (tenant_id, id) next to the existing FK, which keeps its ON DELETE behaviour.
-- * To shared catalogs (makes, models, features, templates, cost categories, pipeline stages: global
--   rows have tenant_id NULL): a trigger that accepts a global row or one of the same company.
--
-- Both are applied by app_apply_tenant_fks(), which is idempotent and covers every FK in the
-- schema, so later migrations add the guards for their own tables by calling it at the end.

CREATE OR REPLACE FUNCTION app_check_shared_ref() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ref_id uuid;
  ref_tenant uuid;
BEGIN
  ref_id := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF ref_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT tenant_id FROM %I WHERE id = $1', TG_ARGV[1]) INTO ref_tenant USING ref_id;
  -- Existence is the FK's job; this checks ownership only.
  IF ref_tenant IS NOT NULL AND ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'cross_tenant_reference: %.% refers to another company''s %', TG_TABLE_NAME, TG_ARGV[0], TG_ARGV[1]
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_check_shared_ref() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_apply_tenant_fks() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  fk record;
  col text;
  cname text;
  tname text;
BEGIN
  FOR fk IN
    SELECT c.oid, c.conname, c.conrelid, c.confrelid, c.conkey, c.condeferrable, c.condeferred,
           src_t.attnotnull AS src_tenant_not_null, ref_t.attnotnull AS ref_tenant_not_null
      FROM pg_constraint c
      JOIN pg_attribute src_t ON src_t.attrelid = c.conrelid AND src_t.attname = 'tenant_id' AND NOT src_t.attisdropped
      JOIN pg_attribute ref_t ON ref_t.attrelid = c.confrelid AND ref_t.attname = 'tenant_id' AND NOT ref_t.attisdropped
     WHERE c.contype = 'f'
       AND c.connamespace = 'public'::regnamespace
       AND array_length(c.conkey, 1) = 1
       AND (SELECT attname FROM pg_attribute WHERE attrelid = c.confrelid AND attnum = c.confkey[1]) = 'id'
       AND c.conname NOT LIKE '%\_tfk' ESCAPE '\'
  LOOP
    SELECT attname INTO col FROM pg_attribute WHERE attrelid = fk.conrelid AND attnum = fk.conkey[1];
    CONTINUE WHEN col = 'tenant_id';
    IF fk.src_tenant_not_null AND fk.ref_tenant_not_null THEN
      cname := left(fk.conname, 59) || '_tfk';
      CONTINUE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = cname AND conrelid = fk.conrelid);
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s (tenant_id, id)',
                     left(replace(fk.confrelid::regclass::text, '"', ''), 50) || '_tenant_id_uq', fk.confrelid::regclass);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I) REFERENCES %s (tenant_id, id)%s',
                     fk.conrelid::regclass, cname, col, fk.confrelid::regclass,
                     CASE WHEN fk.condeferrable THEN ' DEFERRABLE' || CASE WHEN fk.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END ELSE '' END);
    ELSE
      -- A shared catalog (global rows have no tenant): ownership is checked by trigger.
      tname := left(replace(fk.conrelid::regclass::text, '"', '') || '_' || col, 50) || '_tenant_ref';
      CONTINUE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = tname AND tgrelid = fk.conrelid);
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %s FOR EACH ROW EXECUTE FUNCTION app_check_shared_ref(%L, %L)',
                     tname, col, fk.conrelid::regclass, col, replace(fk.confrelid::regclass::text, '"', ''));
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app_apply_tenant_fks() FROM PUBLIC;

SELECT app_apply_tenant_fks();
SELECT app_apply_privileges();
