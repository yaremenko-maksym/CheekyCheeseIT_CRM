-- =============================================================================
-- Drop-share pending-parity — PRE-COUNT (standalone, READ-ONLY, no writes)
-- =============================================================================
--
-- security-review PR #443 (MED-A, second review round). The owner was told
-- "we'll see the volume before transferring anything" — that promise only
-- holds if the count is a genuinely SEPARATE step a human can look at and
-- act on BEFORE the conversion runs, not just a `RAISE NOTICE` printed
-- inside the SAME apply that has already committed by the time anyone reads
-- the log. THIS file is that separate step: it is 100% read-only (no
-- CREATE/INSERT/UPDATE of any kind) and is applied on its own, BEFORE
-- `2026-07-27_drop_share_pending_parity_backfill.sql`.
--
-- Deploy sequencing (DevOps owns the wiring in `.github/workflows/deploy.yml`):
--   1. Apply `2026-07-27_drop_cascade_origin_marker.sql` (schema: new column).
--   2. Apply THIS file → read the RAISE NOTICE output in the deploy log →
--      OWNER decides whether to proceed (if the count is non-zero, drop
--      balances will visibly dip until each row is settled — see the
--      backfill file's header for the full reasoning).
--   3. Only THEN apply `2026-07-27_drop_share_pending_parity_backfill.sql`
--      (the actual conversion — separate file, separate step, gated on the
--      owner's go-ahead from step 2, not auto-chained).
--
-- Predicate mirrors the backfill's selection EXACTLY (including the
-- self-loop exclusion — see that file's header for why self-loop rows are
-- excluded from conversion) so this count is not just informative but
-- PRECISELY predicts what the next step would do.
--
-- Run standalone:
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-27_drop_share_pending_parity_precount.sql
-- =============================================================================

DO $$
DECLARE
  v_total integer;
  v_amount numeric;
  v_self_loop integer;
  v_convertible integer;
BEGIN
  SELECT count(*), COALESCE(sum(amount::numeric), 0)
    INTO v_total, v_amount
  FROM transactions
  WHERE type = 'PAYOUT_DROP' AND status = 'PAID' AND payout_request_id IS NOT NULL;

  SELECT count(*) INTO v_self_loop
  FROM transactions
  WHERE type = 'PAYOUT_DROP'
    AND status = 'PAID'
    AND payout_request_id IS NOT NULL
    AND sender_id = receiver_id;

  v_convertible := v_total - v_self_loop;

  RAISE NOTICE 'drop-share-pending-parity PRE-COUNT (read-only, no writes yet): % Path-B row(s) total, amount %, of which % self-loop (will stay EXCLUDED) — % row(s) WOULD be converted if the backfill file is applied next',
    v_total, v_amount, v_self_loop, v_convertible;
END $$;
