-- =============================================================================
-- invoice_signatures.voided_at / amount_snapshot / currency_snapshot (prod DDL, manual apply)
-- =============================================================================
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
-- `CREATE UNIQUE INDEX IF NOT EXISTS` — safe to re-run on every deploy.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-22_invoice_signature_void_and_snapshot.sql
--
-- NOT wired into `.github/workflows/deploy.yml` by this PR — `.github/
-- workflows/**` is DevOps's zone-of-write (see
-- .claude/rules/common/zone-of-write.md), and this task's brief did not
-- carry the explicit reviewed exception PR #590's migration documented for
-- itself. Needs a DevOps follow-up (guarded copy + fail-loud apply step,
-- same shape as every other file in this directory) before this ships to
-- prod. Flagged in the PR body.
-- =============================================================================

-- ── Schema: new columns (nullable, no default) ──────────────────────────────
ALTER TABLE invoice_signatures
  ADD COLUMN IF NOT EXISTS voided_at timestamptz;

ALTER TABLE invoice_signatures
  ADD COLUMN IF NOT EXISTS amount_snapshot numeric(18, 6);

ALTER TABLE invoice_signatures
  ADD COLUMN IF NOT EXISTS currency_snapshot currency;

-- ── Constraint swap: blanket UNIQUE → partial UNIQUE (active rows only) ─────
ALTER TABLE invoice_signatures
  DROP CONSTRAINT IF EXISTS uniq_sig;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_signatures_active
  ON invoice_signatures (transaction_id, signer_role)
  WHERE voided_at IS NULL;
