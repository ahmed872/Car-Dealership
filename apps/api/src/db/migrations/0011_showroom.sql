CREATE TABLE "integration_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_encrypted" text,
	"secret_last4" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_settings_provider_chk" CHECK (provider IN ('vin_decoder', 'ai_text', 'messaging', 'ocr'))
);
--> statement-breakpoint
CREATE TABLE "message_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"body" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"related_type" text,
	"related_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_log_channel_chk" CHECK (channel IN ('whatsapp', 'sms', 'email')),
	CONSTRAINT "message_log_status_chk" CHECK (status IN ('logged', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "showroom_inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"vehicle_id" uuid,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"phone_normalized" text,
	"email" text,
	"message" text,
	"preferred_date" date,
	"consent_at" timestamp with time zone NOT NULL,
	"customer_id" uuid,
	"lead_id" uuid,
	"unlinked_reason" text,
	"client_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "showroom_inquiries_kind_chk" CHECK (kind IN ('inquiry', 'test_drive'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"title_ar" text,
	"title_en" text,
	"description_ar" text,
	"description_en" text,
	"description_source" text DEFAULT 'manual' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"unpublished_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "vehicle_listings_source_chk" CHECK (description_source IN ('manual', 'ai', 'template'))
);
--> statement-breakpoint
ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showroom_inquiries" ADD CONSTRAINT "showroom_inquiries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showroom_inquiries" ADD CONSTRAINT "showroom_inquiries_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showroom_inquiries" ADD CONSTRAINT "showroom_inquiries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showroom_inquiries" ADD CONSTRAINT "showroom_inquiries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_listings" ADD CONSTRAINT "vehicle_listings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_listings" ADD CONSTRAINT "vehicle_listings_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_settings_provider_uq" ON "integration_settings" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "message_log_tenant_idx" ON "message_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "showroom_inquiries_tenant_idx" ON "showroom_inquiries" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "showroom_inquiries_phone_idx" ON "showroom_inquiries" USING btree ("tenant_id","phone_normalized","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_listings_vehicle_uq" ON "vehicle_listings" USING btree ("tenant_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "vehicle_listings_published_idx" ON "vehicle_listings" USING btree ("tenant_id","is_published");