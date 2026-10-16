CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"category" text,
	"caption" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"category" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "features_category_chk" CHECK (category IN ('comfort', 'safety', 'technology', 'exterior', 'interior', 'performance', 'warranty', 'modification', 'other'))
);
--> statement-breakpoint
CREATE TABLE "inspection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"item_key" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"result" text DEFAULT 'not_checked' NOT NULL,
	"severity" text DEFAULT 'none' NOT NULL,
	"measured_value" numeric(12, 3),
	"measured_unit" text,
	"measured_text" text,
	"is_measured" boolean DEFAULT false NOT NULL,
	"notes" text,
	CONSTRAINT "inspection_items_result_chk" CHECK (result IN ('ok', 'attention', 'fail', 'na', 'not_checked')),
	CONSTRAINT "inspection_items_severity_chk" CHECK (severity IN ('none', 'low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "inspection_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"item_key" text,
	"panel_code" text,
	"caption" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspection_panels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"panel_code" text NOT NULL,
	"condition" text DEFAULT 'not_inspected' NOT NULL,
	"paint_thickness_microns" integer,
	"notes" text,
	CONSTRAINT "inspection_panels_condition_chk" CHECK (condition IN ('original', 'repainted', 'filler', 'repaired', 'damaged', 'replaced', 'scratched', 'dented', 'not_inspected'))
);
--> statement-breakpoint
CREATE TABLE "inspection_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"name" text NOT NULL,
	"vehicle_category" text DEFAULT 'all' NOT NULL,
	"sections" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odometer_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"value" integer NOT NULL,
	"unit" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"is_correction" boolean DEFAULT false NOT NULL,
	"notes" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "odometer_readings_chk" CHECK (value >= 0 AND unit IN ('km', 'mi'))
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"expected" boolean NOT NULL,
	"found" boolean,
	"scanned_code" text,
	"scanned_at" timestamp with time zone,
	"location_found" text,
	"notes" text,
	"resolution" text DEFAULT 'none' NOT NULL,
	"resolution_notes" text,
	CONSTRAINT "stock_count_lines_resolution_chk" CHECK (resolution IN ('none', 'confirmed', 'location_updated', 'investigate', 'written_off', 'unexpected_noted'))
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"notes" text,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"reconciled_by" uuid,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_status_chk" CHECK (status IN ('open', 'submitted', 'reconciled', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"file_id" uuid,
	"doc_type" text NOT NULL,
	"doc_number" text,
	"issued_at" date,
	"expires_at" date,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "vehicle_documents_type_chk" CHECK (doc_type IN ('ownership', 'registration', 'insurance', 'inspection', 'customs', 'purchase', 'service_history', 'warranty', 'other'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_feature_links" (
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"notes" text,
	CONSTRAINT "vehicle_feature_links_vehicle_id_feature_id_pk" PRIMARY KEY("vehicle_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "vehicle_inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"template_id" uuid,
	"template_snapshot" jsonb NOT NULL,
	"version_no" integer NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"inspector_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"odometer_value" integer,
	"odometer_unit" text,
	"overall_result" text,
	"summary" text,
	"recommendations" text,
	"accident_history" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_inspections_status_chk" CHECK (status IN ('draft', 'completed', 'cancelled')),
	CONSTRAINT "vehicle_inspections_type_chk" CHECK (type IN ('acquisition', 'pre_sale', 'periodic', 'trade_in', 'return', 'other')),
	CONSTRAINT "vehicle_inspections_result_chk" CHECK (overall_result IS NULL OR overall_result IN ('pass', 'pass_with_notes', 'fail'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_makes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"caption" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_media_kind_chk" CHECK (kind IN ('photo', 'video')),
	CONSTRAINT "vehicle_media_category_chk" CHECK (category IN ('general', 'damage', 'inspection', 'before', 'after', 'document'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"make_id" uuid NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"body_type" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"reason" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"source" text NOT NULL,
	"source_id" uuid,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vsh_source_chk" CHECK (source IN ('manual', 'acquisition', 'reservation', 'sale', 'delivery', 'return', 'transfer', 'stock_count', 'system'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"from_branch_id" uuid NOT NULL,
	"to_branch_id" uuid NOT NULL,
	"status" text DEFAULT 'in_transit' NOT NULL,
	"notes" text,
	"requested_by" uuid,
	"shipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_transfers_status_chk" CHECK (status IN ('in_transit', 'received', 'cancelled')),
	CONSTRAINT "vehicle_transfers_branches_chk" CHECK (from_branch_id <> to_branch_id)
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"stock_number" text NOT NULL,
	"vin" text,
	"engine_number" text,
	"plate_number" text,
	"plate_region" text,
	"make_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"trim" text,
	"model_year" integer NOT NULL,
	"registration_year" integer,
	"condition" text DEFAULT 'used' NOT NULL,
	"body_type" text,
	"exterior_color" text,
	"interior_color" text,
	"doors" integer,
	"seats" integer,
	"fuel_type" text,
	"engine_capacity_cc" integer,
	"cylinders" integer,
	"horsepower" integer,
	"transmission" text,
	"drivetrain" text,
	"odometer_value" integer DEFAULT 0 NOT NULL,
	"odometer_unit" text DEFAULT 'km' NOT NULL,
	"origin_country" text,
	"spec_region" text,
	"ownership_status" text DEFAULT 'owned' NOT NULL,
	"documents_status" text DEFAULT 'pending' NOT NULL,
	"warranty_type" text DEFAULT 'none' NOT NULL,
	"warranty_until" date,
	"warranty_notes" text,
	"location_label" text,
	"acquisition_id" uuid,
	"supplier_id" uuid,
	"acquired_at" date,
	"stocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'incoming' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asking_price" numeric(18, 2),
	"min_price" numeric(18, 2),
	"target_margin_pct" numeric(9, 4),
	"price_updated_at" timestamp with time zone,
	"internal_notes" text,
	"cost_locked_at" timestamp with time zone,
	"removed_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_status_chk" CHECK (status IN ('incoming', 'awaiting_inspection', 'in_inspection', 'in_preparation', 'ready', 'available', 'reserved', 'sale_pending', 'sold', 'delivered', 'returned', 'removed')),
	CONSTRAINT "vehicles_condition_chk" CHECK (condition IN ('new', 'used', 'certified')),
	CONSTRAINT "vehicles_year_chk" CHECK (model_year BETWEEN 1950 AND 2100),
	CONSTRAINT "vehicles_odometer_chk" CHECK (odometer_value >= 0 AND odometer_unit IN ('km', 'mi')),
	CONSTRAINT "vehicles_prices_chk" CHECK ((asking_price IS NULL OR asking_price >= 0) AND (min_price IS NULL OR min_price >= 0)),
	CONSTRAINT "vehicles_ownership_chk" CHECK (ownership_status IN ('owned', 'consignment', 'pending_transfer', 'financed')),
	CONSTRAINT "vehicles_documents_chk" CHECK (documents_status IN ('complete', 'incomplete', 'pending')),
	CONSTRAINT "vehicles_warranty_chk" CHECK (warranty_type IN ('none', 'manufacturer', 'dealer', 'extended')),
	CONSTRAINT "vehicles_vin_chk" CHECK (vin IS NULL OR vin ~ '^[A-Z0-9]{5,17}$')
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_items" ADD CONSTRAINT "inspection_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_items" ADD CONSTRAINT "inspection_items_inspection_id_vehicle_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."vehicle_inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_media" ADD CONSTRAINT "inspection_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_media" ADD CONSTRAINT "inspection_media_inspection_id_vehicle_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."vehicle_inspections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_media" ADD CONSTRAINT "inspection_media_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_panels" ADD CONSTRAINT "inspection_panels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_panels" ADD CONSTRAINT "inspection_panels_inspection_id_vehicle_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."vehicle_inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_templates" ADD CONSTRAINT "inspection_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_stock_count_id_stock_counts_id_fk" FOREIGN KEY ("stock_count_id") REFERENCES "public"."stock_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_feature_links" ADD CONSTRAINT "vehicle_feature_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_feature_links" ADD CONSTRAINT "vehicle_feature_links_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_feature_links" ADD CONSTRAINT "vehicle_feature_links_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_template_id_inspection_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."inspection_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_makes" ADD CONSTRAINT "vehicle_makes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_media" ADD CONSTRAINT "vehicle_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_media" ADD CONSTRAINT "vehicle_media_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_media" ADD CONSTRAINT "vehicle_media_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_make_id_vehicle_makes_id_fk" FOREIGN KEY ("make_id") REFERENCES "public"."vehicle_makes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_price_history" ADD CONSTRAINT "vehicle_price_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_price_history" ADD CONSTRAINT "vehicle_price_history_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_status_history" ADD CONSTRAINT "vehicle_status_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_status_history" ADD CONSTRAINT "vehicle_status_history_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_transfers" ADD CONSTRAINT "vehicle_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_transfers" ADD CONSTRAINT "vehicle_transfers_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_transfers" ADD CONSTRAINT "vehicle_transfers_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_transfers" ADD CONSTRAINT "vehicle_transfers_to_branch_id_branches_id_fk" FOREIGN KEY ("to_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_make_id_vehicle_makes_id_fk" FOREIGN KEY ("make_id") REFERENCES "public"."vehicle_makes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_model_id_vehicle_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."vehicle_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "features_code_uq" ON "features" USING btree (coalesce("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),"code");--> statement-breakpoint
CREATE UNIQUE INDEX "inspection_items_key_uq" ON "inspection_items" USING btree ("inspection_id","section_key","item_key");--> statement-breakpoint
CREATE INDEX "inspection_media_inspection_idx" ON "inspection_media" USING btree ("inspection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inspection_panels_uq" ON "inspection_panels" USING btree ("inspection_id","panel_code");--> statement-breakpoint
CREATE INDEX "inspection_templates_tenant_idx" ON "inspection_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "odometer_readings_vehicle_idx" ON "odometer_readings" USING btree ("vehicle_id","read_at");--> statement-breakpoint
CREATE INDEX "stock_count_lines_count_idx" ON "stock_count_lines" USING btree ("stock_count_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_lines_vehicle_uq" ON "stock_count_lines" USING btree ("stock_count_id","vehicle_id") WHERE vehicle_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_counts_number_uq" ON "stock_counts" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_counts_open_uq" ON "stock_counts" USING btree ("branch_id") WHERE status IN ('open', 'submitted');--> statement-breakpoint
CREATE INDEX "vehicle_documents_vehicle_idx" ON "vehicle_documents" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "vehicle_documents_expiry_idx" ON "vehicle_documents" USING btree ("tenant_id","expires_at") WHERE deleted_at IS NULL AND expires_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vehicle_feature_links_feature_idx" ON "vehicle_feature_links" USING btree ("tenant_id","feature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_inspections_version_uq" ON "vehicle_inspections" USING btree ("vehicle_id","version_no");--> statement-breakpoint
CREATE INDEX "vehicle_inspections_vehicle_idx" ON "vehicle_inspections" USING btree ("tenant_id","vehicle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_makes_name_uq" ON "vehicle_makes" USING btree (coalesce("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name_en"));--> statement-breakpoint
CREATE INDEX "vehicle_media_vehicle_idx" ON "vehicle_media" USING btree ("vehicle_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_media_primary_uq" ON "vehicle_media" USING btree ("vehicle_id") WHERE is_primary;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_models_name_uq" ON "vehicle_models" USING btree (coalesce("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),"make_id",lower("name_en"));--> statement-breakpoint
CREATE INDEX "vehicle_price_history_vehicle_idx" ON "vehicle_price_history" USING btree ("vehicle_id","created_at");--> statement-breakpoint
CREATE INDEX "vehicle_status_history_vehicle_idx" ON "vehicle_status_history" USING btree ("vehicle_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_transfers_number_uq" ON "vehicle_transfers" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_transfers_active_uq" ON "vehicle_transfers" USING btree ("vehicle_id") WHERE status = 'in_transit';--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_stock_number_uq" ON "vehicles" USING btree ("tenant_id","stock_number");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_active_vin_uq" ON "vehicles" USING btree ("tenant_id","vin") WHERE vin IS NOT NULL AND status NOT IN ('delivered', 'removed');--> statement-breakpoint
CREATE INDEX "vehicles_status_idx" ON "vehicles" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "vehicles_branch_idx" ON "vehicles" USING btree ("tenant_id","branch_id");--> statement-breakpoint
CREATE INDEX "vehicles_make_model_idx" ON "vehicles" USING btree ("tenant_id","make_id","model_id");--> statement-breakpoint
CREATE INDEX "vehicles_stocked_idx" ON "vehicles" USING btree ("tenant_id","stocked_at");