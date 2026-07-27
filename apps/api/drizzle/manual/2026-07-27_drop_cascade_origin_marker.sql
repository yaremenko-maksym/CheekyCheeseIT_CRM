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
-- админа", and an ADMIN/ACCOUNTANT who follows that message pays the senior
-- (sic — a DROP obligation, see the UI/DTO note below) out of a PERSONAL
-- account instead — the shared company balance never gets debited for money
-- it is genuinely holding, permanently overstating it, with no offsetting
-- entry for the admin who paid out of pocket. STEP 2 below backfills the
-- ONLY safe value for a pre-existing row: `false` (admin-declared, money
-- genuinely in the pool) — the pending-parity backfill
-- (`2026-07-27_drop_share_pending_parity_backfill.sql`) is the ONLY other
-- writer of this column and only ever sets `true`, on rows it itself flips
-- from `PAYOUT_DROP` → `DROP_PENDING_PAYOUT`, so there is no predicate
-- overlap between the two backfills (this one runs BEFORE that one, while
-- those rows are still `PAYOUT_DROP`, not `DROP_PENDING_PAYOUT`).
--
-- Deploy-window gap: this file's UPDATE only catches rows that exist AT THE
-- MOMENT it runs. If the OLD api image is still serving traffic after this
-- migration applies (normal rolling-deploy overlap), it keeps calling the
-- OLD `bookCompanyObligations` — which does not know about this column at
-- all — and inserts FRESH `DROP_PENDING_PAYOUT` rows with `drop_cascade_origin
-- = NULL` until the NEW image (this PR's code) takes over. Those rows need
-- the SAME backfill, but only exist AFTER the old image stops writing.
-- Therefore: apply this file TWICE —
--   1. As part of the normal migrate step, before the new image serves
--      traffic (as always).
--   2. AGAIN, as a distinct ONE-TIME step, once the new containers are
--      confirmed up and the old image is confirmed stopped (so no more
--      unmarked rows can be created) — this second pass sweeps the deploy-
--      window stragglers.
-- After step 2 confirms `RAISE NOTICE ... backfilled=0` (nothing left to
-- catch), REMOVE the step-2 invocation from the pipeline — mirrors the
-- pending-parity backfill's own de-wire requirement (MED-4): leaving a
-- recurring "set NULL → false" sweep wired PERMANENTLY would silently patch
-- over a FUTURE bug that forgets to stamp this column on a genuinely new
-- code path, defeating the whole fail-safe point of leaving the column
-- nullable (round 3, LOW). The first invocation (schema `ADD COLUMN`) stays
-- wired forever — pure additive DDL, always safe; it is only the BACKFILL
-- UPDATE that must not become a permanent fixture. This second-pass step is
-- DevOps's to schedule in `.github/workflows/deploy.yml` — noted here as a
-- dependency, not wired by this PR (see PR body).
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
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-27_drop_cascade_origin_marker.sql
--
-- Add to `.github/workflows/deploy.yml`'s migrate step, applied BEFORE the
-- new api image serves traffic and BEFORE the pending-parity backfill file.
-- DevOps owns the wiring — including the required SECOND, one-time,
-- later-de-wired application described above (this PR does not touch
-- `.github/workflows/**`).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS`, the two `ALTER COLUMN` no-ops, and
-- the `UPDATE ... WHERE drop_cascade_origin IS NULL` backfill (once a row is
-- backfilled it no longer matches `IS NULL`) are all safe to re-run any
-- number of times.
-- =============================================================================

-- ── STEP 1 — schema: add the column, and self-heal its nullability/default
--             regardless of which prior version of this file (if any) an
--             environment last saw (LOW, round 4). ──────────────────────────
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS drop_cascade_origin boolean;

ALTER TABLE transactions ALTER COLUMN drop_cascade_origin DROP DEFAULT;
ALTER TABLE transactions ALTER COLUMN drop_cascade_origin DROP NOT NULL;

-- ── STEP 2 — backfill: every PRE-EXISTING DROP_PENDING_PAYOUT row with an
--             unset marker is, by construction (see the HIGH-1 note above),
--             admin-declaration-originated → `false` is the ONLY correct
--             value. Logged via RAISE NOTICE so the deploy log shows exactly
--             how many rows this pass touched (0 is a valid, expected
--             outcome — e.g. on the required second, post-cutover pass once
--             the first pass already caught everything). ───────────────────
DO $$
DECLARE
  v_backfilled integer;
BEGIN
  UPDATE transactions
  SET drop_cascade_origin = false
  WHERE drop_cascade_origin IS NULL
    AND type = 'DROP_PENDING_PAYOUT';

  GET DIAGNOSTICS v_backfilled = ROW_COUNT;
  RAISE NOTICE 'drop-cascade-origin-marker: backfilled=% pre-existing DROP_PENDING_PAYOUT row(s) to false (admin-declared)', v_backfilled;
END $$;
