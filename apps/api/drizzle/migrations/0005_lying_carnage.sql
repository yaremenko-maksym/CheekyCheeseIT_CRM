ALTER TABLE "contract_templates" ADD COLUMN "custom_variables" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "registration_address" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "usr_record" text;