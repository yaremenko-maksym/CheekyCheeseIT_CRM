-- AC9: Remove "Версія N — YYYY-MM-DD" header lines from contract_templates.
-- signed_contracts.body_markdown_snapshot is intentionally NOT touched
-- (immutable legal snapshots).
UPDATE "contract_templates"
SET "body_markdown" = regexp_replace(
  "body_markdown",
  E'Версія\\s+\\S+\\s+—\\s+\\S+\\n\\n',
  '',
  'g'
)
WHERE "body_markdown" ~ E'Версія';
