-- =============================================================================
-- Notifications: structural identifiers instead of a stored button — prod DDL
-- =============================================================================
--
-- Context
-- -------
-- Position 6 of docs/superpowers/specs/2026-09-01-notifications-and-
-- confirmations-design.md §7.1: "в записи — тип события и идентификаторы
-- объектов; кнопки и подписи выводит клиент по типу". Storing ready-made
-- buttons/labels in the row was rejected by the owner and the spec: editing a
-- label would mean editing DATA, old rows would preserve last year's wording,
-- and interface text would spread into database strings where no copy gate can
-- see it.
--
-- Five additive, nullable columns on `notifications` plus one PARTIAL unique
-- index. Nothing is backfilled: the three pre-existing types
-- (INVOICE_SIGN_REQUIRED / INVOICE_SIGNED / VACANCY_APPLICATION) carry NULL in
-- every new column, which is the correct historical fact — they never had a
-- structural subject, and their button keeps coming from the stored `link`.
-- That IS the "three old types carried over without loss" requirement: no row
-- is rewritten, no row loses anything, and the renderer has an explicit
-- fallback path for exactly this shape.
--
-- Zero data risk: every column is nullable with no DEFAULT, and no currently
-- deployed code reads any of them until the API image from this same PR ships.
--
-- Why `subject_type` is a plain varchar and not an enum: same reasoning as
-- `approvals.subject_type` (2026-09-01_approvals.sql) — the set of subject
-- kinds is owned by the calling modules, and closing it at the DB level would
-- demand a migration for every new notification type. The closed set lives in
-- Zod (`notificationSubjectTypeSchema`), where the client sees it too.
--
-- Why `subject_id` is NOT a foreign key: one column addresses rows in several
-- tables (projects / teams / users / transactions / employee_contracts) —
-- same reasoning as `approvals.subject_id` and `consumed_tx_hashes.reference_id`.
-- More decisively, §7.4: a notification OUTLIVES the object it is about. An FK
-- with ON DELETE CASCADE would delete the history; an FK with RESTRICT would
-- block deleting the object. The product answer is neither — the button must
-- lead to an honest "объекта больше нет", which only a non-FK column can express.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-09-07_notification_subjects.sql
--
-- Wired into .github/workflows/deploy.yml (rollback-preflight file list, SCP
-- copy step, psql apply step) in this SAME PR — mirrors
-- 2026-09-03_pending_senior_share.sql exactly, for the same reason (CR-H-2,
-- code-review PR #624): without these columns the code in this PR does not
-- work, and splitting the migration from its wiring across two PRs leaves a
-- window where prod 500s the moment the image ships.
-- `scripts/devops/check-prod-ddl-wiring.py` verifies both the COPY and the
-- APPLY step exist (not just a comment naming the file).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`
-- (native Postgres syntax) — safe to re-run on every deploy, forever.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. What the notification is ABOUT — kind + id of the object.
-- -----------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS subject_type varchar(50);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS subject_id uuid;

-- -----------------------------------------------------------------------------
-- 2. The event's second participant, when it has one (the new team member, the
--    employee who confirmed). Addressing, not text — hence a column, not a key
--    inside `data`.
-- -----------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS secondary_id uuid;

-- -----------------------------------------------------------------------------
-- 3. The event's FACTS (amounts, percents, the object's name as of the event) —
--    data, never rendered text. The client builds the detail line from these;
--    the email (position 7) deliberately does NOT read them (spec §10: "письмо
--    зовёт в CRM, подробности — там").
-- -----------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data jsonb;

-- -----------------------------------------------------------------------------
-- 4. Idempotency where the event can legitimately be delivered twice. The
--    producer composes `<TYPE>:<subject id>`; the partial unique index below
--    plus ON CONFLICT DO NOTHING makes a retry a no-op. NULL = this event is
--    allowed to repeat (a RE-proposed share change must ask again — that is the
--    whole point of `approvals.superseded_at`), and a partial index leaves those
--    rows unconstrained.
-- -----------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key varchar(200);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_user_dedupe
  ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'notifications'
--       AND column_name IN ('subject_type','subject_id','secondary_id','data','dedupe_key');
--   SELECT indexname FROM pg_indexes
--     WHERE tablename = 'notifications' AND indexname = 'uq_notifications_user_dedupe';
--
-- Expected: five rows from the first query, one from the second.
-- Neither query returns any row CONTENT — no personal data is read or printed
-- by this migration or its verification.
-- =============================================================================
