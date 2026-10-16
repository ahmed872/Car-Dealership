-- Phase 3 security & data: tenant RLS, append-only cash book, links from vehicles, cost category catalog.

SELECT app_enable_tenant_rls(t) FROM unnest(ARRAY[
  'suppliers', 'acquisitions', 'vehicle_costs', 'cash_accounts', 'cash_transactions', 'supplier_payments',
  'supplier_payment_allocations', 'expenses', 'work_orders', 'work_order_items', 'approval_requests'
]::regclass[]) AS t;

SELECT app_enable_catalog_rls('cost_categories'::regclass);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autohub_app;

-- The cash book and payment allocations are append-only: corrections are reversal rows.
REVOKE UPDATE, DELETE, TRUNCATE ON cash_transactions, supplier_payment_allocations FROM autohub_app;
CREATE TRIGGER cash_transactions_immutable BEFORE UPDATE OR DELETE ON cash_transactions
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER cash_transactions_no_truncate BEFORE TRUNCATE ON cash_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_modification();
CREATE TRIGGER supplier_payment_allocations_immutable BEFORE UPDATE OR DELETE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION app_reject_modification();

-- Financial documents are never hard-deleted by the application (cancel/void/reverse instead).
REVOKE DELETE ON acquisitions, vehicle_costs, supplier_payments, expenses FROM autohub_app;

-- Posted cost and expense amounts are frozen; only status/approval/reversal metadata may change.
CREATE OR REPLACE FUNCTION posted_amount_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted', 'reversed') AND (
       NEW.amount IS DISTINCT FROM OLD.amount OR NEW.amount_base IS DISTINCT FROM OLD.amount_base
       OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate) THEN
    RAISE EXCEPTION 'immutable_record: posted amounts on % cannot change', TG_TABLE_NAME USING ERRCODE = 'AH001';
  END IF;
  IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'immutable_record: reversed record cannot be reactivated' USING ERRCODE = 'AH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicle_costs_amount_guard BEFORE UPDATE ON vehicle_costs FOR EACH ROW EXECUTE FUNCTION posted_amount_guard();
CREATE TRIGGER expenses_amount_guard BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION posted_amount_guard();

ALTER TABLE vehicles ADD CONSTRAINT vehicles_acquisition_fk FOREIGN KEY (acquisition_id) REFERENCES acquisitions(id);
ALTER TABLE vehicles ADD CONSTRAINT vehicles_supplier_fk FOREIGN KEY (supplier_id) REFERENCES suppliers(id);

-- Platform cost categories (tenant_id NULL). "purchase" is reserved for acquisition postings.
INSERT INTO cost_categories (code, name_en, name_ar, kind, is_system) VALUES
  ('purchase', 'Purchase price', 'سعر الشراء', 'vehicle', true),
  ('transport', 'Transport & towing', 'النقل والسحب', 'vehicle', false),
  ('inspection', 'Inspection', 'الفحص', 'vehicle', false),
  ('maintenance', 'Maintenance & repair', 'الصيانة والإصلاح', 'vehicle', false),
  ('parts', 'Spare parts', 'قطع الغيار', 'vehicle', false),
  ('detailing', 'Detailing & preparation', 'التلميع والتجهيز', 'vehicle', false),
  ('bodywork', 'Bodywork & paint', 'السمكرة والدهان', 'vehicle', false),
  ('broker_commission', 'Purchase commission / broker', 'عمولة الشراء / الوسيط', 'vehicle', false),
  ('government_fees', 'Government fees', 'الرسوم الحكومية', 'vehicle', false),
  ('registration', 'Registration & plates', 'التسجيل واللوحات', 'vehicle', false),
  ('customs', 'Customs & import duties', 'الجمارك ورسوم الاستيراد', 'vehicle', false),
  ('shipping', 'Import shipping', 'الشحن الدولي', 'vehicle', false),
  ('insurance', 'Insurance', 'التأمين', 'vehicle', false),
  ('other_vehicle', 'Other vehicle cost', 'تكاليف أخرى للسيارة', 'vehicle', false),
  ('rent', 'Rent', 'الإيجار', 'operating', false),
  ('salaries', 'Salaries & wages', 'الرواتب والأجور', 'operating', false),
  ('utilities', 'Utilities', 'الكهرباء والمياه والمرافق', 'operating', false),
  ('marketing', 'Marketing & advertising', 'التسويق والإعلان', 'operating', false),
  ('office', 'Office & supplies', 'المكتب والمستلزمات', 'operating', false),
  ('fuel', 'Fuel', 'الوقود', 'operating', false),
  ('maintenance_general', 'Premises maintenance', 'صيانة المقر', 'operating', false),
  ('bank_fees', 'Bank fees', 'رسوم بنكية', 'operating', false),
  ('government_general', 'Licences & government fees', 'التراخيص والرسوم الحكومية', 'operating', false),
  ('insurance_general', 'Business insurance', 'تأمين المنشأة', 'operating', false),
  ('other_operating', 'Other operating expense', 'مصروفات تشغيلية أخرى', 'operating', false)
ON CONFLICT DO NOTHING;
