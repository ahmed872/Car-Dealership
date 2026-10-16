-- Phase 3 review fixes: realized FX on supplier payments and transfers.
-- supplier_payment_allocations.amount_base keeps meaning "carrying base relieved from the payable";
-- payment_base is the allocation's share of the payment at the payment's own rate, amount_doc the
-- amount settled in the document's currency. The difference posts to 4300 (realized FX).
ALTER TABLE "supplier_payment_allocations" ADD COLUMN "payment_base" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD COLUMN "amount_doc" numeric(18, 2);--> statement-breakpoint
-- Backfill existing rows (payments so far had no FX difference). The table is append-only for the
-- application; the trigger is lifted only for this owner-run backfill.
ALTER TABLE "supplier_payment_allocations" DISABLE TRIGGER supplier_payment_allocations_immutable;--> statement-breakpoint
UPDATE "supplier_payment_allocations" SET "payment_base" = "amount_base" WHERE "payment_base" IS NULL;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ENABLE TRIGGER supplier_payment_allocations_immutable;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ALTER COLUMN "payment_base" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_alloc_payment_base_chk" CHECK (payment_base > 0 AND (amount_doc IS NULL OR amount_doc > 0));--> statement-breakpoint
-- New system account for every existing company (new companies get it from the chart at provisioning).
INSERT INTO ledger_accounts (tenant_id, code, name_en, name_ar, type, is_system)
SELECT t.id, '4300', 'Realized foreign exchange gains / (losses)', 'أرباح / (خسائر) فروق العملة المحققة', 'income', true
FROM tenants t
ON CONFLICT DO NOTHING;
