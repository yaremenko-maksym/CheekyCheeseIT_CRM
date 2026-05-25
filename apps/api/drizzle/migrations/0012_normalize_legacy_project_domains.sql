-- Migration: Normalize legacy `projects.domain` values to current `IT_DOMAINS` enum.
--
-- User-testing of PR #48 (PHASE 6 documents UI) surfaced a 400
-- «Invalid option: domain» error in the Projects edit dialog. Root cause:
-- the seed (and early production data) wrote free-form domains that are
-- no longer members of the `IT_DOMAINS` enum defined in
-- `packages/shared/src/schemas/projects.ts`. When user opened the edit
-- modal on a legacy project and clicked Save without touching the
-- domain dropdown, the form submitted the stale value (e.g. `'AI'`,
-- `'Design Platform'`, `'Gambling / Betting'`) which failed
-- `updateProjectSchema.parse(...)` server-side.
--
-- Domain is a free-text VARCHAR column (no DB-level enum), so this is a
-- pure data fix — no schema change. Mapping uses the closest IT_DOMAIN:
--   'AI'                 → 'AI / ML'
--   'Design Platform'    → 'Other'        (no direct equivalent)
--   'Gambling / Betting' → 'Gambling'
--
-- Idempotent: re-running on already-migrated rows is a no-op because
-- the WHERE clause only matches the legacy literals.

--> statement-breakpoint
UPDATE "projects" SET "domain" = 'AI / ML' WHERE "domain" = 'AI';
--> statement-breakpoint
UPDATE "projects" SET "domain" = 'Other' WHERE "domain" = 'Design Platform';
--> statement-breakpoint
UPDATE "projects" SET "domain" = 'Gambling' WHERE "domain" = 'Gambling / Betting';
