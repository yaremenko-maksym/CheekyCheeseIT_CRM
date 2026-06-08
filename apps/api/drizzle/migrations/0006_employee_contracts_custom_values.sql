ALTER TABLE "employee_contracts"
  ADD COLUMN IF NOT EXISTS "custom_values" jsonb NOT NULL DEFAULT '{}'::jsonb;
