-- 0025_team_senior_share_override.sql
--
-- task-team-senior-share-override.
--
-- Adds:
--   * teams.senior_share_percent_override (int, nullable, 0-100 check) —
--     team-level override for the SENIOR's share percent. NULL means "no
--     team override", which lets the resolver fall through to the existing
--     project-level override and finally to the SENIOR's user-default
--     percent. RBAC: ADMIN + HR (HR only as owner of the team) edit this
--     field through PATCH /api/teams/:id; the field is exposed on the wire
--     by teamSchema (DTO).
--
--   * transactions.senior_share_percent_source (varchar(16), nullable) —
--     snapshot of *where* the snapshotted `senior_share_percent` came from
--     at SENIOR_INCOME / DROP_INCOME creation time. One of:
--       'PROJECT'      — project.senior_share_percent_override was used.
--       'TEAM'         — team.senior_share_percent_override was used.
--       'USER_DEFAULT' — fell back to users.senior_share_percent.
--     Nullable for legacy rows created before this column existed; the UI
--     gracefully degrades and hides the source badge for those rows.
--
-- Strictly additive — no DROP, no UPDATE on existing rows. Existing
-- transactions keep their senior_share_percent untouched; their new
-- senior_share_percent_source stays NULL (= "legacy, source unknown").
--
-- Why the CHECK constraint on teams.senior_share_percent_override:
--   * The shared Zod schema already validates 0-100, but the DB constraint
--     is an extra defense layer against rogue inserts (e.g. seed scripts,
--     manual SQL).
--
-- Why varchar(16) and not a pgEnum for the source column:
--   * Three values is too small to justify a dedicated enum. Migration is
--     simpler (no ALTER TYPE), and the Zod schema enforces the valid set
--     at the application boundary. Should the set grow we can promote it
--     to a pgEnum in a follow-up.

--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "senior_share_percent_override" integer;

--> statement-breakpoint
ALTER TABLE "teams"
  ADD CONSTRAINT "teams_senior_share_percent_override_range"
  CHECK (
    "senior_share_percent_override" IS NULL
    OR ("senior_share_percent_override" >= 0 AND "senior_share_percent_override" <= 100)
  );

--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "senior_share_percent_source" varchar(16);

--> statement-breakpoint
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_senior_share_percent_source_enum"
  CHECK (
    "senior_share_percent_source" IS NULL
    OR "senior_share_percent_source" IN ('PROJECT', 'TEAM', 'USER_DEFAULT')
  );
