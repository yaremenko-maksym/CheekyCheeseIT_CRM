-- Migration 0010: Add event_date to legend_entries
-- Additive: NULL = use createdAt for display/sort (backward-compatible)
--> statement-breakpoint
ALTER TABLE "legend_entries" ADD COLUMN "event_date" text;
