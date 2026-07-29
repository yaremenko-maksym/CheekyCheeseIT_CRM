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
-- paid out of pocket. STEP 2 below backfills the ONLY correct value for a
-- pre-existing row: `false` (admin-declaration-originated — see the
-- corrected note above) — the pending-parity backfill
-- (`2026-07-27_drop_share_pending_parity_backfill.sql`) is the ONLY other
-- writer of this column and only ever sets `true`, on rows it itself flips
-- from `PAYOUT_DROP` → `DROP_PENDING_PAYOUT`, so there is no predicate
-- overlap between the two backfills (this one runs BEFORE that one, while
-- those rows are still `PAYOUT_DROP`, not `DROP_PENDING_PAYOUT`) — order-
-- independent by construction, not by sequencing discipline.
--
-- security-review PR #443 (MED-1, round 5) — bounded by created_at instead
-- of wired-twice-then-removed.
-- --------------------------------------------------------------------------
-- `deploy.yml` re-applies every wired file on EVERY deploy. An EARLIER
-- version of this file's STEP 2 had NO upper bound on which rows it would
-- touch — a bare `WHERE drop_cascade_origin IS NULL` self-heals the deploy-
-- window gap (the old api image keeps calling the pre-fix
-- `bookCompanyObligations`, unaware of this column, until the new image
-- takes over — see the HIGH-1 note), which is good, BUT it also means any
-- FUTURE bug that forgets to stamp the marker on a genuinely new insert path
-- would have its `NULL` silently rewritten to the permissive `false` on the
-- very next deploy — quietly defeating the fail-safe default (round 3, LOW)
-- for good. The one-line fix: bound STEP 2 to rows created BEFORE the
-- rollout window closes (`created_at < TIMESTAMP '2026-08-10'`) — comfortably
-- past this PR's merge + deploy. Rows created before that cutoff are, by
-- construction (HIGH-1 above), either historical or deploy-window
-- admin-declared rows — `false` is correct for all of them, regardless of
-- which deploy attempt or retry actually inserted them. Any row created
-- AFTER the cutoff was written by the FIXED code (which always stamps this
-- column explicitly — see bookCompanyObligations, transactions.service.ts)
-- or is a genuinely new bug that SHOULD stay blocked and visible, not
-- silently patched. This makes the file safe to leave wired in `deploy.yml`
-- PERMANENTLY — no second, one-time, later-de-wired application is needed
-- (an earlier version of this file asked DevOps for one; that request is
-- withdrawn — the owner is retracting the corresponding note passed to
-- DevOps separately).
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
-- (permissive, `NOT NULL DEFAULT false`) semantics forever. STEP 1 below adds
-- two `ALTER COLUMN` statements that are harmless no-ops on a
-- correctly-nullable column (dropping an already-absent default / an
-- already-absent NOT NULL raises no error) and self-healing on a
-- stale-from-round-2 one — the whole file converges to the SAME end state
-- regardless of history.
--
-- security-review PR #443 (LOW, round 5) — statement order.
-- Each statement below auto-commits on its own (no explicit BEGIN wraps
-- STEP 1 — every statement here is independently idempotent by design, see
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
-- Safe to leave wired PERMANENTLY (round 5) — see the MED-1 note above for
-- why the created_at bound makes a second, one-time, de-wired application
-- unnecessary. DevOps owns the wiring; this PR does not touch
-- `.github/workflows/**`.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS`, the two `ALTER COLUMN` no-ops, and
-- the `UPDATE ... WHERE drop_cascade_origin IS NULL AND created_at < …`
-- backfill (once a row is backfilled it no longer matches `IS NULL`) are all
-- safe to re-run any number of times, on every deploy, forever.
-- =============================================================================

-- ── STEP 1 — schema: add the column, and self-heal its nullability/default
--             regardless of which prior version of this file (if any) an
--             environment last saw (LOW, round 4). Order matters — NOT NULL
--             dropped before DEFAULT (LOW, round 5; see above). ────────────
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS drop_cascade_origin boolean;

ALTER TABLE transactions ALTER COLUMN drop_cascade_origin DROP NOT NULL;
ALTER TABLE transactions ALTER COLUMN drop_cascade_origin DROP DEFAULT;

-- ── STEP 2 — backfill: every DROP_PENDING_PAYOUT row created before the
--             rollout window closes, with an unset marker, is, by
--             construction (see the HIGH-1 note above), admin-declaration-
--             originated → `false` is the ONLY correct value. Bounded by
--             created_at (MED-1, round 5) so this stays safe to leave wired
--             forever — rows created by the FIXED code (or by a future bug)
--             after the cutoff are NEVER touched. Logged via RAISE NOTICE so
--             the deploy log shows exactly how many rows this pass touched
--             (0 is a valid, expected outcome on every deploy after the
--             rollout window closes). ───────────────────────────────────────
DO $$
DECLARE
  v_backfilled integer;
BEGIN
  UPDATE transactions
  SET drop_cascade_origin = false
  WHERE drop_cascade_origin IS NULL
    AND type = 'DROP_PENDING_PAYOUT'
    AND created_at < TIMESTAMP '2026-08-10';

  GET DIAGNOSTICS v_backfilled = ROW_COUNT;
  RAISE NOTICE 'drop-cascade-origin-marker: backfilled=% pre-cutover DROP_PENDING_PAYOUT row(s) to false (admin-declared)', v_backfilled;
END $$;
