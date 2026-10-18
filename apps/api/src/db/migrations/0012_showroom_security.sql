-- Phase 7 security: tenant RLS on showroom and integration tables, append-only message log and
-- inquiries, and integration secrets that the application role can write but never read back in
-- clear (they are encrypted by the application before they reach the database).

SELECT app_enable_tenant_rls(t) FROM unnest(ARRAY[
  'vehicle_listings', 'integration_settings', 'message_log', 'showroom_inquiries'
]::regclass[]) AS t;

GRANT SELECT, INSERT, UPDATE, DELETE ON vehicle_listings, integration_settings, message_log, showroom_inquiries TO autohub_app;

-- Every earlier security migration re-ran `GRANT ... ON ALL TABLES`, which silently gave back the
-- UPDATE/DELETE rights that the migrations before it had revoked (e.g. DELETE on customers,
-- receipts, acquisitions and sales; INSERT/UPDATE on subscription_plans). All restrictions now live
-- in this one idempotent function. Migrations grant only on their own new tables and end with
-- `SELECT app_apply_privileges();` (extend the function when adding a restriction).
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
END $$;
REVOKE ALL ON FUNCTION app_apply_privileges() FROM PUBLIC;
SELECT app_apply_privileges();

-- The outbound message log and public inquiries are evidence: append-only.
CREATE TRIGGER message_log_immutable BEFORE UPDATE OR DELETE ON message_log
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER showroom_inquiries_immutable BEFORE UPDATE OR DELETE ON showroom_inquiries
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();
