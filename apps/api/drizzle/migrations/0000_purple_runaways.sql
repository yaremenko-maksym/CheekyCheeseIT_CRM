CREATE TYPE "public"."currency" AS ENUM('USDT', 'USD', 'EUR', 'UAH');--> statement-breakpoint
CREATE TYPE "public"."document_category" AS ENUM('RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'AVATAR', 'LOGO', 'INVOICE');--> statement-breakpoint
CREATE TYPE "public"."interview_stage" AS ENUM('HR_SCREEN', 'ENGLISH_CHECK', 'TECH_INTERVIEW', 'FINAL_INTERVIEW', 'CLIENT_INTERVIEW', 'OFFER_RECEIVED', 'HIRED', 'REJECTED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."invoice_signature_method" AS ENUM('AUTO_COMPANY', 'MANUAL_CLICK');--> statement-breakpoint
CREATE TYPE "public"."invoice_signer_role" AS ENUM('COMPANY', 'COUNTERPARTY');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('USDT_ERC20', 'BANK_UAH_FOP');--> statement-breakpoint
CREATE TYPE "public"."payout_request_status" AS ENUM('PENDING', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."pending_obligation_debtor_type" AS ENUM('DROP', 'TOV', 'ADMIN', 'COMPANY');--> statement-breakpoint
CREATE TYPE "public"."pending_obligation_status" AS ENUM('PENDING', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP');--> statement-breakpoint
CREATE TYPE "public"."team_type" AS ENUM('SENIOR', 'DROP');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('PENDING', 'VALIDATED', 'PENDING_PAYMENT', 'REJECTED', 'PAID', 'LOCKED', 'PENDING_CASH_CONFIRM');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('ADMIN_INCOME', 'SENIOR_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER', 'PAYOUT', 'PAYOUT_ADMIN', 'DROP_INCOME', 'PAYOUT_DROP', 'PAYOUT_CONFIRMED', 'TOV_INCOME', 'SENIOR_PENDING_PAYOUT', 'SENIOR_PAID', 'ADMIN_INCOME_CASH', 'ADMIN_INCOME_CRYPTO', 'SENIOR_INCOME_CRYPTO', 'DIVIDEND_TO_ADMIN', 'DIVIDEND_TAX');--> statement-breakpoint
CREATE TABLE "contract_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_role" "role" NOT NULL,
	"version" integer NOT NULL,
	"body_markdown" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contract_templates_target_role_version_unique" UNIQUE("target_role","version")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"category" "document_category" NOT NULL,
	"name" varchar(255) NOT NULL,
	"original_name" varchar(255),
	"s3_key" varchar(512) NOT NULL,
	"thumbnail_s3_key" varchar(512),
	"size_bytes" integer NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"deleted_at" timestamp,
	"deleted_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "documents_s3_key_unique" UNIQUE("s3_key")
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"senior_id" uuid NOT NULL,
	"hr_id" uuid,
	"company_name" varchar(255) NOT NULL,
	"vacancy_url" varchar(1000),
	"call_url" varchar(1000),
	"stage" "interview_stage" DEFAULT 'HR_SCREEN' NOT NULL,
	"notes_domain" varchar(255),
	"notes_tech_stack" varchar(500),
	"notes_team_size" varchar(100),
	"notes_benefits" varchar(500),
	"notes_payment_type" varchar(100),
	"notes_salary_review" varchar(255),
	"notes_corp_tech" varchar(255),
	"notes_general" varchar(1000),
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"signer_role" "invoice_signer_role" NOT NULL,
	"signer_id" uuid NOT NULL,
	"signed_at" timestamp DEFAULT now() NOT NULL,
	"pdf_hash" char(64) NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"method" "invoice_signature_method" NOT NULL,
	CONSTRAINT "uniq_sig" UNIQUE("transaction_id","signer_role")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text,
	"link" varchar(500),
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"senior_id" uuid NOT NULL,
	"income_amount" numeric(18, 6) NOT NULL,
	"payable_amount" numeric(18, 6) NOT NULL,
	"contract_address" varchar(255) NOT NULL,
	"tx_hash" varchar(255),
	"status" "payout_request_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creditor_user_id" uuid NOT NULL,
	"debtor_type" "pending_obligation_debtor_type" NOT NULL,
	"debtor_user_id" uuid,
	"source_transaction_id" uuid NOT NULL,
	"closing_transaction_id" uuid,
	"amount" numeric(20, 6) NOT NULL,
	"currency" "currency" DEFAULT 'USDT' NOT NULL,
	"status" "pending_obligation_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_finance_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"senior_share_percent_override" integer,
	"junior_salary_override" numeric(10, 2),
	"updated_by" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_finance_settings_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"company_name" varchar(255) NOT NULL,
	"domain" varchar(100) NOT NULL,
	"start_date" timestamp NOT NULL,
	"senior_id" uuid NOT NULL,
	"drop_id" uuid,
	"rate" integer NOT NULL,
	"currency" "currency" DEFAULT 'USDT' NOT NULL,
	"logo_document_id" uuid,
	"logo_external_url" text,
	"tech_stack" varchar(500),
	"team_size" varchar(100),
	"benefits" varchar(500),
	"payment_type" varchar(100),
	"salary_review" varchar(255),
	"corp_tech" varchar(255),
	"notes_general" varchar(1000),
	"senior_share_percent_override" integer,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signed_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"body_markdown_snapshot" text NOT NULL,
	"variables_filled" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signed_typed_name" text NOT NULL,
	"signed_ip" text,
	"signed_user_agent" text,
	"signed_at" timestamp DEFAULT now() NOT NULL,
	"contract_number" text NOT NULL,
	CONSTRAINT "signed_contracts_contract_number_unique" UNIQUE("contract_number")
);
--> statement-breakpoint
CREATE TABLE "team_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "team_type" DEFAULT 'SENIOR' NOT NULL,
	"telegram" varchar(500),
	"telegram_channel" text,
	"notes" text,
	"senior_share_percent_override" integer,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tos_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tos_version_id" uuid NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL,
	"accepted_ip" text,
	"accepted_user_agent" text,
	CONSTRAINT "tos_acceptances_user_id_tos_version_id_unique" UNIQUE("user_id","tos_version_id")
);
--> statement-breakpoint
CREATE TABLE "tos_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"body_markdown" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tos_versions_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "transaction_type" NOT NULL,
	"status" "transaction_status" DEFAULT 'PENDING' NOT NULL,
	"amount" numeric(18, 6) NOT NULL,
	"currency" "currency" DEFAULT 'USDT' NOT NULL,
	"sender_id" uuid,
	"sender_label" varchar(255),
	"receiver_id" uuid,
	"receiver_label" varchar(255),
	"recipient_id" uuid,
	"project_id" uuid,
	"payout_request_id" uuid,
	"senior_share_percent" integer,
	"senior_share_percent_source" varchar(16),
	"receipt_document_id" uuid,
	"receipt_external_url" text,
	"invoice_document_id" uuid,
	"tx_hash" varchar(255),
	"validated_by" uuid,
	"validated_at" timestamp,
	"rejection_reason" varchar(500),
	"notes" varchar(1000),
	"salary_month" varchar(7),
	"tx_date" timestamp,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"avatar_url" varchar(1000),
	"avatar_document_id" uuid,
	"role" "role" DEFAULT 'JUNIOR' NOT NULL,
	"google_id" varchar(255),
	"telegram" varchar(100),
	"phone" varchar(30),
	"tech_stack" text[],
	"payment_method" "payment_method",
	"wallet_usdt_erc20" text,
	"wallet_usdt_label" text,
	"bank_uah_recipient" text,
	"bank_uah_iban" text,
	"bank_uah_rnokpp" text,
	"bank_uah_bank_name" text,
	"senior_share_percent" integer DEFAULT 26 NOT NULL,
	"drop_share_percent" integer DEFAULT 5,
	"monthly_salary" numeric(10, 2),
	"salary_currency" "currency" DEFAULT 'USD',
	"legal_full_name" text,
	"archived_at" timestamp,
	"admin_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_senior_id_users_id_fk" FOREIGN KEY ("senior_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_hr_id_users_id_fk" FOREIGN KEY ("hr_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_signatures" ADD CONSTRAINT "invoice_signatures_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_signatures" ADD CONSTRAINT "invoice_signatures_signer_id_users_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_senior_id_users_id_fk" FOREIGN KEY ("senior_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_obligations" ADD CONSTRAINT "pending_obligations_creditor_user_id_users_id_fk" FOREIGN KEY ("creditor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_obligations" ADD CONSTRAINT "pending_obligations_debtor_user_id_users_id_fk" FOREIGN KEY ("debtor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_obligations" ADD CONSTRAINT "pending_obligations_source_transaction_id_transactions_id_fk" FOREIGN KEY ("source_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_obligations" ADD CONSTRAINT "pending_obligations_closing_transaction_id_transactions_id_fk" FOREIGN KEY ("closing_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_audit_log" ADD CONSTRAINT "project_audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_audit_log" ADD CONSTRAINT "project_audit_log_target_id_projects_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_finance_settings" ADD CONSTRAINT "project_finance_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_finance_settings" ADD CONSTRAINT "project_finance_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_senior_id_users_id_fk" FOREIGN KEY ("senior_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_drop_id_users_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_contracts" ADD CONSTRAINT "signed_contracts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_contracts" ADD CONSTRAINT "signed_contracts_template_id_contract_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."contract_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_audit_log" ADD CONSTRAINT "team_audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_audit_log" ADD CONSTRAINT "team_audit_log_target_id_teams_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tos_acceptances" ADD CONSTRAINT "tos_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tos_acceptances" ADD CONSTRAINT "tos_acceptances_tos_version_id_tos_versions_id_fk" FOREIGN KEY ("tos_version_id") REFERENCES "public"."tos_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tos_versions" ADD CONSTRAINT "tos_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_receiver_id_users_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payout_request_id_payout_requests_id_fk" FOREIGN KEY ("payout_request_id") REFERENCES "public"."payout_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_receipt_document_id_documents_id_fk" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_invoice_document_id_documents_id_fk" FOREIGN KEY ("invoice_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_validated_by_users_id_fk" FOREIGN KEY ("validated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_audit_log" ADD CONSTRAINT "user_audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_audit_log" ADD CONSTRAINT "user_audit_log_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_documents_owner" ON "documents" USING btree ("owner_id") WHERE "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_documents_project" ON "documents" USING btree ("project_id") WHERE "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_documents_category" ON "documents" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_invoice_signatures_transaction" ON "invoice_signatures" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_invoice_signatures_signer" ON "invoice_signatures" USING btree ("signer_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_user_created" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_pending_obligations_creditor" ON "pending_obligations" USING btree ("creditor_user_id");--> statement-breakpoint
CREATE INDEX "idx_pending_obligations_status" ON "pending_obligations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pending_obligations_source" ON "pending_obligations" USING btree ("source_transaction_id");--> statement-breakpoint
CREATE INDEX "project_audit_log_target_id_idx" ON "project_audit_log" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "project_audit_log_created_at_idx" ON "project_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "signed_contracts_user_id_idx" ON "signed_contracts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "team_audit_log_target_id_idx" ON "team_audit_log" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "team_audit_log_created_at_idx" ON "team_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tos_acceptances_user_id_idx" ON "tos_acceptances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_audit_log_target_id_idx" ON "user_audit_log" USING btree ("target_id");