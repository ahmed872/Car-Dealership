CREATE TABLE "cash_day_closings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"expected_balance" numeric(18, 2) NOT NULL,
	"counted_balance" numeric(18, 2) NOT NULL,
	"difference" numeric(18, 2) NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL,
	"notes" text,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reopened_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	CONSTRAINT "cash_day_closings_status_chk" CHECK (status IN ('closed', 'reopened')),
	CONSTRAINT "cash_day_closings_diff_chk" CHECK (difference = counted_balance - expected_balance)
);
--> statement-breakpoint
CREATE TABLE "commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"rule_snapshot" jsonb NOT NULL,
	"earn_on" text NOT NULL,
	"base_amount" numeric(18, 2) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"explanation" text,
	"status" text DEFAULT 'expected' NOT NULL,
	"earned_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_from_account_id" uuid,
	"reversed_at" timestamp with time zone,
	"reverse_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commissions_status_chk" CHECK (status IN ('expected', 'earned', 'approved', 'paid', 'reversed', 'clawback')),
	CONSTRAINT "commissions_amount_chk" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "installment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"installment_id" uuid NOT NULL,
	"principal" numeric(18, 2) NOT NULL,
	"interest" numeric(18, 2) NOT NULL,
	"fees" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_allocations_amounts_chk" CHECK (principal >= 0 AND interest >= 0 AND fees >= 0 AND principal + interest + fees > 0)
);
--> statement-breakpoint
CREATE TABLE "installment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"method" text NOT NULL,
	"annual_rate_pct" numeric(9, 4) NOT NULL,
	"periodic_rate_pct" numeric(12, 8) NOT NULL,
	"count" integer NOT NULL,
	"frequency_months" integer NOT NULL,
	"first_due_date" date NOT NULL,
	"principal" numeric(18, 2) NOT NULL,
	"interest_total" numeric(18, 2) NOT NULL,
	"fees_total" numeric(18, 2) NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"allocation_order" jsonb NOT NULL,
	"future_interest_policy" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"activated_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"waived_interest" numeric(18, 2) DEFAULT '0' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "installment_plans_status_chk" CHECK (status IN ('scheduled', 'active', 'settled', 'completed', 'cancelled')),
	CONSTRAINT "installment_plans_total_chk" CHECK (total_amount = principal + interest_total + fees_total AND principal > 0 AND count > 0)
);
--> statement-breakpoint
CREATE TABLE "installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"due_date" date NOT NULL,
	"principal_due" numeric(18, 2) NOT NULL,
	"interest_due" numeric(18, 2) NOT NULL,
	"fees_due" numeric(18, 2) NOT NULL,
	"total_due" numeric(18, 2) NOT NULL,
	CONSTRAINT "installments_total_chk" CHECK (total_due = principal_due + interest_due + fees_due)
);
--> statement-breakpoint
CREATE TABLE "sale_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"type" text NOT NULL,
	"number" text NOT NULL,
	"issue_date" date NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "sale_documents_type_chk" CHECK (type IN ('contract', 'invoice', 'delivery_note', 'credit_note')),
	CONSTRAINT "sale_documents_status_chk" CHECK (status IN ('issued', 'voided'))
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"lead_id" uuid,
	"reservation_id" uuid,
	"vehicle_id" uuid NOT NULL,
	"salesperson_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payment_type" text DEFAULT 'cash' NOT NULL,
	"sale_date" date NOT NULL,
	"vehicle_prior_status" text NOT NULL,
	"asking_price" numeric(18, 2),
	"floor_price" numeric(18, 2),
	"agreed_price" numeric(18, 2) NOT NULL,
	"discount_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"discount_pct" numeric(9, 4) DEFAULT '0' NOT NULL,
	"tax_mode" text NOT NULL,
	"tax_rate_pct" numeric(7, 4) NOT NULL,
	"prices_include_tax" boolean NOT NULL,
	"net_amount" numeric(18, 2) NOT NULL,
	"tax_amount" numeric(18, 2) NOT NULL,
	"gross_amount" numeric(18, 2) NOT NULL,
	"down_payment" numeric(18, 2),
	"financed_amount" numeric(18, 2),
	"installment_terms" jsonb,
	"trade_in_credit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"deposit_transferred" numeric(18, 2) DEFAULT '0' NOT NULL,
	"external_finance" jsonb,
	"approval_permission" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"vehicle_snapshot" jsonb NOT NULL,
	"customer_snapshot" jsonb NOT NULL,
	"cost_at_confirmation" numeric(18, 2),
	"cogs_amount" numeric(18, 2),
	"recognized_at" timestamp with time zone,
	"recognition_date" date,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"delivered_at" timestamp with time zone,
	"delivered_by" uuid,
	"delivery_override_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"returned_at" timestamp with time zone,
	"returned_by" uuid,
	"return_reason" text,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_status_chk" CHECK (status IN ('draft', 'pending_approval', 'approved', 'confirmed', 'delivered', 'cancelled', 'returned')),
	CONSTRAINT "sales_payment_type_chk" CHECK (payment_type IN ('cash', 'installments', 'external_finance')),
	CONSTRAINT "sales_amounts_chk" CHECK (agreed_price > 0 AND net_amount >= 0 AND tax_amount >= 0 AND gross_amount = net_amount + tax_amount AND trade_in_credit >= 0 AND deposit_transferred >= 0),
	CONSTRAINT "sales_installments_chk" CHECK ((payment_type = 'installments') = (financed_amount IS NOT NULL AND down_payment IS NOT NULL) AND (financed_amount IS NULL OR (financed_amount > 0 AND down_payment >= 0 AND down_payment + financed_amount = gross_amount)))
);
--> statement-breakpoint
CREATE TABLE "trade_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"agreed_value" numeric(18, 2) NOT NULL,
	"vehicle_input" jsonb NOT NULL,
	"vehicle_id" uuid,
	"cost_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_ins_status_chk" CHECK (status IN ('pending', 'received', 'cancelled')),
	CONSTRAINT "trade_ins_value_chk" CHECK (agreed_value > 0)
);
--> statement-breakpoint
ALTER TABLE "cash_day_closings" ADD CONSTRAINT "cash_day_closings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_day_closings" ADD CONSTRAINT "cash_day_closings_cash_account_id_cash_accounts_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."cash_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_paid_from_account_id_cash_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."cash_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_allocations" ADD CONSTRAINT "installment_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_allocations" ADD CONSTRAINT "installment_allocations_plan_id_installment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."installment_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_allocations" ADD CONSTRAINT "installment_allocations_installment_id_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."installments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_plan_id_installment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."installment_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_documents" ADD CONSTRAINT "sale_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_documents" ADD CONSTRAINT "sale_documents_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_ins" ADD CONSTRAINT "trade_ins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_ins" ADD CONSTRAINT "trade_ins_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_ins" ADD CONSTRAINT "trade_ins_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_ins" ADD CONSTRAINT "trade_ins_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_day_closings_live_uq" ON "cash_day_closings" USING btree ("tenant_id","cash_account_id","business_date") WHERE status = 'closed';--> statement-breakpoint
CREATE INDEX "cash_day_closings_account_idx" ON "cash_day_closings" USING btree ("tenant_id","cash_account_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "commissions_sale_user_uq" ON "commissions" USING btree ("tenant_id","sale_id","user_id");--> statement-breakpoint
CREATE INDEX "commissions_user_idx" ON "commissions" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "installment_allocations_plan_idx" ON "installment_allocations" USING btree ("tenant_id","plan_id");--> statement-breakpoint
CREATE INDEX "installment_allocations_receipt_idx" ON "installment_allocations" USING btree ("tenant_id","receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installment_plans_sale_uq" ON "installment_plans" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX "installment_plans_status_idx" ON "installment_plans" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "installments_plan_seq_uq" ON "installments" USING btree ("plan_id","seq");--> statement-breakpoint
CREATE INDEX "installments_due_idx" ON "installments" USING btree ("tenant_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_documents_number_uq" ON "sale_documents" USING btree ("tenant_id","type","number");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_documents_live_uq" ON "sale_documents" USING btree ("tenant_id","sale_id","type") WHERE status = 'issued';--> statement-breakpoint
CREATE UNIQUE INDEX "sales_number_uq" ON "sales" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_vehicle_active_uq" ON "sales" USING btree ("tenant_id","vehicle_id") WHERE status IN ('draft', 'pending_approval', 'approved', 'confirmed', 'delivered');--> statement-breakpoint
CREATE INDEX "sales_customer_idx" ON "sales" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "sales_status_idx" ON "sales" USING btree ("tenant_id","status","sale_date");--> statement-breakpoint
CREATE INDEX "sales_salesperson_idx" ON "sales" USING btree ("tenant_id","salesperson_id");--> statement-breakpoint
CREATE INDEX "trade_ins_sale_idx" ON "trade_ins" USING btree ("tenant_id","sale_id");