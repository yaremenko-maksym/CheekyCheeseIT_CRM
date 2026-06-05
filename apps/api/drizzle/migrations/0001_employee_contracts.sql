CREATE TYPE "public"."employee_contract_status" AS ENUM('DRAFT', 'READY_TO_SIGN', 'SIGNED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "employee_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_template_id" uuid NOT NULL,
	"body_markdown" text NOT NULL,
	"status" "employee_contract_status" DEFAULT 'DRAFT' NOT NULL,
	"signed_contract_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_source_template_id_contract_templates_id_fk" FOREIGN KEY ("source_template_id") REFERENCES "public"."contract_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_signed_contract_id_signed_contracts_id_fk" FOREIGN KEY ("signed_contract_id") REFERENCES "public"."signed_contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_contracts_user_status_idx" ON "employee_contracts" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_contracts_one_per_user" ON "employee_contracts" USING btree ("user_id") WHERE status != 'CANCELLED';--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_employee_contract_user_not_admin() RETURNS trigger AS $emp_contract_check$
BEGIN
  IF (SELECT role FROM users WHERE id = NEW.user_id) = 'ADMIN' THEN
    RAISE EXCEPTION 'employee_contracts cannot reference ADMIN users';
  END IF;
  RETURN NEW;
END;
$emp_contract_check$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER employee_contracts_check_user_not_admin
  BEFORE INSERT OR UPDATE OF user_id ON employee_contracts
  FOR EACH ROW EXECUTE FUNCTION check_employee_contract_user_not_admin();
