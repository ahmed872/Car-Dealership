CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid,
	"lead_id" uuid,
	"vehicle_id" uuid,
	"assigned_user_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"title" text,
	"notes" text,
	"outcome" text,
	"cancel_reason" text,
	"driver_license_number" text,
	"driver_license_expiry" date,
	"odometer_out" integer,
	"odometer_in" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "appointments_type_chk" CHECK (type IN ('visit', 'test_drive', 'follow_up', 'delivery', 'inspection', 'other')),
	CONSTRAINT "appointments_status_chk" CHECK (status IN ('scheduled', 'confirmed', 'in_progress', 'completed', 'no_show', 'cancelled')),
	CONSTRAINT "appointments_time_chk" CHECK (ends_at > starts_at),
	CONSTRAINT "appointments_odometer_chk" CHECK (odometer_in IS NULL OR odometer_out IS NULL OR odometer_in >= odometer_out)
);
--> statement-breakpoint
CREATE TABLE "commission_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"rule" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"superseded_by_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_policies_dates_chk" CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
--> statement-breakpoint
CREATE TABLE "customer_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"lead_id" uuid,
	"vehicle_id" uuid,
	"type" text NOT NULL,
	"direction" text,
	"summary" text NOT NULL,
	"outcome" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"next_follow_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_interactions_type_chk" CHECK (type IN ('call', 'whatsapp', 'sms', 'email', 'visit', 'meeting', 'note', 'test_drive', 'quote')),
	CONSTRAINT "customer_interactions_dir_chk" CHECK (direction IS NULL OR direction IN ('inbound', 'outbound'))
);
--> statement-breakpoint
CREATE TABLE "customer_wishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"lead_id" uuid,
	"make_id" uuid,
	"model_id" uuid,
	"year_from" integer,
	"year_to" integer,
	"max_price" numeric(18, 2),
	"max_odometer_km" integer,
	"body_type" text,
	"fuel_type" text,
	"transmission" text,
	"color" text,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_wishes_status_chk" CHECK (status IN ('active', 'fulfilled', 'cancelled', 'expired')),
	CONSTRAINT "customer_wishes_years_chk" CHECK (year_from IS NULL OR year_to IS NULL OR year_from <= year_to)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text DEFAULT 'individual' NOT NULL,
	"full_name" text NOT NULL,
	"company_name" text,
	"phone" text,
	"phone_alt" text,
	"whatsapp" text,
	"email" text,
	"national_id_enc" text,
	"national_id_hash" text,
	"national_id_last4" text,
	"nationality" text,
	"commercial_registration" text,
	"tax_number" text,
	"city" text,
	"address" text,
	"date_of_birth" date,
	"preferred_language" text DEFAULT 'ar' NOT NULL,
	"source" text,
	"assigned_user_id" uuid,
	"branch_id" uuid,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "customers_type_chk" CHECK (type IN ('individual', 'company')),
	CONSTRAINT "customers_lang_chk" CHECK (preferred_language IN ('ar', 'en'))
);
--> statement-breakpoint
CREATE TABLE "employee_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"employee_code" text,
	"job_title" text,
	"phone" text,
	"hire_date" date,
	"monthly_target_units" integer,
	"monthly_target_amount" numeric(18, 2),
	"commission_policy_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"source" text NOT NULL,
	"stage_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"vehicle_id" uuid,
	"interest_notes" text,
	"budget_min" numeric(18, 2),
	"budget_max" numeric(18, 2),
	"payment_preference" text,
	"expected_close_date" date,
	"lost_reason" text,
	"lost_notes" text,
	"won_sale_id" uuid,
	"last_activity_at" timestamp with time zone,
	"next_follow_up_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "leads_status_chk" CHECK (status IN ('open', 'won', 'lost')),
	CONSTRAINT "leads_source_chk" CHECK (source IN ('walk_in', 'phone', 'whatsapp', 'website', 'showroom', 'referral', 'social', 'marketplace', 'campaign', 'other')),
	CONSTRAINT "leads_payment_pref_chk" CHECK (payment_preference IS NULL OR payment_preference IN ('cash', 'bank_finance', 'installments', 'trade_in', 'undecided')),
	CONSTRAINT "leads_budget_chk" CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title_ar" text NOT NULL,
	"title_en" text NOT NULL,
	"body_ar" text,
	"body_en" text,
	"link" text,
	"entity_type" text,
	"entity_id" uuid,
	"dedupe_key" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_severity_chk" CHECK (severity IN ('info', 'success', 'warning', 'danger'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'open' NOT NULL,
	"probability_pct" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stages_kind_chk" CHECK (kind IN ('open', 'won', 'lost')),
	CONSTRAINT "pipeline_stages_prob_chk" CHECK (probability_pct BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "receipt_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"amount_base" numeric(18, 2) NOT NULL,
	CONSTRAINT "receipt_allocations_type_chk" CHECK (target_type IN ('reservation', 'sale', 'installment', 'customer_credit')),
	CONSTRAINT "receipt_allocations_amount_chk" CHECK (amount_base > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"branch_id" uuid,
	"amount" numeric(18, 2) NOT NULL,
	"currency" text NOT NULL,
	"exchange_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"amount_base" numeric(18, 2) NOT NULL,
	"received_at" date NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"notes" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_status_chk" CHECK (status IN ('posted', 'voided')),
	CONSTRAINT "receipts_amount_chk" CHECK (amount > 0 AND amount_base > 0 AND exchange_rate > 0),
	CONSTRAINT "receipts_method_chk" CHECK (method IN ('cash', 'bank_transfer', 'card', 'cheque', 'finance_company', 'other'))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"branch_id" uuid,
	"amount_base" numeric(18, 2) NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"cash_account_id" uuid,
	"method" text,
	"reference" text,
	"paid_at" date,
	"paid_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_status_chk" CHECK (status IN ('requested', 'approved', 'paid', 'rejected', 'cancelled')),
	CONSTRAINT "refunds_source_chk" CHECK (source_type IN ('reservation', 'sale', 'customer_credit')),
	CONSTRAINT "refunds_amount_chk" CHECK (amount_base > 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"lead_id" uuid,
	"sales_user_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"prior_vehicle_status" text NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"agreed_price" numeric(18, 2),
	"deposit_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"forfeited_base" numeric(18, 2) DEFAULT '0' NOT NULL,
	"refund_policy" text NOT NULL,
	"refundable_pct" numeric(9, 4) DEFAULT '100' NOT NULL,
	"notes" text,
	"extended_count" integer DEFAULT 0 NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"expired_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"sale_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reservations_status_chk" CHECK (status IN ('active', 'converted', 'expired', 'cancelled')),
	CONSTRAINT "reservations_policy_chk" CHECK (refund_policy IN ('refundable', 'non_refundable', 'partial')),
	CONSTRAINT "reservations_pct_chk" CHECK (refundable_pct BETWEEN 0 AND 100),
	CONSTRAINT "reservations_deposit_chk" CHECK (deposit_amount >= 0 AND (agreed_price IS NULL OR agreed_price > 0)),
	CONSTRAINT "reservations_expiry_chk" CHECK (expires_at > reserved_at)
);
--> statement-breakpoint
CREATE TABLE "wish_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wish_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_policies" ADD CONSTRAINT "commission_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_interactions" ADD CONSTRAINT "customer_interactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_interactions" ADD CONSTRAINT "customer_interactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_interactions" ADD CONSTRAINT "customer_interactions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_interactions" ADD CONSTRAINT "customer_interactions_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_wishes" ADD CONSTRAINT "customer_wishes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_wishes" ADD CONSTRAINT "customer_wishes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_wishes" ADD CONSTRAINT "customer_wishes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_wishes" ADD CONSTRAINT "customer_wishes_make_id_vehicle_makes_id_fk" FOREIGN KEY ("make_id") REFERENCES "public"."vehicle_makes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_wishes" ADD CONSTRAINT "customer_wishes_model_id_vehicle_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."vehicle_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_cash_account_id_cash_accounts_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."cash_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cash_account_id_cash_accounts_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."cash_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wish_matches" ADD CONSTRAINT "wish_matches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wish_matches" ADD CONSTRAINT "wish_matches_wish_id_customer_wishes_id_fk" FOREIGN KEY ("wish_id") REFERENCES "public"."customer_wishes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wish_matches" ADD CONSTRAINT "wish_matches_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_time_idx" ON "appointments" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_assigned_idx" ON "appointments" USING btree ("tenant_id","assigned_user_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_vehicle_idx" ON "appointments" USING btree ("tenant_id","vehicle_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_policies_version_uq" ON "commission_policies" USING btree ("tenant_id","code","version");--> statement-breakpoint
CREATE INDEX "customer_interactions_customer_idx" ON "customer_interactions" USING btree ("tenant_id","customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_wishes_active_idx" ON "customer_wishes" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "customers_tenant_name_idx" ON "customers" USING btree ("tenant_id","full_name");--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "customers_assigned_idx" ON "customers" USING btree ("tenant_id","assigned_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_national_id_uq" ON "customers" USING btree ("tenant_id","national_id_hash") WHERE national_id_hash IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_profiles_user_uq" ON "employee_profiles" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_profiles_code_uq" ON "employee_profiles" USING btree ("tenant_id","employee_code") WHERE employee_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "lead_stage_history_lead_idx" ON "lead_stage_history" USING btree ("lead_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_number_uq" ON "leads" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "leads_assigned_idx" ON "leads" USING btree ("tenant_id","assigned_user_id","status");--> statement-breakpoint
CREATE INDEX "leads_customer_idx" ON "leads" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "leads_followup_idx" ON "leads" USING btree ("tenant_id","next_follow_up_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("tenant_id","user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_code_uq" ON "pipeline_stages" USING btree (coalesce("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),"code");--> statement-breakpoint
CREATE INDEX "receipt_allocations_target_idx" ON "receipt_allocations" USING btree ("tenant_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_number_uq" ON "receipts" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "receipts_customer_idx" ON "receipts" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_number_uq" ON "refunds" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "refunds_source_idx" ON "refunds" USING btree ("tenant_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_number_uq" ON "reservations" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_vehicle_active_uq" ON "reservations" USING btree ("vehicle_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "reservations_expiry_idx" ON "reservations" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "reservations_customer_idx" ON "reservations" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wish_matches_uq" ON "wish_matches" USING btree ("wish_id","vehicle_id");