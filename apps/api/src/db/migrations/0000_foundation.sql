CREATE TABLE "audit_chain_heads" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_seq" bigint NOT NULL,
	"last_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"summary" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text DEFAULT '' NOT NULL,
	"hash" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"city" text,
	"address" text,
	"phone" text,
	"timezone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"purpose" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "membership_branches" (
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	CONSTRAINT "membership_branches_membership_id_branch_id_pk" PRIMARY KEY("membership_id","branch_id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"all_branches" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_status_chk" CHECK (status IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"next_value" bigint NOT NULL,
	CONSTRAINT "number_sequences_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_discount_pct" numeric(9, 4) DEFAULT '0' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_discount_chk" CHECK (max_discount_pct >= 0 AND max_discount_pct <= 100)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_hash" text NOT NULL,
	"tenant_id" uuid,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"max_users" integer,
	"max_branches" integer,
	"max_vehicles" integer,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"price_monthly" numeric(18, 2),
	"currency" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"provider" text,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_subscriptions_status_chk" CHECK (status IN ('trial', 'active', 'past_due', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"market" text NOT NULL,
	"base_currency" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_status_chk" CHECK (status IN ('active', 'suspended')),
	CONSTRAINT "tenants_market_chk" CHECK (market IN ('EG', 'SA', 'AE')),
	CONSTRAINT "tenants_currency_chk" CHECK (base_currency IN ('EGP', 'SAR', 'AED', 'USD', 'EUR'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"phone" text,
	"password_hash" text NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"preferred_locale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lower_chk" CHECK (email = lower(email)),
	CONSTRAINT "users_status_chk" CHECK (status IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_no" bigint NOT NULL,
	"entry_date" date NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"event" text NOT NULL,
	"description" text NOT NULL,
	"branch_id" uuid,
	"reversal_of_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_code" text NOT NULL,
	"debit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"branch_id" uuid,
	"vehicle_id" uuid,
	"customer_id" uuid,
	"supplier_id" uuid,
	"cash_account_id" uuid,
	"sale_id" uuid,
	"user_id" uuid,
	"memo" text,
	CONSTRAINT "journal_lines_amounts_chk" CHECK (debit >= 0 AND credit >= 0 AND ((debit = 0) <> (credit = 0)))
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"type" text NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_tenant_code_uq" UNIQUE("tenant_id","code"),
	CONSTRAINT "ledger_accounts_type_chk" CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense'))
);
--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ADD CONSTRAINT "audit_chain_heads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_fk" FOREIGN KEY ("tenant_id","account_code") REFERENCES "public"."ledger_accounts"("tenant_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_tenant_seq_uq" ON "audit_logs" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_tenant_code_uq" ON "branches" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "branches_tenant_idx" ON "branches" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_storage_key_uq" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "files_tenant_idx" ON "files" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_uq" ON "memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_uq" ON "roles" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_key_uq" ON "roles" USING btree ("tenant_id","key") WHERE key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_plans_code_uq" ON "subscription_plans" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_subscriptions_current_uq" ON "tenant_subscriptions" USING btree ("tenant_id") WHERE status IN ('trial', 'active', 'past_due');--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_uq" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_tenant_no_uq" ON "journal_entries" USING btree ("tenant_id","entry_no");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_event_uq" ON "journal_entries" USING btree ("tenant_id","source_type","source_id","event");--> statement-breakpoint
CREATE INDEX "journal_entries_date_idx" ON "journal_entries" USING btree ("tenant_id","entry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_line_uq" ON "journal_lines" USING btree ("entry_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("tenant_id","account_code");--> statement-breakpoint
CREATE INDEX "journal_lines_vehicle_idx" ON "journal_lines" USING btree ("tenant_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "journal_lines_customer_idx" ON "journal_lines" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "journal_lines_supplier_idx" ON "journal_lines" USING btree ("tenant_id","supplier_id");--> statement-breakpoint
CREATE INDEX "journal_lines_cash_idx" ON "journal_lines" USING btree ("tenant_id","cash_account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_sale_idx" ON "journal_lines" USING btree ("tenant_id","sale_id");