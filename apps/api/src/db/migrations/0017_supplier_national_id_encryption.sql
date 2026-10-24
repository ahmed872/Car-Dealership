ALTER TABLE "suppliers" ADD COLUMN "national_id_enc" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "national_id_hash" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "national_id_last4" text;--> statement-breakpoint
CREATE INDEX "suppliers_national_id_hash_idx" ON "suppliers" USING btree ("tenant_id","national_id_hash") WHERE national_id_hash IS NOT NULL;