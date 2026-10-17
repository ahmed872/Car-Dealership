-- Phase 5 security & integrity: tenant RLS on sales tables, no hard deletes of sales money
-- documents, append-only installment allocations, frozen schedules, prices frozen at
-- confirmation, immutable document snapshots, and the sale foreign keys deferred from Phase 4.

SELECT app_enable_tenant_rls(t) FROM unnest(ARRAY[
  'sales', 'trade_ins', 'installment_plans', 'installments', 'installment_allocations', 'commissions',
  'sale_documents', 'cash_day_closings'
]::regclass[]) AS t;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autohub_app;

-- Sales money documents are never hard-deleted (cancel / void / reverse instead).
REVOKE DELETE, TRUNCATE ON sales, trade_ins, installment_plans, installments, installment_allocations,
  commissions, sale_documents, cash_day_closings FROM autohub_app;

-- Installment schedules are frozen; allocations are append-only (a voided receipt's rows are ignored).
REVOKE UPDATE ON installments, installment_allocations FROM autohub_app;
CREATE TRIGGER installments_immutable BEFORE UPDATE OR DELETE ON installments
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER installment_allocations_immutable BEFORE UPDATE OR DELETE ON installment_allocations
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();

-- Once confirmed, a sale's commercial terms are frozen; terminal statuses never change.
CREATE OR REPLACE FUNCTION sale_terms_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('confirmed', 'delivered', 'cancelled', 'returned') AND (
       NEW.agreed_price IS DISTINCT FROM OLD.agreed_price OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
    OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
    OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount OR NEW.tax_mode IS DISTINCT FROM OLD.tax_mode
    OR NEW.tax_rate_pct IS DISTINCT FROM OLD.tax_rate_pct OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.payment_type IS DISTINCT FROM OLD.payment_type
    OR NEW.down_payment IS DISTINCT FROM OLD.down_payment OR NEW.financed_amount IS DISTINCT FROM OLD.financed_amount
    OR NEW.trade_in_credit IS DISTINCT FROM OLD.trade_in_credit OR NEW.deposit_transferred IS DISTINCT FROM OLD.deposit_transferred
    OR NEW.cogs_amount IS DISTINCT FROM OLD.cogs_amount AND OLD.cogs_amount IS NOT NULL) THEN
    RAISE EXCEPTION 'immutable_record: the terms of a confirmed sale cannot change' USING ERRCODE = 'AH001';
  END IF;
  IF OLD.status IN ('cancelled', 'returned') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'immutable_record: a closed sale cannot change status' USING ERRCODE = 'AH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_terms_guard BEFORE UPDATE ON sales FOR EACH ROW EXECUTE FUNCTION sale_terms_guard();

-- An issued document's number, type and snapshot never change; only void metadata may be set once.
CREATE OR REPLACE FUNCTION sale_document_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.type IS DISTINCT FROM OLD.type OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.issue_date IS DISTINCT FROM OLD.issue_date OR (OLD.status = 'voided') THEN
    RAISE EXCEPTION 'immutable_record: an issued document cannot change' USING ERRCODE = 'AH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sale_documents_guard BEFORE UPDATE ON sale_documents FOR EACH ROW EXECUTE FUNCTION sale_document_guard();

-- Closing figures are frozen; a closing can only be reopened (once).
CREATE OR REPLACE FUNCTION cash_day_closing_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expected_balance IS DISTINCT FROM OLD.expected_balance OR NEW.counted_balance IS DISTINCT FROM OLD.counted_balance
     OR NEW.business_date IS DISTINCT FROM OLD.business_date OR NEW.cash_account_id IS DISTINCT FROM OLD.cash_account_id
     OR OLD.status = 'reopened' THEN
    RAISE EXCEPTION 'immutable_record: a cash closing cannot change' USING ERRCODE = 'AH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_day_closings_guard BEFORE UPDATE ON cash_day_closings FOR EACH ROW EXECUTE FUNCTION cash_day_closing_guard();

-- Foreign keys deferred from Phase 4 (the sales table did not exist yet).
ALTER TABLE reservations ADD CONSTRAINT reservations_sale_id_fk FOREIGN KEY (sale_id) REFERENCES sales(id);
ALTER TABLE leads ADD CONSTRAINT leads_won_sale_id_fk FOREIGN KEY (won_sale_id) REFERENCES sales(id);
ALTER TABLE acquisitions ADD CONSTRAINT acquisitions_trade_in_id_fk FOREIGN KEY (trade_in_id) REFERENCES trade_ins(id);
