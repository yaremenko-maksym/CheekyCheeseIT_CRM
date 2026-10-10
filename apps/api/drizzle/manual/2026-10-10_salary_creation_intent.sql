-- Manual salary idempotency keys must identify one immutable request meaning.
-- Nullable preserves historical rows; those rows are deliberately treated as
-- unverifiable legacy retries by the API rather than guessed/backfilled.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS salary_creation_intent jsonb;

-- The public non-deleted view is SELECT * and PostgreSQL freezes its column
-- list at CREATE time, so refresh it after appending the physical column.
CREATE OR REPLACE VIEW non_deleted_transactions AS
SELECT * FROM transactions WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION reject_salary_creation_intent_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.salary_creation_intent IS DISTINCT FROM NEW.salary_creation_intent THEN
    RAISE EXCEPTION 'salary_creation_intent is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_transactions_salary_creation_intent_immutable ON transactions;
CREATE TRIGGER trg_transactions_salary_creation_intent_immutable
BEFORE UPDATE OF salary_creation_intent ON transactions
FOR EACH ROW
EXECUTE FUNCTION reject_salary_creation_intent_update();
