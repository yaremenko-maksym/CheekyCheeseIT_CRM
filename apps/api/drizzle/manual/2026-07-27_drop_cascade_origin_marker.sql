-- =============================================================================
-- drop_cascade_origin marker column — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- security-review PR #443 (MED-B, second review round). The HIGH-1
-- funding-source guard in `settleByCompany`
-- (apps/api/src/finance/pending-settlement.service.ts) refuses a
-- COMPANY_ACCOUNT-funded settle on a cascade-originated drop obligation — the
-- money never touched the shared company pool for that origin (only
-- `payable = income*(1-dropShare%)` did). The guard used to discriminate
-- cascade-vs-declaration origin SOLELY via `transactions.payout_request_id
-- IS NOT NULL`. That FK is `ON DELETE SET NULL`
-- (transactions_payout_request_id_payout_requests_id_fk) — a future cleanup
-- of an unrelated `payout_requests` row (manual-SQL cleanups on deploy are a
-- live practice in this repo) would SILENTLY null it, and the guard would
-- then fail OPEN: a cascade-originated row would look indistinguishable from
-- an admin-declared one and wrongly allow a COMPANY_ACCOUNT settle.
--
-- Fix: a POSITIVE, permanent origin marker stamped ONCE at INSERT time by
-- `bookCompanyObligations` (transactions.service.ts), from the CALLER's
-- intent — NOT derived from `payout_request_id` afterwards, so later FK
-- activity on `payout_requests` can never affect it. See the column comment
-- in `apps/api/src/database/schema.ts` for the full reasoning.
--
-- IMPORTANT — what `false` actually means (corrected, round 5): `false` means
-- "booked by the admin-declaration path (declareUsdtProjectIncome), not the
-- drop-payout self-service cascade" — NOT "the shared company account
-- definitely holds this money". declareUsdtProjectIncome can also route the
-- declared income to a SPECIFIC admin's personal wallet
-- (`toCompanyPool=false`), in which case the company pool never receives it
-- either, yet the drop/senior obligations it books still carry `false` here.
-- This marker has always been a cascade-vs-declaration discriminator, not a
-- "money is in the pool" guarantee — the funding-SOURCE choice at settle time
-- (COMPANY_ACCOUNT vs ADMIN_PERSONAL, picked by the ADMIN/ACCOUNTANT closing
-- the debt) is what actually decides which pot pays, exactly as it already
-- does for the analogous senior-obligation case. This PR does not change
-- that behaviour — only the wording of an earlier version of this comment
-- overstated it.
--
-- Nullable, no default (security-review PR #443 round 3, LOW): NULL means
-- "unset/unknown" and the settleByCompany guard treats `<> false` (i.e. TRUE
-- or NULL) as BLOCK — only an explicit `false` allows a COMPANY_ACCOUNT
-- settle. A future insert path that forgets to stamp this column therefore
-- fails SAFE, not open. See the column comment in schema.ts for why this is
-- NOT `NOT NULL DEFAULT false` (that would force every unrelated transaction
-- type's insert call site to specify it, plus a backfill migration).
--
-- Also stamped by the sibling backfill script
-- (`2026-07-27_drop_share_pending_parity_backfill.sql`, STEP 1) on the
-- historical rows it converts, for the identical reason — apply THIS file
-- (schema change) BEFORE that one (data change references the new column).
--
-- security-review PR #443 (HIGH-1, round 4) — the fail-safe default DENIES
-- money it was never supposed to deny.
-- --------------------------------------------------------------------------
-- The `<> false` guard above means every PRE-EXISTING `DROP_PENDING_PAYOUT`
-- row — and on prod, per the review, EVERY such row is admin-declaration-
-- originated (`declareUsdtProjectIncome` is the only inserter on
-- `origin/main` at the time of this fix; the drop-payout cascade inserted
-- `PAYOUT_DROP` directly, `drop: null`, until THIS PR) — would get `NULL`
-- from a bare `ADD COLUMN` and then be wrongly BLOCKED from a legitimate
-- COMPANY_ACCOUNT settle. That is worse than a refusal: the UI still
-- pre-selects «Счёт компании», the server 400s with "выберите личный счёт
-- админа", and an ADMIN/ACCOUNTANT who follows that message pays a
-- legitimate company debt out of a PERSONAL account instead — the shared
-- company balance never gets debited for a debt it should have paid,
-- permanently overstating it, with no offsetting entry for the admin who
-- paid out of pocket. STEP 3 below backfills the ONLY correct value for a
-- pre-existing row: `false` (admin-declaration-originated — see the
-- corrected note above) — the pending-parity backfill
-- (`2026-07-27_drop_share_pending_parity_backfill.sql`) is the ONLY other
-- writer of this column and only ever sets `true`, on rows it itself flips
-- from `PAYOUT_DROP` → `DROP_PENDING_PAYOUT`, so there is no predicate
-- overlap between the two backfills (this one runs BEFORE that one, while
-- those rows are still `PAYOUT_DROP`, not `DROP_PENDING_PAYOUT`) — order-
-- independent by construction, not by sequencing discipline.
--
-- security-review PR #443/#447 (round 6) — self-referential cutover boundary,
-- NOT a hardcoded calendar date.
-- --------------------------------------------------------------------------
-- An EARLIER version of STEP 3's backfill bounded itself by a HARDCODED
-- literal (`created_at < TIMESTAMP '2026-08-10'`), picked as "comfortably
-- past this PR's merge + deploy". Round 6 review caught the actual failure
-- mode: if the real rollout of #443/#447 happens AFTER that literal date for
-- ANY reason (delayed merge, held-back deploy, `APPLY_..._BACKFILL` gate left
-- off for weeks — all realistic in this repo's own deploy runbook), the
-- backfill NEVER fires for the restart-window rows it exists to catch. They
-- stay NULL forever, the settleByCompany guard blocks them forever, and the
-- exact harm STEP 3 exists to prevent (a real company debt becoming
-- permanently unsettleable from the account that actually owes it)
-- recurs — just later, and more quietly, because nobody expects a "days-old"
-- migration file to have gone stale by calendar drift alone.
--
-- Fix: replace the calendar literal with a boundary anchored to this file's
-- OWN first real execution on THIS database, recorded once and reused
-- forever — self-referential, immune to how long the rollout is delayed.
-- STEP 1 creates a tiny singleton state table and stamps
-- `first_applied_at = now()` the FIRST time this file ever runs anywhere
-- (`ON CONFLICT DO NOTHING` — every later run, including the deliberate
-- second-pass application after container restart described below, reads
-- the SAME stored timestamp back unchanged). STEP 3's cutoff is
-- `first_applied_at + '24 hours'` — wide enough to comfortably cover the
-- restart window between the marker's two deploy-time passes (schema-change
-- pass before the new api image is live, and a second pass after it and all
-- health/smoke checks are green — see PR #447's deploy.yml wiring) PLUS
-- realistic same-day CI retries, while still being "a day", not "forever":
-- a row created by a genuinely new bug in the ALREADY-DEPLOYED, ALREADY-
-- FIXED code — days or weeks after this file's first run — falls outside
-- the window and correctly stays NULL/blocked, exactly like the calendar
-- version intended, but now provably independent of WHEN the rollout
-- actually happens.
--
-- security-review PR #443 (LOW, round 4) — self-healing regardless of which
-- prior version of this file an environment last saw.
-- --------------------------------------------------------------------------
-- An EARLIER version of this file (round 2) shipped
-- `ADD COLUMN IF NOT EXISTS drop_cascade_origin boolean NOT NULL DEFAULT false`.
-- On any environment where THAT version already ran, a bare
-- `ADD COLUMN IF NOT EXISTS drop_cascade_origin boolean;` today is a no-op —
-- the column already exists, so Postgres never re-evaluates its
-- nullability/default, and the environment stays silently on the OLD
-- (permissive, `NOT NULL DEFAULT false`) semantics forever. STEP 2 below adds
-- two `ALTER COLUMN` statements that are harmless no-ops on a
-- correctly-nullable column (dropping an already-absent default / an
-- already-absent NOT NULL raises no error) and self-healing on a
-- stale-from-round-2 one — the whole file converges to the SAME end state
-- regardless of history.
--
-- security-review PR #443 (LOW, round 5) — statement order.
-- Each statement below auto-commits on its own (no explicit BEGIN wraps
-- STEP 2 — every statement here is independently idempotent by design, see
-- "Idempotent" below). On a stale-from-round-2 environment (`NOT NULL
-- DEFAULT false`), dropping the DEFAULT before dropping NOT NULL leaves a
-- real, momentarily-committed window where the column is NOT NULL with NO
-- default — any concurrent insert into `transactions` that does not
-- explicitly set this column (i.e. every insert path other than
-- bookCompanyObligations' drop branch) would fail in that window. Dropping
-- NOT NULL FIRST removes that window entirely: from that point on the
-- column is already nullable, so subsequently dropping the DEFAULT never
-- creates a state where an omitted value has nowhere to fall back to.
-- Prod is unaffected in practice (this file has never shipped the round-2
-- shape there), but a local/dev DB that has seen an earlier round IS
-- affected — order matters regardless of environment, so it is fixed here
-- rather than documented as a caveat.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-27_drop_cascade_origin_marker.sql
--
-- Add to `.github/workflows/deploy.yml`'s migrate step, applied BEFORE the
-- new api image serves traffic and BEFORE the pending-parity backfill file.
-- Safe to leave wired PERMANENTLY — see the round-6 note above: the cutoff is
-- anchored to this file's own first execution, not to a calendar date, so it
-- never goes stale no matter how long the rollout is delayed. PR #447 also
-- wires a deliberate SECOND application of this SAME file right after the
-- new containers are healthy, to close the restart-window gap the round-6
-- boundary is sized for. DevOps owns the wiring; this PR does not touch
-- `.github/workflows/**`.
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS` + `ON CONFLICT DO NOTHING` (STEP 1,
-- state is written once, ever), `ADD COLUMN IF NOT EXISTS`, the two
-- `ALTER COLUMN` no-ops (STEP 2), and the
-- `UPDATE ... WHERE drop_cascade_origin IS NULL AND created_at < …` backfill
-- (STEP 3 — once a row is backfilled it no longer matches `IS NULL`) are all
-- safe to re-run any number of times, on every deploy, forever.
-- =============================================================================

-- ── STEP 1 — self-referential cutover state (round 6): records THIS file's
--             own first-ever execution timestamp on this database, once, and
--             never again. Singleton table (`CHECK (singleton)` + PK forces
--             at most one row). Untouched by every later run — including the
--             deliberate second deploy-time pass — because of
--             `ON CONFLICT DO NOTHING`. ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS drop_cascade_origin_marker_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  first_applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drop_cascade_origin_marker_state_singleton_ck CHECK (singleton)
);

INSERT INTO drop_cascade_origin_marker_state (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

-- ── STEP 2 — schema: add the column, and self-heal its nullability/default
--             regardless of which prior version of this file (if any) an
--             environment last saw (LOW, round 4). Order matters — NOT NULL
--             dropped before DEFAULT (LOW, round 5; see above). ────────────
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS drop_cascade_origin boolean;

ALTER TABLE transactions ALTER COLUMN drop_cascade_origin DROP NOT NULL;
ALTER TABLE transactions ALTER COLUMN drop_cascade_origin DROP DEFAULT;

-- ── STEP 3 — backfill: every DROP_PENDING_PAYOUT row with an unset marker,
--             created before this file's own first-applied-here timestamp
--             plus a 24-hour restart-window margin (round 6 — replaces the
--             earlier hardcoded calendar literal, see the note above), is,
--             by construction (see the HIGH-1 note above), admin-
--             declaration-originated → `false` is the ONLY correct value.
--             Rows created by the FIXED code (or by a future bug) well after
--             this environment's own rollout are NEVER touched. Logged via
--             RAISE NOTICE so the deploy log shows exactly how many rows
--             this pass touched (0 is a valid, expected outcome on every
--             deploy after the rollout window closes). ─────────────────────
DO $$
DECLARE
  v_backfilled integer;
  v_cutoff timestamptz;
BEGIN
  SELECT first_applied_at + INTERVAL '24 hours'
    INTO v_cutoff
    FROM drop_cascade_origin_marker_state;

  UPDATE transactions
  SET drop_cascade_origin = false
  WHERE drop_cascade_origin IS NULL
    AND type = 'DROP_PENDING_PAYOUT'
    AND created_at < v_cutoff;

  GET DIAGNOSTICS v_backfilled = ROW_COUNT;
  RAISE NOTICE 'drop-cascade-origin-marker: backfilled=% pre-cutover DROP_PENDING_PAYOUT row(s) to false (admin-declared); cutoff=%', v_backfilled, v_cutoff;
END $$;
