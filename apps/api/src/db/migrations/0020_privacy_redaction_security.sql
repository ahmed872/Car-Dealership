-- KI-021 / D-053: erasure of personal data in the append-only showroom inquiries and message log.
--
-- The rows stay (they are evidence that an inquiry or message existed, and when); only their personal
-- fields can be overwritten, and only by app_redact_contact(), a SECURITY DEFINER function owned by the
-- migration (owner) role. The immutability triggers now run app_contact_redaction_guard(), which still
-- refuses every DELETE and every UPDATE except exactly this transition:
--   * the statement runs with the rights of app_redact_contact's owner (current_user inside a SECURITY
--     DEFINER function) — the application role can never be that role: it is not a member of it, and
--     it holds no UPDATE/DELETE/TRIGGER privilege on these tables (app_apply_privileges);
--   * the transaction-local flag app.redaction_in_progress is 'on' (set only inside the function; any
--     role can set a custom setting, so the flag is NOT the security boundary — it keeps the owner's own
--     ad-hoc UPDATEs refused too);
--   * the row was not redacted yet and becomes redacted (redacted_at set);
--   * no column other than the listed personal ones and redacted_at/redacted_by changes, and every
--     personal column ends up NULL or the fixed marker '[redacted]'.
-- Every call writes one audit entry (privacy.redacted) itself, with counts, ids and the reason but no
-- personal values, so no caller can redact without a trace.

CREATE OR REPLACE FUNCTION app_contact_redaction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_personal text[] := TG_ARGV;
  v_new jsonb;
  v_old jsonb;
  v_col text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.redaction_in_progress', true) = 'on'
     AND current_user = (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                          WHERE p.oid = 'public.app_redact_contact(text, uuid[], text, jsonb)'::regprocedure)
     AND OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL THEN
    v_new := to_jsonb(NEW);
    v_old := to_jsonb(OLD);
    IF (v_new - v_personal - 'redacted_at' - 'redacted_by') = (v_old - v_personal - 'redacted_at' - 'redacted_by') THEN
      FOREACH v_col IN ARRAY v_personal LOOP
        IF v_new ->> v_col IS NOT NULL AND v_new ->> v_col <> '[redacted]' THEN
          RAISE EXCEPTION 'immutable_record: % may only be redacted on %', v_col, TG_TABLE_NAME USING ERRCODE = 'AH001';
        END IF;
      END LOOP;
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'immutable_record: % on % is not allowed', TG_OP, TG_TABLE_NAME USING ERRCODE = 'AH001';
END $$;
REVOKE ALL ON FUNCTION app_contact_redaction_guard() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_redact_contact(p_kind text, p_ids uuid[], p_reason text, p_context jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (inquiries integer, messages integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_marker CONSTANT text := '[redacted]';
  v_tenant uuid := app_current_tenant();
  v_user uuid := app_current_user();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_inq uuid[] := '{}';
  v_msg uuid[] := '{}';
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('showroom_inquiry', 'message_log') THEN
    RAISE EXCEPTION 'redaction kind must be showroom_inquiry or message_log' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'a redaction reason of 3 to 500 characters is required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(cardinality(p_ids), 0) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'between 1 and 5000 ids can be redacted at once' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.redaction_in_progress', 'on', true);
  IF p_kind = 'showroom_inquiry' THEN
    WITH u AS (
      UPDATE public.showroom_inquiries i
         SET name = c_marker, phone = c_marker, phone_normalized = NULL, email = NULL, message = NULL,
             client_hash = NULL, redacted_at = now(), redacted_by = v_user
       WHERE i.tenant_id = v_tenant AND i.id = ANY (p_ids) AND i.redacted_at IS NULL
      RETURNING i.id)
    SELECT coalesce(array_agg(u.id ORDER BY u.id), '{}'::uuid[]) INTO v_inq FROM u;
    -- Messages sent about these inquiries (the acknowledgement to the visitor's phone).
    WITH u AS (
      UPDATE public.message_log m
         SET recipient = c_marker, body = c_marker, error = CASE WHEN m.error IS NULL THEN NULL ELSE c_marker END,
             redacted_at = now(), redacted_by = v_user
       WHERE m.tenant_id = v_tenant AND m.related_type = 'showroom_inquiry' AND m.related_id = ANY (p_ids)
         AND m.redacted_at IS NULL
      RETURNING m.id)
    SELECT coalesce(array_agg(u.id ORDER BY u.id), '{}'::uuid[]) INTO v_msg FROM u;
  ELSE
    WITH u AS (
      UPDATE public.message_log m
         SET recipient = c_marker, body = c_marker, error = CASE WHEN m.error IS NULL THEN NULL ELSE c_marker END,
             redacted_at = now(), redacted_by = v_user
       WHERE m.tenant_id = v_tenant AND m.id = ANY (p_ids) AND m.redacted_at IS NULL
      RETURNING m.id)
    SELECT coalesce(array_agg(u.id ORDER BY u.id), '{}'::uuid[]) INTO v_msg FROM u;
  END IF;
  PERFORM set_config('app.redaction_in_progress', '', true);

  INSERT INTO public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, summary, metadata)
  VALUES (v_tenant, v_user, 'privacy.redacted', p_kind, NULL,
          left(format('Personal data redacted (%s inquiries, %s messages): %s', cardinality(v_inq), cardinality(v_msg), v_reason), 500),
          jsonb_build_object(
            'reason', v_reason,
            'requested', cardinality(p_ids),
            'inquiries', cardinality(v_inq),
            'messages', cardinality(v_msg),
            'inquiryIds', to_jsonb(v_inq),
            'messageIds', to_jsonb(v_msg),
            'source', left(coalesce(p_context ->> 'source', 'sql'), 40),
            'requestId', left(p_context ->> 'requestId', 80),
            'ip', left(p_context ->> 'ip', 80)));

  RETURN QUERY SELECT cardinality(v_inq), cardinality(v_msg);
END $$;
REVOKE ALL ON FUNCTION app_redact_contact(text, uuid[], text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_redact_contact(text, uuid[], text, jsonb) TO autohub_app;
--> statement-breakpoint

DROP TRIGGER IF EXISTS showroom_inquiries_immutable ON showroom_inquiries;
CREATE TRIGGER showroom_inquiries_immutable BEFORE UPDATE OR DELETE ON showroom_inquiries
  FOR EACH ROW EXECUTE FUNCTION app_contact_redaction_guard('name', 'phone', 'phone_normalized', 'email', 'message', 'client_hash');
DROP TRIGGER IF EXISTS message_log_immutable ON message_log;
CREATE TRIGGER message_log_immutable BEFORE UPDATE OR DELETE ON message_log
  FOR EACH ROW EXECUTE FUNCTION app_contact_redaction_guard('recipient', 'body', 'error');
CREATE TRIGGER showroom_inquiries_no_truncate BEFORE TRUNCATE ON showroom_inquiries
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER message_log_no_truncate BEFORE TRUNCATE ON message_log
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_modification();
--> statement-breakpoint

-- The restrictions live in one idempotent function (0012); this adds the redaction function's
-- PUBLIC revoke so a later re-grant cannot widen it.
CREATE OR REPLACE FUNCTION app_apply_privileges() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Ledger and audit trail: append-only; chain heads are written only by the audit trigger.
  REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, journal_entries, journal_lines FROM autohub_app;
  REVOKE ALL ON audit_chain_heads FROM autohub_app;
  -- Plans are global (no RLS) and maintained by migrations only.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON subscription_plans FROM autohub_app;
  -- History, cash book and allocations: append-only.
  REVOKE UPDATE, DELETE, TRUNCATE ON vehicle_status_history, vehicle_price_history, odometer_readings,
    cash_transactions, supplier_payment_allocations, lead_stage_history, receipt_allocations,
    message_log, showroom_inquiries FROM autohub_app;
  REVOKE UPDATE ON installments, installment_allocations FROM autohub_app;
  -- Business documents are cancelled, voided or reversed, never deleted.
  REVOKE DELETE, TRUNCATE ON acquisitions, vehicle_costs, supplier_payments, expenses,
    reservations, receipts, refunds, customers, leads, commission_policies,
    sales, trade_ins, installment_plans, installments, installment_allocations, commissions,
    sale_documents, cash_day_closings, vehicle_listings, integration_settings FROM autohub_app;
  -- D-053: personal data in inquiries and the message log is changed only through the redaction
  -- function (the app role may execute it; nobody else by default). Triggers on the tables it writes
  -- would run with its owner's rights, so the app role must never hold TRIGGER on them.
  REVOKE TRIGGER ON showroom_inquiries, message_log, audit_logs FROM autohub_app;
  REVOKE ALL ON FUNCTION app_redact_contact(text, uuid[], text, jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION app_contact_redaction_guard() FROM PUBLIC;
END $$;
REVOKE ALL ON FUNCTION app_apply_privileges() FROM PUBLIC;
--> statement-breakpoint

-- privacy.manage (search and redact personal data, retention) goes to the owner role of existing
-- companies, like new companies get it (SYSTEM_ROLES: owner only). Safe to run again.
UPDATE roles
   SET permissions = array_append(permissions, 'privacy.manage'), updated_at = now()
 WHERE is_system AND key = 'owner' AND NOT ('privacy.manage' = ANY (permissions));
--> statement-breakpoint
SELECT app_apply_tenant_fks();
--> statement-breakpoint
SELECT app_apply_privileges();
