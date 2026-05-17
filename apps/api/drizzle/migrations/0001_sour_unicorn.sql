ALTER TYPE "public"."interview_stage" ADD VALUE 'CLIENT_INTERVIEW' BEFORE 'OFFER_RECEIVED';--> statement-breakpoint
ALTER TYPE "public"."transaction_status" ADD VALUE 'PENDING_PAYMENT' BEFORE 'REJECTED';--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "logo_url" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "notes_corp_tech" varchar(255);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "tech_stack" varchar(500);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "team_size" varchar(100);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "benefits" varchar(500);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "payment_type" varchar(100);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "salary_review" varchar(255);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "corp_tech" varchar(255);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "notes_general" varchar(1000);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "tx_date" timestamp;