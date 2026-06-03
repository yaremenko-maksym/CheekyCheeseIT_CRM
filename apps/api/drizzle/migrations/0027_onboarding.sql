-- 0027_onboarding.sql
--
-- Phase 6A: Onboarding flow data model. Adds 4 tables (contract_templates,
-- signed_contracts, tos_versions, tos_acceptances) + 1 sequence
-- (contract_number_seq).
--
-- ADMIN bypass is enforced at the application layer (OnboardingGuard) -- the
-- DB only enforces target_role <> 'ADMIN' on contract_templates via a CHECK
-- constraint. Idempotency on sign/accept is enforced at the service layer
-- (no unique (user_id, template_id) constraint: future versions of the same
-- template may need to be re-signed, which is a legitimate flow).

-- contract_templates: editable per-role MSA templates (one active per role)
CREATE TABLE "contract_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_role" "role" NOT NULL,
  "version" integer NOT NULL,
  "body_markdown" text NOT NULL,
  "is_active" boolean DEFAULT false NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "contract_templates_target_role_not_admin" CHECK ("target_role" <> 'ADMIN'),
  CONSTRAINT "contract_templates_target_role_version_unique" UNIQUE ("target_role","version")
);
ALTER TABLE "contract_templates"
  ADD CONSTRAINT "contract_templates_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "contract_templates_one_active_per_role"
  ON "contract_templates" ("target_role") WHERE "is_active" = true;

-- contract_number sequence -- monotonic CHK-<seq>-<year> identifiers
CREATE SEQUENCE "contract_number_seq" START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

-- signed_contracts: immutable audit trail with body_markdown_snapshot
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
  CONSTRAINT "signed_contracts_contract_number_unique" UNIQUE ("contract_number")
);
ALTER TABLE "signed_contracts"
  ADD CONSTRAINT "signed_contracts_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "signed_contracts"
  ADD CONSTRAINT "signed_contracts_template_id_contract_templates_id_fk"
  FOREIGN KEY ("template_id") REFERENCES "contract_templates"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "signed_contracts_user_id_idx" ON "signed_contracts" ("user_id");

-- tos_versions: global versioned ToS (one active globally)
CREATE TABLE "tos_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "version" integer NOT NULL,
  "body_markdown" text NOT NULL,
  "is_active" boolean DEFAULT false NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "tos_versions_version_unique" UNIQUE ("version")
);
ALTER TABLE "tos_versions"
  ADD CONSTRAINT "tos_versions_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "tos_versions_one_active"
  ON "tos_versions" ((true)) WHERE "is_active" = true;

-- tos_acceptances: who accepted which version (one row per user/version)
CREATE TABLE "tos_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "tos_version_id" uuid NOT NULL,
  "accepted_at" timestamp DEFAULT now() NOT NULL,
  "accepted_ip" text,
  "accepted_user_agent" text,
  CONSTRAINT "tos_acceptances_user_id_tos_version_id_unique" UNIQUE ("user_id","tos_version_id")
);
ALTER TABLE "tos_acceptances"
  ADD CONSTRAINT "tos_acceptances_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tos_acceptances"
  ADD CONSTRAINT "tos_acceptances_tos_version_id_tos_versions_id_fk"
  FOREIGN KEY ("tos_version_id") REFERENCES "tos_versions"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "tos_acceptances_user_id_idx" ON "tos_acceptances" ("user_id");
