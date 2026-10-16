-- Phase 4 security & data: tenant RLS, append-only histories and receipt allocations, no hard
-- deletes of customer money documents, test-drive double-booking guard, default pipeline stages.

SELECT app_enable_tenant_rls(t) FROM unnest(ARRAY[
  'customers', 'leads', 'lead_stage_history', 'customer_interactions', 'customer_wishes', 'wish_matches',
  'appointments', 'reservations', 'receipts', 'receipt_allocations', 'refunds', 'notifications',
  'employee_profiles', 'commission_policies'
]::regclass[]) AS t;

SELECT app_enable_catalog_rls('pipeline_stages'::regclass);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autohub_app;

-- Stage history and receipt allocations are append-only.
REVOKE UPDATE, DELETE, TRUNCATE ON lead_stage_history, receipt_allocations FROM autohub_app;
CREATE TRIGGER lead_stage_history_immutable BEFORE UPDATE OR DELETE ON lead_stage_history
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER receipt_allocations_immutable BEFORE UPDATE OR DELETE ON receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();

-- Customer money documents and reservations are never hard-deleted (void / cancel instead).
REVOKE DELETE ON reservations, receipts, refunds, customers, leads, commission_policies FROM autohub_app;

-- A receipt's amounts are frozen once written; only void metadata may change.
CREATE OR REPLACE FUNCTION receipt_amount_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.amount_base IS DISTINCT FROM OLD.amount_base
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.cash_account_id IS DISTINCT FROM OLD.cash_account_id
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'immutable_record: receipt amounts cannot change' USING ERRCODE = 'AH001';
  END IF;
  IF OLD.status = 'voided' AND NEW.status <> 'voided' THEN
    RAISE EXCEPTION 'immutable_record: a voided receipt cannot be reactivated' USING ERRCODE = 'AH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipts_amount_guard BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION receipt_amount_guard();

-- Refund amounts are frozen once approved or paid.
CREATE OR REPLACE FUNCTION refund_amount_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved', 'paid') AND NEW.amount_base IS DISTINCT FROM OLD.amount_base THEN
    RAISE EXCEPTION 'immutable_record: an approved refund amount cannot change' USING ERRCODE = 'AH001';
  END IF;
  IF OLD.status IN ('paid', 'rejected', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'immutable_record: a closed refund cannot change status' USING ERRCODE = 'AH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_amount_guard BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION refund_amount_guard();

-- One vehicle cannot be booked for two overlapping live test drives.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE appointments ADD CONSTRAINT appointments_test_drive_overlap
  EXCLUDE USING gist (vehicle_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (type = 'test_drive' AND vehicle_id IS NOT NULL AND status IN ('scheduled', 'confirmed', 'in_progress'));

-- Reservations / leads link to sales later (FK added in Phase 5 when the sales table exists).

-- Default sales pipeline (tenant_id NULL = platform defaults; tenants may add their own).
INSERT INTO pipeline_stages (code, name_en, name_ar, sort_order, kind, probability_pct) VALUES
  ('new', 'New', 'جديد', 10, 'open', 10),
  ('contacted', 'Contacted', 'تم التواصل', 20, 'open', 20),
  ('qualified', 'Qualified', 'مؤهل', 30, 'open', 35),
  ('test_drive', 'Test drive', 'تجربة قيادة', 40, 'open', 50),
  ('negotiation', 'Negotiation', 'تفاوض', 50, 'open', 65),
  ('reserved', 'Reserved / deposit', 'محجوز / عربون', 60, 'open', 80),
  ('won', 'Won', 'تم البيع', 90, 'won', 100),
  ('lost', 'Lost', 'خسارة', 99, 'lost', 0)
ON CONFLICT DO NOTHING;

-- Non-loginable system actor for scheduled jobs (reservation expiry, matching, reminders):
-- status 'disabled' and an invalid password hash, so it can never authenticate.
INSERT INTO users (id, email, full_name, password_hash, status)
VALUES ('00000000-0000-4000-8000-000000000001', 'system@autohub.internal', 'AutoHub System', '!disabled', 'disabled')
ON CONFLICT DO NOTHING;
