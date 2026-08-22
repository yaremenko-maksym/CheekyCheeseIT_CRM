-- =============================================================================
-- invoice_signatures.voided_at / amount_snapshot / currency_snapshot (prod DDL, manual apply)
-- =============================================================================
--
-- STATUS (2026-08-22, PR #600): wired into .github/workflows/deploy.yml
-- (copy-step + fail-loud apply step, unconditional — same shape as every
-- sibling file in this directory). `.github/workflows/**` is normally
-- DevOps's zone-of-write, not Coder's — this edit exists only because
-- `scripts/devops/check-prod-ddl-wiring.py`'s CI gate hard-fails any new
-- manual DDL file that is neither wired nor explicitly listed as
-- KNOWN_NOT_WIRED (caught on this PR's first CI run), and the guard's own
-- error message names same-PR wiring as the DEFAULT for schema-changing
-- DDL — the same precedent PR #367 (squash 2f6c53e8) and #590/#587
-- established for every sibling file in this directory.
--
-- Context
-- -------
-- task-invoice-signature-integrity (backlog 183; task 4 of the
-- paid-transaction-edit-cascade decomposition,
-- docs/architecture/2026-08-22-paid-transaction-edit-cascade.md, L13/C3).
--
-- The invoice PDF is a legal artifact outside the system — a signature
-- attests to specific bytes and cannot be "corrected" by re-rendering.
-- Owner decision (2026-08-22): when a PAID transaction's amount is edited
-- and it already carries an invoice, that invoice is VOIDED wholesale (doc
-- soft-deleted, signatures retired, `transactions.invoice_document_id`
-- nulled) rather than silently re-rendered — a fresh invoice is generated
-- the next time the transaction (re-)reaches PAID, with the new amount.
--
-- Two additive changes on `invoice_signatures`:
--
-- 1. `voided_at` (nullable timestamptz) — stamped once, when the invoice a
--    row attests to is voided. Rows are NEVER deleted: "person X clicked
--    sign on file with hash H at time T" is a historical fact that stays
--    true forever and may be needed for a dispute — only the row's
--    *authority* over "is this transaction currently signed" is retired.
--    Because a transaction can now accumulate more than one HISTORICAL
--    signature per role across void → reissue → re-sign cycles, the OLD
--    blanket `UNIQUE (transaction_id, signer_role)` constraint (`uniq_sig`)
--    is replaced with a PARTIAL unique index scoped to `voided_at IS NULL`
--    — "one ACTIVE signature per role, unlimited history" — the same shape
--    as `uq_pending_obligations_source_pending` elsewhere in this schema.
--
-- 2. `amount_snapshot` / `currency_snapshot` (nullable numeric(18,6) /
--    currency) — populated ONLY on the COUNTERPARTY row, frozen verbatim
--    from what the FINAL rendered PDF actually contains at sign time (same
--    "store the immutable member, compute the mutable one" discipline as
--    `originalAmount`/`exchangeRate`, doc section C2). `GET
--    /invoices/:id/verify` (the public, unauthenticated QR endpoint) reads
--    THIS instead of the live `transactions.amount` — so a write that
--    bypasses the void path above (a bug, a future feature, a manual data
--    fix) still cannot surface a live, un-attested amount as "confirmed".
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`,
-- `CREATE UNIQUE INDEX IF NOT EXISTS`, the backfill (scoped to
-- `amount_snapshot IS NULL`) — safe to re-run on every deploy.
--
-- ROUND 2 (security-review, PR #600) — three fixes added to THIS SAME file
-- rather than a follow-up migration, since the backfill in particular can
-- only ever be correct in the SAME deploy this file first ships in (see its
-- own comment below for why):
--   1. The backfill at the bottom — the original version of this file added
--      `amount_snapshot` with no backfill, so `verifyInvoice` kept falling
--      back to the live `transactions.amount` for every row that was
--      already SIGNED when this shipped (HIGH-1).
--   2. The constraint-swap section reordered — CREATE the new partial index
--      BEFORE DROPping the old blanket constraint, plus a fail-loud check
--      that the drop actually removed a blanket unique constraint on these
--      two columns (MED-5).
-- (The third fix, MED-3 — write the snapshot in the same INSERT that
-- creates the COUNTERPARTY row instead of a follow-up UPDATE — lives in
-- `InvoicesService.signInvoice`, not here; noted for cross-reference only.)
--
-- ROUND 3 (security-review, PR #600, HIGH-2) — the backfill below EXCLUDES
-- `type = 'PAYOUT'` rows and the verify check is scoped the same way. See
-- the backfill's own comment for the full reasoning: for PAYOUT,
-- `tx.amount` is structurally a DIFFERENT number (the USDT payable) from
-- what was actually signed (the aggregated linked-income sum,
-- `InvoicesService.signInvoice`'s BIZ-05 branch) — backfilling it with
-- `tx.amount` would not recover a historical fact the way it does for
-- SALARY/SENIOR_INCOME, it would freeze a wrong number as "confirmed" and
-- make that wrong freeze indistinguishable from a real signature forever.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-22_invoice_signature_void_and_snapshot.sql
--
-- Wired into `.github/workflows/deploy.yml` in THIS SAME PR (copy step +
-- fail-loud apply step, both unconditional) — see the STATUS note above.
-- =============================================================================

-- ── Schema: new columns (nullable, no default) ──────────────────────────────
ALTER TABLE invoice_signatures
  ADD COLUMN IF NOT EXISTS voided_at timestamptz;

ALTER TABLE invoice_signatures
  ADD COLUMN IF NOT EXISTS amount_snapshot numeric(18, 6);

ALTER TABLE invoice_signatures
  ADD COLUMN IF NOT EXISTS currency_snapshot currency;

-- ── Constraint swap: blanket UNIQUE → partial UNIQUE (active rows only) ─────
-- MED-5 (security-review round 2, PR #600): CREATE INDEX now runs BEFORE
-- DROP CONSTRAINT (reverse of this file's original order) so the table is
-- NEVER without some uniqueness enforcement on (transaction_id,
-- signer_role): the old blanket constraint keeps guarding until the new
-- partial index exists, and if CREATE fails for any reason,
-- `-v ON_ERROR_STOP=1` aborts the whole script with the old constraint
-- still in place — never a "fail open" window.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_signatures_active
  ON invoice_signatures (transaction_id, signer_role)
  WHERE voided_at IS NULL;

ALTER TABLE invoice_signatures
  DROP CONSTRAINT IF EXISTS uniq_sig;

-- MED-5: fail loudly — not silently — if a blanket (non-partial) UNIQUE
-- constraint on exactly (transaction_id, signer_role) is STILL present
-- after the DROP above. This can only mean the live constraint's name has
-- drifted from `uniq_sig` (verified by hand at review time to match
-- exactly, but names drift over time) — checked by COLUMN SET, not by the
-- fixed name, so a healthy re-run of this same file (nothing blanket left
-- to find, by design, once the swap has genuinely succeeded once) never
-- re-raises. Left undetected, the very first re-sign after a void — a
-- legitimate SECOND row for the same (transaction_id, signer_role) — would
-- 23505 against the surviving blanket constraint, and ONLY on prod: CI
-- builds its schema fresh from schema.ts and never has the legacy
-- constraint to begin with.
DO $$
DECLARE
  leftover_name text;
BEGIN
  SELECT c.conname INTO leftover_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_index i ON i.indexrelid = c.conindid
  WHERE t.relname = 'invoice_signatures'
    AND c.contype = 'u'
    AND i.indpred IS NULL
    AND array_length(c.conkey, 1) = 2
    AND c.conkey::int[] <@ (
      SELECT array_agg(a.attnum)::int[]
      FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname IN ('transaction_id', 'signer_role')
    )
  LIMIT 1;

  IF leftover_name IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_signatures still has a blanket UNIQUE constraint "%" on (transaction_id, signer_role) after DROP CONSTRAINT IF EXISTS uniq_sig — the real constraint name has drifted from what this migration expects; update it before the partial-unique swap can be trusted', leftover_name;
  END IF;
END $$;

-- ── Backfill: existing SIGNED rows get a snapshot too (HIGH-1) ──────────────
-- security-review round 2 (PR #600): this file originally shipped WITHOUT
-- this backfill — `amount_snapshot` is populated only at sign time
-- (`InvoicesService.signInvoice`), so every row that was ALREADY an active
-- COUNTERPARTY signature when this migration first ran got
-- `amount_snapshot IS NULL` forever, and `verifyInvoice` keeps falling back
-- to the LIVE `transactions.amount` for exactly those rows — the one thing
-- AC3 requires it never do "independent of the AC2 choice".
--
-- Why this is safe and correct, not just convenient: the very reasoning the
-- live-fallback comment in `verifyInvoice` uses to justify itself — "no
-- divergence was possible before this migration shipped, because BIZ-18
-- blocked ALL PAID-amount edits unconditionally while these rows were
-- signed" — is EXACTLY what makes `tx.amount` today equal to what was
-- actually signed, for every existing active COUNTERPARTY row. Backfilling
-- with the live amount is not a guess here; it is recovering a fact that
-- was never allowed to diverge.
--
-- Why this CANNOT be a follow-up migration: the safety argument above holds
-- only up to the moment amount edits on PAID rows become possible (task 3,
-- shipping alongside this one). The FIRST live divergence closes the window
-- forever — a backfill run after that point would freeze the WRONG amount
-- as "confirmed" for whichever row raced ahead of it. This must apply in
-- the SAME deploy as the rest of this file.
--
-- security-review round 3 (PR #600, HIGH-2): `AND t.type <> 'PAYOUT'` below
-- — the safety argument two paragraphs up does NOT hold for PAYOUT rows.
-- `InvoicesService.signInvoice`'s BIZ-05 branch writes the COUNTERPARTY
-- snapshot for PAYOUT from the AGGREGATED linked-income sum, never from
-- `tx.amount` — `tx.amount` on a PAYOUT row is the payable in USDT, a
-- different number in a different currency BY CONSTRUCTION, not by a later
-- edit BIZ-18 happened to block. Backfilling a PAYOUT row with `tx.amount`
-- would not recover a historical fact; it would WRITE A WRONG ONE, and
-- because a non-NULL snapshot is exactly what this whole migration teaches
-- `verifyInvoice` to trust unconditionally, that wrong number would become
-- permanently indistinguishable from a real signature — closing the one
-- diagnostic signal (`amount_snapshot IS NULL` + the logger.warn below)
-- this same migration exists to introduce. Leaving PAYOUT rows NULL changes
-- nothing a user can see today: `verifyInvoice`'s existing live-tx.amount
-- fallback already returns the identical number it always has for them.
--
-- Idempotent: scoped to `amount_snapshot IS NULL` — a second run (or a run
-- against a DB where every row was already signed after this shipped)
-- finds zero targets. Wrapped in its own transaction with a fail-loud
-- verify (STEP pattern matches the other backfills in this directory,
-- e.g. `2026-08-12_admin_income_drop_backfill_apply.sql`) so a partial
-- backfill can never silently reach a "success" exit code. The verify
-- check below is scoped to exclude PAYOUT for the same HIGH-2 reason as the
-- UPDATE — without that, it would RAISE EXCEPTION on the very rows this
-- backfill now deliberately leaves NULL, aborting Step 2af in
-- `.github/workflows/deploy.yml` on prod.
BEGIN;

UPDATE invoice_signatures s
   SET amount_snapshot   = t.amount,
       currency_snapshot = t.currency
  FROM transactions t
 WHERE t.id = s.transaction_id
   AND s.signer_role = 'COUNTERPARTY'
   AND s.voided_at IS NULL
   AND s.amount_snapshot IS NULL
   AND t.type <> 'PAYOUT';

DO $$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM invoice_signatures s
  JOIN transactions t ON t.id = s.transaction_id
  WHERE s.signer_role = 'COUNTERPARTY'
    AND s.voided_at IS NULL
    AND s.amount_snapshot IS NULL
    AND t.type <> 'PAYOUT';

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'invoice-signature-void-and-snapshot backfill FAILED verify: % active non-PAYOUT COUNTERPARTY row(s) still have NULL amount_snapshot — verifyInvoice would still fall back to the live amount for them', v_remaining;
  END IF;

  RAISE NOTICE 'invoice-signature-void-and-snapshot backfill: verify passed — 0 active non-PAYOUT COUNTERPARTY signature(s) with NULL amount_snapshot remain (PAYOUT rows intentionally left NULL — see the backfill comment above, HIGH-2)';
END $$;

COMMIT;
