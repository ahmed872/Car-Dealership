ALTER TABLE "work_orders" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- KI-005: every change to a work order or its items moves its version, so an approval made from a
-- stale screen is refused (the approve route compares the version the approver reviewed).
CREATE OR REPLACE FUNCTION work_order_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER work_orders_version BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION work_order_bump_version();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION work_order_item_touch_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE work_orders SET updated_at = now() WHERE id = COALESCE(NEW.work_order_id, OLD.work_order_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER work_order_items_version AFTER INSERT OR UPDATE OR DELETE ON work_order_items FOR EACH ROW EXECUTE FUNCTION work_order_item_touch_order();
