-- =============================================================================
-- transactions.sender_label / receiver_label — company account as a CODE
-- (server-text PR3, docs/superpowers/plans/2026-10-03-crm-i18n-server-user-facing-text.md)
-- =============================================================================
--
-- Context
-- -------
-- When the shared company account is a party to a transaction, the server used
-- to store the Russian prose "Счёт компании" in `sender_label` / `receiver_label`
-- (COMPANY_DEPOSIT receiver, DIVIDEND_TO_ADMIN sender, company-funded EXPENSE /
-- SALARY sender). The localized (uk/en) web rendered it verbatim — a Russian
-- string on a migrated surface. From this PR on the server writes the stable
-- CODE 'COMPANY' (`COMPANY_ACCOUNT_LABEL` in @crm/shared) and the web maps it to
-- the viewer-locale text through the Lingui catalog. This migration converges the
-- rows written BEFORE the code switch onto the same code.
--
-- Prod measurement (read-only, db=crm_db, before this PR): 0 rows carried the
-- prose marker (and 0 COMPANY_DEPOSIT / DIVIDEND_TO_ADMIN rows exist at all), so
-- on prod today this is an idempotent NO-OP GUARD. It is kept anyway: rows can
-- still be booked with the old prose between the old image and this deploy, and
-- the guard makes the acceptance criterion ("no row stores the prose marker")
-- checkable by the fail-loud assertion below instead of by assumption.
--
-- Idempotency
-- -----------
-- deploy.yml applies every manual/*.sql file on EVERY deploy (there is no
-- applied-migrations registry). Both UPDATEs are keyed on the OLD value, so a
-- re-run matches zero rows and changes nothing. The trailing DO block is read-
-- only and raises only if a row with the prose marker is still present.
--
-- Two-phase rollout (RBAC sentinel)
-- ---------------------------------
-- `TransactionsService.isInternalCompanySide` (the masking sentinel for
-- non-privileged viewers) keeps accepting BOTH markers. Phase 1 = this PR: code
-- written, both accepted, rows migrated here. Phase 2 = a follow-up PR that
-- drops the legacy prose arm from the sentinel, ONLY after the owner confirms
-- this migration ran in prod. Dropping the arm earlier would unmask any prose row
-- the migration had not reached yet.
--
-- Scope: only `transactions`. `transaction_audit_log` snapshots are history and
-- stay as written (they are read for audit, never rendered as a counterparty).
-- `updated_at` is deliberately NOT touched — normalizing a stored token is not an
-- edit by a user and must not reorder «last modified» views.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-10-03_company_account_label_code.sql
--
-- Wired into .github/workflows/deploy.yml (rollback-preflight file list, SCP copy
-- step, psql apply step) in this SAME PR. `scripts/devops/check-prod-ddl-wiring.py`
-- verifies both the COPY and the APPLY step exist.
--
-- Data risk: none beyond the intended rewrite — two string values of one token,
-- no row deleted, no amount / status / id touched. No query below returns any row
-- CONTENT: counts only, no personal data is read or printed.
-- =============================================================================

UPDATE transactions
   SET sender_label = 'COMPANY'
 WHERE sender_label = 'Счёт компании';

UPDATE transactions
   SET receiver_label = 'COMPANY'
 WHERE receiver_label = 'Счёт компании';

-- Fail loud: the acceptance criterion is "no row stores the prose marker".
DO $$
DECLARE
  leftover bigint;
BEGIN
  SELECT count(*) INTO leftover
    FROM transactions
   WHERE sender_label = 'Счёт компании' OR receiver_label = 'Счёт компании';
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'company-account label migration incomplete: % row(s) still carry the prose marker', leftover;
  END IF;
END $$;

-- =============================================================================
-- VERIFY (after applying), counts only:
--   SELECT count(*) FROM transactions
--    WHERE sender_label = 'Счёт компании' OR receiver_label = 'Счёт компании';
--   -- Expected: 0.
--   SELECT count(*) FROM transactions
--    WHERE sender_label = 'COMPANY' OR receiver_label = 'COMPANY';
-- =============================================================================
