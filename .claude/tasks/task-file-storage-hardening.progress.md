# Progress: task-file-storage-hardening

## Status: security-review round 2 — all findings closed, PR #462 ready for next review pass

- PR: https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/462
- Branch: `fix/file-storage-hardening` (worked from local `fix/file-storage-hardening-cont`,
  same remote ref)
- HEAD: `3a955d69`
- CI guard: green (`gh pr checks 462 --watch` — guard-test, Typecheck·Lint·Unit Tests,
  Integration Tests (Postgres), all 7 E2E shards, check-formatting all pass)

## Round 2 (review 4840330975, Verdict: BLOCK) — closed

- HIGH-1 (migration wiring): stale finding — reviewer was 16 commits behind main; PR #463
  already landed the migration wiring; branch fast-forwarded onto `origin/fix/file-storage-hardening`.
- Ownership model: accepted as-is by reviewer, no action.
- ACCOUNTANT transaction-scoping (round-1 MED-1): REVERTED per owner decision 2026-08-03 —
  self-satisfying criterion + broke onboarding (5/21 users had any transaction). ACCOUNTANT
  now sees ALL scans unconditionally again. Recorded explicitly in
  `docs/business/modules/documents.md` so future audits don't reopen it.
- HIGH-2 (docs/business/modules/documents.md stale): fully rewritten to match final code
  (two-stage team+project transitive predicate, archived-project exclusion, real ACCOUNTANT
  justification).
- MED archived-project exclusion: `getTeammateIds` now filters `projects.archivedAt IS NULL`
  explicitly (leftAt alone unreliable post-unarchive). RED→GREEN proved against real Postgres.
- MED live cache-header verification: proved live against local MinIO (real PUT with stale
  header → presigned GET with override → real HTTP GET → 200 + override header wins).
  R2-prod not independently verified (no prod creds) — documented as residual, high-confidence-
  not-100%-verified in PR body + code comment.
- MED timing side-channel: partial cheap mitigation shipped (150-350ms randomized delay on
  honeypot/duplicate mimicked-success branches, grounded in a real compress+upload
  measurement). Documented as NOT a perfect fix (residual: attacker-controlled file size +
  real network variance still leaks some signal with enough samples).
- MED silent-duplicate-loss: documented explicitly in PR body as MY product decision (round 1,
  not owner's) that needs owner sign-off — not silently treated as closed.
  documents-team-scope.integration.spec.ts rewritten: MED-1 remnants (OWNER_WITH_TX/
  OWNER_NO_TX/TX_ID) removed and replaced with one unconditional-ACCOUNTANT test; added
  archived-project, former-member, no-team-senior, DROP-actor, and direct
  SENIOR-vs-different-project-junior coverage; header rewritten to match actual coverage.
- LOW fixture provenance: documented as an accepted time-boxed trade-off in the spec's header
  comment (not silently skipped), full service-call retrofit out of scope for this round.

## Quality gates (round 2 final)

- `@crm/api` unit: 2062/2062 passed
- `@crm/api` integration (`crm_qa`): 995/995 passed
- typecheck/lint: clean on every touched file (ESLint MCP, 0 warnings/errors)

## Next

Awaiting round-3 review or owner sign-off on the two flagged product decisions (accountant
matrix note — already recorded; silent-duplicate-loss — flagged in PR body for owner).
