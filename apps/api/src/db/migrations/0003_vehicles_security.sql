-- Phase 2 security & data: tenant RLS for vehicle tables, catalog RLS (global + tenant rows),
-- immutability of completed inspections, trigram search, and the global catalog seed.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

SELECT app_enable_tenant_rls(t) FROM unnest(ARRAY[
  'vehicles', 'vehicle_status_history', 'vehicle_price_history', 'odometer_readings', 'vehicle_feature_links',
  'vehicle_media', 'vehicle_documents', 'attachments', 'vehicle_inspections', 'inspection_items', 'inspection_panels',
  'inspection_media', 'vehicle_transfers', 'stock_counts', 'stock_count_lines'
]::regclass[]) AS t;

-- Catalog tables: platform rows (tenant_id NULL) are readable by all tenants; tenants write only their own rows.
CREATE OR REPLACE FUNCTION app_enable_catalog_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY catalog_read ON %s FOR SELECT USING (tenant_id IS NULL OR tenant_id = app_current_tenant())', tbl);
  EXECUTE format('CREATE POLICY catalog_insert ON %s FOR INSERT WITH CHECK (tenant_id = app_current_tenant())', tbl);
  EXECUTE format('CREATE POLICY catalog_update ON %s FOR UPDATE USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', tbl);
  EXECUTE format('CREATE POLICY catalog_delete ON %s FOR DELETE USING (tenant_id = app_current_tenant())', tbl);
END $$;

SELECT app_enable_catalog_rls(t) FROM unnest(ARRAY['vehicle_makes', 'vehicle_models', 'features', 'inspection_templates']::regclass[]) AS t;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autohub_app;
-- History tables are append-only for the application.
REVOKE UPDATE, DELETE ON vehicle_status_history, vehicle_price_history, odometer_readings FROM autohub_app;

-- Completed inspections are permanent records: no edits, no deletes, and their items/panels are frozen.
CREATE OR REPLACE FUNCTION inspection_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'completed' THEN
      RAISE EXCEPTION 'immutable_record: completed inspection % cannot be deleted', OLD.id USING ERRCODE = 'AH001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'immutable_record: completed inspection % cannot be modified', OLD.id USING ERRCODE = 'AH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicle_inspections_guard BEFORE UPDATE OR DELETE ON vehicle_inspections
  FOR EACH ROW EXECUTE FUNCTION inspection_guard();

CREATE OR REPLACE FUNCTION inspection_child_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.inspection_id ELSE NEW.inspection_id END;
BEGIN
  IF EXISTS (SELECT 1 FROM vehicle_inspections WHERE id = v_id AND status = 'completed') THEN
    RAISE EXCEPTION 'immutable_record: inspection % is completed', v_id USING ERRCODE = 'AH001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER inspection_items_guard BEFORE INSERT OR UPDATE OR DELETE ON inspection_items
  FOR EACH ROW EXECUTE FUNCTION inspection_child_guard();
CREATE TRIGGER inspection_panels_guard BEFORE INSERT OR UPDATE OR DELETE ON inspection_panels
  FOR EACH ROW EXECUTE FUNCTION inspection_child_guard();

-- Fast partial-text search on identifiers staff type at the counter.
CREATE INDEX vehicles_vin_trgm ON vehicles USING gin (vin gin_trgm_ops);
CREATE INDEX vehicles_plate_trgm ON vehicles USING gin (plate_number gin_trgm_ops);
CREATE INDEX vehicles_stock_trgm ON vehicles USING gin (stock_number gin_trgm_ops);

-- Global catalog (tenant_id NULL): visible to every tenant, editable by none. Tenants add their own rows.
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Toyota', 'تويوتا') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Camry', 'كامري', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Corolla', 'كورولا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Land Cruiser', 'لاند كروزر', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Prado', 'برادو', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Hilux', 'هايلكس', 'pickup' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Yaris', 'يارس', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'RAV4', 'راف فور', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Fortuner', 'فورتشنر', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Avalon', 'أفالون', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Rush', 'رش', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Hyundai', 'هيونداي') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Elantra', 'إلنترا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Hyundai' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Accent', 'أكسنت', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Hyundai' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Tucson', 'توسان', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Hyundai' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Sonata', 'سوناتا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Hyundai' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Santa Fe', 'سانتافي', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Hyundai' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Creta', 'كريتا', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Hyundai' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Azera', 'أزيرا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Hyundai' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Palisade', 'باليسيد', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Hyundai' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Kia', 'كيا') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Cerato', 'سيراتو', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Kia' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Sportage', 'سبورتاج', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Kia' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Rio', 'ريو', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Kia' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Sorento', 'سورينتو', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Kia' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Pegas', 'بيجاس', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Kia' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'K5', 'كي 5', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Kia' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Seltos', 'سيلتوس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Kia' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Carnival', 'كرنفال', 'van' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Kia' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Nissan', 'نيسان') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Sunny', 'صني', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Nissan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Altima', 'ألتيما', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Nissan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Patrol', 'باترول', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Nissan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'X-Trail', 'إكس تريل', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Nissan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Sentra', 'سنترا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Nissan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Kicks', 'كيكس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Nissan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Navara', 'نافارا', 'pickup' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Nissan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Honda', 'هوندا') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Accord', 'أكورد', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Honda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Civic', 'سيفيك', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Honda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'CR-V', 'سي آر في', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Honda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'City', 'سيتي', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Honda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Pilot', 'بايلوت', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Honda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Chevrolet', 'شيفروليه') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Tahoe', 'تاهو', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chevrolet' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Malibu', 'ماليبو', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chevrolet' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Captiva', 'كابتيفا', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chevrolet' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Optra', 'أوبترا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chevrolet' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Silverado', 'سلفرادو', 'pickup' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chevrolet' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Groove', 'جروف', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chevrolet' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Ford', 'فورد') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Explorer', 'إكسبلورر', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Ford' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Expedition', 'إكسبيديشن', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Ford' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'F-150', 'إف 150', 'pickup' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Ford' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Taurus', 'توروس', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Ford' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Territory', 'تيريتوري', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Ford' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Mustang', 'موستانج', 'coupe' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Ford' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Mercedes-Benz', 'مرسيدس بنز') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'C-Class', 'الفئة C', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mercedes-Benz' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'E-Class', 'الفئة E', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mercedes-Benz' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'S-Class', 'الفئة S', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mercedes-Benz' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'GLE', 'جي إل إي', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mercedes-Benz' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'GLC', 'جي إل سي', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mercedes-Benz' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'G-Class', 'الفئة G', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mercedes-Benz' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('BMW', 'بي إم دبليو') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '3 Series', 'الفئة الثالثة', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'BMW' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '5 Series', 'الفئة الخامسة', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'BMW' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '7 Series', 'الفئة السابعة', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'BMW' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'X5', 'إكس 5', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'BMW' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'X3', 'إكس 3', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'BMW' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Lexus', 'لكزس') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'ES', 'إي إس', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Lexus' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'LX', 'إل إكس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Lexus' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'RX', 'آر إكس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Lexus' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'IS', 'آي إس', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Lexus' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'GX', 'جي إكس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Lexus' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Mitsubishi', 'ميتسوبيشي') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Pajero', 'باجيرو', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mitsubishi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Lancer', 'لانسر', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mitsubishi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Attrage', 'أتراج', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mitsubishi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Xpander', 'إكسباندر', 'van' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mitsubishi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Outlander', 'أوتلاندر', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mitsubishi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'L200', 'إل 200', 'pickup' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mitsubishi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('MG', 'إم جي') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'MG5', 'إم جي 5', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'MG' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'ZS', 'زد إس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'MG' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'RX5', 'آر إكس 5', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'MG' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'HS', 'إتش إس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'MG' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'GT', 'جي تي', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'MG' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Chery', 'شيري') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Tiggo 7', 'تيجو 7', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chery' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Tiggo 8', 'تيجو 8', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chery' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Tiggo 4', 'تيجو 4', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chery' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Arrizo 5', 'أريزو 5', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Chery' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Geely', 'جيلي') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Coolray', 'كولراي', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Geely' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Emgrand', 'إمجراند', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Geely' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Tugella', 'توجيلا', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Geely' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Monjaro', 'مونجارو', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Geely' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Changan', 'شانجان') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'CS35', 'سي إس 35', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Changan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'CS75', 'سي إس 75', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Changan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Alsvin', 'السفين', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Changan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Eado', 'إيدو', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Changan' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('GMC', 'جي إم سي') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Yukon', 'يوكن', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'GMC' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Sierra', 'سييرا', 'pickup' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'GMC' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Acadia', 'أكاديا', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'GMC' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Dodge', 'دودج') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Charger', 'تشارجر', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Dodge' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Durango', 'دورانجو', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Dodge' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Challenger', 'تشالنجر', 'coupe' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Dodge' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Jeep', 'جيب') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Grand Cherokee', 'جراند شيروكي', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Jeep' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Wrangler', 'رانجلر', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Jeep' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Compass', 'كومباس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Jeep' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Peugeot', 'بيجو') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '301', '301', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Peugeot' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '3008', '3008', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Peugeot' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '2008', '2008', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Peugeot' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '508', '508', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Peugeot' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Renault', 'رينو') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Logan', 'لوجان', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Renault' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Duster', 'داستر', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Renault' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Megane', 'ميجان', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Renault' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Koleos', 'كوليوس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Renault' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Skoda', 'سكودا') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Octavia', 'أوكتافيا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Skoda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Kodiaq', 'كودياك', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Skoda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Kamiq', 'كاميك', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Skoda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Volkswagen', 'فولكس فاجن') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Passat', 'باسات', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Volkswagen' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Tiguan', 'تيجوان', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Volkswagen' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Golf', 'جولف', 'hatchback' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Volkswagen' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Teramont', 'تيرامونت', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Volkswagen' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Audi', 'أودي') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'A4', 'إيه 4', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Audi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'A6', 'إيه 6', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Audi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Q5', 'كيو 5', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Audi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Q7', 'كيو 7', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Audi' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Suzuki', 'سوزوكي') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Swift', 'سويفت', 'hatchback' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Suzuki' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Dzire', 'ديزاير', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Suzuki' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Ciaz', 'سياز', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Suzuki' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Jimny', 'جيمني', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Suzuki' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Vitara', 'فيتارا', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Suzuki' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Isuzu', 'إيسوزو') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'D-Max', 'دي ماكس', 'pickup' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Isuzu' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Mazda', 'مازدا') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'CX-5', 'سي إكس 5', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mazda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '6', 'مازدا 6', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mazda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '3', 'مازدا 3', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mazda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'CX-9', 'سي إكس 9', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Mazda' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('BYD', 'بي واي دي') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Atto 3', 'أتو 3', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'BYD' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Han', 'هان', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'BYD' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Seal', 'سيل', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'BYD' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Song Plus', 'سونج بلس', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'BYD' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Tesla', 'تسلا') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Model 3', 'موديل 3', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Tesla' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Model Y', 'موديل واي', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Tesla' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Model S', 'موديل إس', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Tesla' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Land Rover', 'لاند روفر') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Range Rover', 'رينج روفر', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Land Rover' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Range Rover Sport', 'رينج روفر سبورت', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Land Rover' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Defender', 'ديفندر', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Land Rover' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Discovery', 'ديسكفري', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Land Rover' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Porsche', 'بورش') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Cayenne', 'كايين', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Porsche' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Macan', 'ماكان', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Porsche' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '911', '911', 'coupe' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Porsche' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Panamera', 'باناميرا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Porsche' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Infiniti', 'إنفينيتي') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'QX80', 'كيو إكس 80', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Infiniti' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'QX60', 'كيو إكس 60', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Infiniti' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Q50', 'كيو 50', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Infiniti' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Cadillac', 'كاديلاك') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Escalade', 'إسكاليد', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Cadillac' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'CT5', 'سي تي 5', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Cadillac' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Genesis', 'جينيسيس') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'G80', 'جي 80', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Genesis' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'GV80', 'جي في 80', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Genesis' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'G70', 'جي 70', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Genesis' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Haval', 'هافال') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'H6', 'إتش 6', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Haval' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Jolion', 'جوليون', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Haval' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'H9', 'إتش 9', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Haval' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Jetour', 'جيتور') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'X70', 'إكس 70', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Jetour' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Dashing', 'داشينج', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Jetour' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'T2', 'تي 2', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Jetour' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Proton', 'بروتون') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Saga', 'ساجا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Proton' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'X70', 'إكس 70', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Proton' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Opel', 'أوبل') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Astra', 'أسترا', 'hatchback' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Opel' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Grandland', 'جراندلاند', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Opel' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Fiat', 'فيات') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Tipo', 'تيبو', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Fiat' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, '500', '500', 'hatchback' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Fiat' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_makes (name_en, name_ar) VALUES ('Lada', 'لادا') ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Granta', 'جرانتا', 'sedan' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Lada' ON CONFLICT DO NOTHING;
INSERT INTO vehicle_models (make_id, name_en, name_ar, body_type) SELECT id, 'Niva', 'نيفا', 'suv' FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Lada' ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('sunroof', 'Sunroof', 'فتحة سقف', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('panoramic_roof', 'Panoramic roof', 'سقف بانورامي', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('leather_seats', 'Leather seats', 'مقاعد جلد', 'interior') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('power_seats', 'Power seats', 'مقاعد كهربائية', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('heated_seats', 'Heated seats', 'مقاعد مدفأة', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('ventilated_seats', 'Ventilated seats', 'مقاعد مبردة', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('memory_seats', 'Memory seats', 'ذاكرة المقاعد', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('keyless_entry', 'Keyless entry', 'دخول بدون مفتاح', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('push_start', 'Push-button start', 'تشغيل بزر', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('cruise_control', 'Cruise control', 'مثبت سرعة', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('adaptive_cruise', 'Adaptive cruise control', 'مثبت سرعة متكيف', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('dual_zone_ac', 'Dual-zone climate', 'تكييف ثنائي المناطق', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('rear_ac', 'Rear A/C vents', 'فتحات تكييف خلفية', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('power_tailgate', 'Power tailgate', 'باب خلفي كهربائي', 'comfort') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('third_row', 'Third-row seating', 'صف مقاعد ثالث', 'interior') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('navigation', 'Navigation system', 'نظام ملاحة', 'technology') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('touchscreen', 'Touchscreen display', 'شاشة لمس', 'technology') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('apple_carplay', 'Apple CarPlay', 'Apple CarPlay', 'technology') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('android_auto', 'Android Auto', 'Android Auto', 'technology') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('bluetooth', 'Bluetooth', 'بلوتوث', 'technology') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('premium_audio', 'Premium audio', 'نظام صوتي فاخر', 'technology') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('wireless_charging', 'Wireless charging', 'شحن لاسلكي', 'technology') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('hud', 'Head-up display', 'شاشة عرض أمامية', 'technology') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('digital_cluster', 'Digital instrument cluster', 'عدادات رقمية', 'technology') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('rear_camera', 'Rear camera', 'كاميرا خلفية', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('camera_360', '360° camera', 'كاميرا 360 درجة', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('parking_sensors', 'Parking sensors', 'حساسات ركن', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('blind_spot', 'Blind-spot monitoring', 'مراقبة النقطة العمياء', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('lane_assist', 'Lane keeping assist', 'مساعد الحفاظ على المسار', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('auto_emergency_braking', 'Automatic emergency braking', 'فرامل طوارئ تلقائية', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('airbags_6plus', '6+ airbags', '6 وسائد هوائية أو أكثر', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('abs', 'ABS', 'نظام ABS', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('esp', 'Stability control (ESP)', 'نظام الثبات ESP', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('tpms', 'Tyre pressure monitoring', 'مراقبة ضغط الإطارات', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('auto_parking', 'Automatic parking', 'ركن تلقائي', 'safety') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('alloy_wheels', 'Alloy wheels', 'جنوط ألمنيوم', 'exterior') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('led_headlights', 'LED headlights', 'مصابيح LED', 'exterior') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('fog_lights', 'Fog lights', 'كشافات ضباب', 'exterior') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('roof_rails', 'Roof rails', 'قضبان سقف', 'exterior') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('tinted_windows', 'Tinted windows', 'زجاج مظلل', 'exterior') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('tow_hitch', 'Tow hitch', 'خطاف قطر', 'exterior') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('turbo', 'Turbocharged', 'محرك تيربو', 'performance') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('sport_mode', 'Sport driving modes', 'أوضاع قيادة رياضية', 'performance') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('off_road_package', 'Off-road package', 'حزمة الطرق الوعرة', 'performance') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('manufacturer_warranty', 'Manufacturer warranty', 'ضمان الوكيل', 'warranty') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('dealer_warranty', 'Dealer warranty', 'ضمان المعرض', 'warranty') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('service_contract', 'Service contract', 'عقد صيانة', 'warranty') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('aftermarket_wheels', 'Aftermarket wheels', 'جنوط معدلة', 'modification') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('body_kit', 'Body kit', 'بودي كيت', 'modification') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('performance_tune', 'Performance tune', 'تعديل أداء', 'modification') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('aftermarket_audio', 'Aftermarket audio', 'نظام صوتي معدل', 'modification') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('ppf', 'Paint protection film', 'حماية طلاء PPF', 'modification') ON CONFLICT DO NOTHING;
INSERT INTO features (code, name_en, name_ar, category) VALUES ('ceramic_coating', 'Ceramic coating', 'طبقة سيراميك', 'modification') ON CONFLICT DO NOTHING;
INSERT INTO inspection_templates (name, vehicle_category, sections, is_default) VALUES ('Standard passenger vehicle / الفحص القياسي', 'all', '[{"key": "engine", "en": "Engine", "ar": "المحرك", "items": [{"key": "cold_start", "en": "Cold start", "ar": "التشغيل البارد", "required": true}, {"key": "engine_noise", "en": "Abnormal noise", "ar": "أصوات غير طبيعية", "required": true}, {"key": "oil_leaks", "en": "Oil leaks", "ar": "تسريب الزيت", "required": true}, {"key": "engine_mounts", "en": "Engine mounts", "ar": "قواعد المحرك", "required": true}, {"key": "exhaust_smoke", "en": "Exhaust smoke", "ar": "دخان العادم", "required": true}, {"key": "warning_lights", "en": "Warning lights", "ar": "لمبات التحذير", "required": true}, {"key": "compression", "en": "Compression test", "ar": "اختبار الضغط", "required": false, "unit": "bar"}]}, {"key": "transmission", "en": "Transmission", "ar": "ناقل الحركة", "items": [{"key": "shifting", "en": "Shift quality", "ar": "سلاسة التبديل", "required": true}, {"key": "trans_leaks", "en": "Fluid leaks", "ar": "تسريب الزيت", "required": true}, {"key": "clutch", "en": "Clutch (manual)", "ar": "الدبرياج (عادي)", "required": false}]}, {"key": "cooling", "en": "Cooling", "ar": "نظام التبريد", "items": [{"key": "coolant", "en": "Coolant level", "ar": "مستوى سائل التبريد", "required": true}, {"key": "radiator", "en": "Radiator", "ar": "الرديتر", "required": true}, {"key": "fan", "en": "Cooling fan", "ar": "مروحة التبريد", "required": true}, {"key": "hoses", "en": "Hoses", "ar": "الخراطيم", "required": true}]}, {"key": "suspension", "en": "Suspension & steering", "ar": "التعليق والتوجيه", "items": [{"key": "shocks", "en": "Shock absorbers", "ar": "المساعدات", "required": true}, {"key": "bushings", "en": "Bushings & links", "ar": "الجلب والوصلات", "required": true}, {"key": "steering_play", "en": "Steering play", "ar": "خلوص الدركسيون", "required": true}, {"key": "alignment", "en": "Wheel alignment", "ar": "ميزان الأذرعة", "required": true}]}, {"key": "brakes", "en": "Brakes", "ar": "الفرامل", "items": [{"key": "front_pads", "en": "Front pads thickness", "ar": "سماكة الفحمات الأمامية", "required": true, "unit": "mm"}, {"key": "rear_pads", "en": "Rear pads thickness", "ar": "سماكة الفحمات الخلفية", "required": true, "unit": "mm"}, {"key": "discs", "en": "Discs", "ar": "الأقراص", "required": true}, {"key": "brake_fluid", "en": "Brake fluid", "ar": "زيت الفرامل", "required": true}, {"key": "handbrake", "en": "Parking brake", "ar": "فرامل اليد", "required": true}]}, {"key": "electrical", "en": "Electrical & electronics", "ar": "الكهرباء والإلكترونيات", "items": [{"key": "battery_voltage", "en": "Battery voltage", "ar": "جهد البطارية", "required": true, "unit": "V"}, {"key": "alternator", "en": "Alternator output", "ar": "شحن الدينامو", "required": false, "unit": "V"}, {"key": "starter", "en": "Starter motor", "ar": "السلف", "required": true}, {"key": "windows", "en": "Power windows", "ar": "النوافذ الكهربائية", "required": true}, {"key": "locks", "en": "Central locking", "ar": "القفل المركزي", "required": true}, {"key": "infotainment", "en": "Infotainment", "ar": "نظام الترفيه", "required": true}, {"key": "diagnostic_codes", "en": "Diagnostic trouble codes", "ar": "أكواد الأعطال (OBD)", "required": false}]}, {"key": "tires", "en": "Tyres", "ar": "الإطارات", "items": [{"key": "tire_fl", "en": "Front-left tread", "ar": "الأمامي الأيسر - عمق النقشة", "required": true, "unit": "mm"}, {"key": "tire_fr", "en": "Front-right tread", "ar": "الأمامي الأيمن - عمق النقشة", "required": true, "unit": "mm"}, {"key": "tire_rl", "en": "Rear-left tread", "ar": "الخلفي الأيسر - عمق النقشة", "required": true, "unit": "mm"}, {"key": "tire_rr", "en": "Rear-right tread", "ar": "الخلفي الأيمن - عمق النقشة", "required": true, "unit": "mm"}, {"key": "tire_spare", "en": "Spare tyre", "ar": "الإطار الاحتياطي", "required": false}, {"key": "tire_dot", "en": "DOT manufacture dates", "ar": "تواريخ تصنيع الإطارات (DOT)", "required": false}]}, {"key": "glass_lights", "en": "Glass & lights", "ar": "الزجاج والإضاءة", "items": [{"key": "windshield", "en": "Windshield", "ar": "الزجاج الأمامي", "required": true}, {"key": "side_glass", "en": "Side & rear glass", "ar": "الزجاج الجانبي والخلفي", "required": true}, {"key": "headlights", "en": "Headlights", "ar": "المصابيح الأمامية", "required": true}, {"key": "tail_lights", "en": "Tail lights", "ar": "المصابيح الخلفية", "required": true}, {"key": "indicators", "en": "Indicators", "ar": "الإشارات", "required": true}]}, {"key": "ac", "en": "Air conditioning", "ar": "التكييف", "items": [{"key": "ac_vent_temp", "en": "Vent temperature", "ar": "حرارة فتحة التكييف", "required": true, "unit": "°C"}, {"key": "heater", "en": "Heater", "ar": "التدفئة", "required": true}, {"key": "compressor", "en": "Compressor", "ar": "الكمبروسر", "required": true}]}, {"key": "interior", "en": "Interior", "ar": "الصالون", "items": [{"key": "seats", "en": "Seats & upholstery", "ar": "المقاعد والفرش", "required": true}, {"key": "dashboard", "en": "Dashboard", "ar": "التابلوه", "required": true}, {"key": "headliner", "en": "Headliner", "ar": "سقف الصالون", "required": true}, {"key": "carpets", "en": "Carpets", "ar": "الأرضيات", "required": true}, {"key": "odor", "en": "Odour", "ar": "الرائحة", "required": true}, {"key": "seatbelts", "en": "Seat belts", "ar": "أحزمة الأمان", "required": true}]}, {"key": "road_test", "en": "Road test", "ar": "تجربة الطريق", "items": [{"key": "acceleration", "en": "Acceleration", "ar": "التسارع", "required": true}, {"key": "braking_test", "en": "Braking", "ar": "الكبح", "required": true}, {"key": "steering_test", "en": "Steering response", "ar": "استجابة التوجيه", "required": true}, {"key": "road_noise", "en": "Road noise & vibration", "ar": "الضوضاء والاهتزاز", "required": true}]}, {"key": "documents", "en": "Identity checks", "ar": "مطابقة البيانات", "items": [{"key": "chassis_match", "en": "Chassis number matches documents", "ar": "تطابق رقم الشاسيه مع المستندات", "required": true}, {"key": "engine_match", "en": "Engine number matches documents", "ar": "تطابق رقم المحرك مع المستندات", "required": true}, {"key": "registration_valid", "en": "Registration valid", "ar": "صلاحية الترخيص", "required": true}]}]'::jsonb, true);
