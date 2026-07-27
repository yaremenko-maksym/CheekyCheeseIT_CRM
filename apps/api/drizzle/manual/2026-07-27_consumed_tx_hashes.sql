-- =============================================================================
-- On-chain payment integrity — prod DDL (manual apply)
--   1. consumed_tx_hashes  — cross-path registry (one transfer settles once)
--   2. tx_from_address     — recorded on-chain sender (audit) on
--                            payout_requests + transactions
-- =============================================================================
--
-- Context — part 1 (consumed_tx_hashes)
-- -------------------------------------
-- task-onchain-payment-integrity (HOLE 2). One real USDT transfer could credit
-- the company account TWICE, because the two money paths guarded hash re-use in
-- DIFFERENT tables and were blind to each other:
--
--   • payPayoutRequest / manualConfirmPayout → scanned `payout_requests`
--     (backstop: partial index uq_payout_requests_txhash_paid)
--   • submitDeposit                          → scanned `transactions`
--     (backstop: partial index uq_transactions_company_deposit_tx_hash,
--      WHERE type='COMPANY_DEPOSIT' — a PAYOUT row with the same hash is
--      OUTSIDE the predicate, so it never collided)
--
-- `computeCompanyAccountBalanceFromLedger` sums BOTH terms → the same transfer
-- was counted twice, inflating the balance that gates salaries, expenses and
-- dividends. This table is the single registry both paths now claim from,
-- INSIDE the same DB transaction that performs the credit.
--
-- Only REAL on-chain hashes (0x + 64 hex) are registered. Synthetic audit
-- markers (`0xSIM…` dev-simulate, `0xMANUAL…` off-chain confirmation) reference
-- no chain transfer and are unique by construction — they are skipped by
-- `normalizeOnChainTxHash` (apps/api/src/finance/onchain-tx.ts).
--
-- The dev database gets this via `pnpm --filter @crm/api db:push` (drizzle-kit
-- push). The prod image does NOT ship drizzle-kit, so prod is migrated with
-- THIS script.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-27_consumed_tx_hashes.sql
--
-- DEPENDENCY (DevOps): add this file to the SCP `source:` list AND to Step 2b of
-- .github/workflows/deploy.yml, applied BEFORE the new image serves traffic.
-- Without that wiring the new image starts writing to a table that does not
-- exist in prod → 500 on every payout/deposit (same class of gap as the
-- 2026-07-25 vacancy-i18n prod-500). DevOps owns that wiring; this PR ships the
-- script + the note only.
--
-- Context — part 2 (tx_from_address)
-- ----------------------------------
-- The verifier fetched the on-chain `from` and never read it, so nobody could
-- tell WHO actually paid. It is now extracted (ERC-20 `topics[1]`, tx-level
-- `from` as fallback) and recorded on the settling row. Deliberately NOT a
-- gate: staff often withdraw straight from an exchange, whose hot wallet would
-- be the sender — blocking on it would reject honest payments. The API returns
-- it to ADMIN/ACCOUNTANT only.
--
-- Idempotent: CREATE TABLE/INDEX/COLUMN IF NOT EXISTS + backfill with
-- ON CONFLICT DO NOTHING — safe to re-run.
-- =============================================================================

-- 1. The registry itself. `purpose` is a plain varchar (not an enum): it is an
--    audit label, and a new money path must not require an enum migration.
--    reference_id is deliberately NOT an FK — the registry must OUTLIVE its
--    referent (deleting a payout must never free its hash for re-use).
CREATE TABLE IF NOT EXISTS consumed_tx_hashes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash             varchar(66) NOT NULL,
  purpose             varchar(32) NOT NULL,
  reference_id        uuid,
  consumed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- 2. THE cross-path guard. Total (not partial): every registered row is a real
--    on-chain transfer, whichever path consumed it. Hashes are stored
--    lowercase-normalised by the app, so `0xAB…` and `0xab…` collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_consumed_tx_hashes_tx_hash
  ON consumed_tx_hashes (tx_hash);

-- 3. BACKFILL — historical settlements must already own their hashes, otherwise
--    an old PAID payout's hash could still be replayed as a fresh deposit (and
--    vice-versa) on the day this ships.
--
--    Payouts first (the older/primary money path), deposits second: on a hash
--    present in BOTH (i.e. an ALREADY double-credited transfer — see the audit
--    query at the bottom) the payout row wins and the deposit is skipped by
--    ON CONFLICT. Nothing is deleted or re-credited here: this script only
--    stops FUTURE double-spends; any pre-existing duplicate is a data question
--    for the owner, surfaced by the NOTICE below.
INSERT INTO consumed_tx_hashes (tx_hash, purpose, reference_id, consumed_by_user_id)
SELECT DISTINCT ON (lower(pr.tx_hash))
       lower(pr.tx_hash), 'PAYOUT', pr.id, pr.senior_id
  FROM payout_requests pr
 WHERE pr.status = 'PAID'
   AND pr.tx_hash ~* '^0x[0-9a-f]{64}$'
 ORDER BY lower(pr.tx_hash), pr.updated_at ASC
ON CONFLICT (tx_hash) DO NOTHING;

--    DEPOSITS: `status = 'PAID'` is REQUIRED, not cosmetic symmetry with the
--    payout filter above (security-review round 2, HIGH-4). A claim accompanies
--    MONEY, never an intent — the same rule the application follows since
--    `submitDeposit` began claiming only when it actually credits. Back-filling
--    a PENDING deposit would:
--      (a) BRICK it. `consumeTxHash` is a bare INSERT (deliberately — a loud
--          23505 is the guard), so when the tx later confirms,
--          `getDepositStatus` would flip → claim → 23505 → roll back the whole
--          flip. The deposit stays PENDING FOREVER, its money invisible in the
--          balance, with no way out: re-submitting returns the same PENDING row
--          by idempotency.
--      (b) RE-OPEN GRIEFING. A pre-migration PENDING deposit carrying somebody
--          else's hash would burn that transfer globally — the real payer gets
--          «хеш уже использован» on both `payPayoutRequest` AND the
--          ADMIN/ACCOUNTANT manual-confirm escape hatch.
--    With this filter a PENDING deposit is claimed by its own `getDepositStatus`
--    at the moment it is actually credited.
INSERT INTO consumed_tx_hashes (tx_hash, purpose, reference_id, consumed_by_user_id)
SELECT DISTINCT ON (lower(t.tx_hash))
       lower(t.tx_hash), 'COMPANY_DEPOSIT', t.id, t.sender_id
  FROM transactions t
 WHERE t.type = 'COMPANY_DEPOSIT'
   AND t.status = 'PAID'
   AND t.tx_hash ~* '^0x[0-9a-f]{64}$'
 ORDER BY lower(t.tx_hash), t.created_at ASC
ON CONFLICT (tx_hash) DO NOTHING;

--    ADMIN_INCOME: the third crediting term (security-review rounds 2-3). Same
--    money rule — only rows that actually credit the shared pool
--    (funding_source='COMPANY_ACCOUNT'), and only when their explorer receipt
--    carries a real hash. Historic rows whose receipt links carry no hash
--    legitimately claim nothing.
INSERT INTO consumed_tx_hashes (tx_hash, purpose, reference_id, consumed_by_user_id)
SELECT DISTINCT ON (lower(m.tx_hash))
       lower(m.tx_hash), 'ADMIN_INCOME', m.id, m.created_by
  FROM (
        SELECT t.id,
               t.created_by,
               t.created_at,
               (regexp_match(t.receipt_external_url, '0x[0-9a-fA-F]{64}'))[1] AS tx_hash
          FROM transactions t
         WHERE t.type = 'ADMIN_INCOME'
           AND t.status = 'PAID'
           AND t.funding_source = 'COMPANY_ACCOUNT'
           -- MED-B: the balance term carries a currency guard on EVERY term
           -- (BIZ-23 defence-in-depth). Mirror it exactly — a non-USDT row does
           -- not credit the pool, so its transfer must not be burned.
           AND t.currency = 'USDT'
           AND t.receipt_external_url IS NOT NULL
       ) m
 WHERE m.tx_hash IS NOT NULL
 ORDER BY lower(m.tx_hash), m.created_at ASC
ON CONFLICT (tx_hash) DO NOTHING;

-- 4. AUDIT NOTICE — report (do NOT fail on) hashes that were ALREADY consumed
--    by MORE THAN ONE crediting path before this fix. Each one is a real
--    transfer that credited the company balance twice; the owner decides how to
--    correct the ledger.
--
--    MED-C: all THREE crediting terms participate (payout / deposit /
--    admin-income). Leaving admin-income out would hide exactly the pair HIGH-3
--    made possible — an honestly registered client inflow re-credited as a
--    deposit — from the deploy log, which is the one place an operator looks.
DO $$
DECLARE
  dup_count integer;
BEGIN
  WITH claimed AS (
    SELECT lower(pr.tx_hash) AS h, 'PAYOUT' AS src
      FROM payout_requests pr
     WHERE pr.status = 'PAID' AND pr.tx_hash ~* '^0x[0-9a-f]{64}$'
    UNION ALL
    SELECT lower(t.tx_hash), 'COMPANY_DEPOSIT'
      FROM transactions t
     WHERE t.type = 'COMPANY_DEPOSIT'
       AND t.status = 'PAID'
       AND t.tx_hash ~* '^0x[0-9a-f]{64}$'
    UNION ALL
    SELECT lower((regexp_match(t.receipt_external_url, '0x[0-9a-fA-F]{64}'))[1]), 'ADMIN_INCOME'
      FROM transactions t
     WHERE t.type = 'ADMIN_INCOME'
       AND t.status = 'PAID'
       AND t.funding_source = 'COMPANY_ACCOUNT'
       AND t.currency = 'USDT'
       AND t.receipt_external_url ~* '0x[0-9a-f]{64}'
  )
  SELECT count(*) INTO dup_count
    FROM (
      SELECT h FROM claimed WHERE h IS NOT NULL GROUP BY h HAVING count(DISTINCT src) > 1
    ) AS multi_path;

  IF dup_count > 0 THEN
    RAISE WARNING
      'consumed_tx_hashes backfill: % on-chain hash(es) were consumed by MORE THAN ONE crediting path (payout / deposit / admin-income) — the company balance is inflated by those transfers. Run the audit query in this script and report to the owner.',
      dup_count;
  ELSE
    RAISE NOTICE 'consumed_tx_hashes backfill: no cross-path duplicate hashes found.';
  END IF;
END $$;

-- 5. Recorded on-chain SENDER (audit). Nullable, no backfill possible: historic
--    settlements never captured it, and re-deriving would need a chain replay.
--    Existing rows legitimately stay NULL ("unknown, predates the recording").
ALTER TABLE payout_requests
  ADD COLUMN IF NOT EXISTS tx_from_address varchar(42);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS tx_from_address varchar(42);

-- =============================================================================
-- VERIFY (after applying):
--   SELECT to_regclass('public.consumed_tx_hashes');            -- not null
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name IN ('payout_requests','transactions')
--      AND column_name = 'tx_from_address';                     -- 2 rows
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'consumed_tx_hashes';                    -- uq_… present
--   SELECT purpose, count(*) FROM consumed_tx_hashes GROUP BY 1;
--
-- AUDIT (pre-existing double credits, if the WARNING above fired):
--   SELECT lower(pr.tx_hash) AS tx_hash, pr.id AS payout_id, t.id AS deposit_tx_id
--     FROM payout_requests pr
--     JOIN transactions t
--       ON lower(t.tx_hash) = lower(pr.tx_hash)
--      AND t.type = 'COMPANY_DEPOSIT'
--    WHERE pr.status = 'PAID'
--      AND pr.tx_hash ~* '^0x[0-9a-f]{64}$';
-- =============================================================================
--
-- Rollback (feature-level):
--   DROP TABLE IF EXISTS consumed_tx_hashes;
--   ALTER TABLE payout_requests DROP COLUMN IF EXISTS tx_from_address;
--   ALTER TABLE transactions    DROP COLUMN IF EXISTS tx_from_address;
--   -- Safe: the table is write-only bookkeeping; no other table references it.
--   -- NOTE: rolling back re-opens the cross-path double-credit hole and drops
--   -- the recorded senders (they cannot be re-derived without a chain replay).
-- =============================================================================
