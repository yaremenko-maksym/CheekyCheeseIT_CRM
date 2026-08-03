# Progress: task-file-storage-hardening

## Status: security-review round 3 — Verdict APPROVE + 4 follow-ups closed + owner's resubmission-update decision shipped

- PR: https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/462
- Branch: `fix/file-storage-hardening` (worked from local `fix/file-storage-hardening-cont`,
  same remote ref)
- HEAD: `0e8d5be6`
- CI guard: green (`gh pr checks 462 --watch` — guard-test, Typecheck·Lint·Unit Tests,
  Integration Tests (Postgres), all 7 E2E shards, check-formatting all pass) — re-confirmed on
  this round's final SHA.

## Round 3 (review 4841218765, Verdict: APPROVE — round 2 fully accepted, 4 follow-ups + owner decision below)

- Owner decision: resubmission within 24h now UPDATES the existing application row in place
  (new resume/size/cover-letter/reset-time) instead of the round-1 MED-4 silent no-op —
  reverses my own (flagged, not owner's) product call. `updateDuplicateApplication`: upload
  new → `deleteOrThrow` old (throwing, before the row is touched, compensates by deleting the
  new file on failure) → update row. Real-backend integration proof added (real Postgres +
  the stub-S3's actual in-memory object store) alongside mocked-unit coverage.
- MED-1: `logAccess` now attributes `actor.impersonatorId ?? actor.id` (was `actor.id` alone)
  — matches the convention every other audit trail in this codebase uses. New impersonation
  test.
- MED-2: round-2's flat 150-350ms mimicry delay was WRONG (genuine-minimal-PDF path runs in
  ~60-150ms per the reviewer's own measurement — below, not above, the round-2 floor; the
  channel inverted, didn't close). Reworked to a single SHARED deadline (500ms + up to 150ms
  jitter, picked once per request) applied identically at all 3 return points
  (honeypot/duplicate-update/genuine-new) — branch-agnostic by construction. Honestly
  documented as still-partial (rate limit + Turnstile + probe noise are what actually make
  large-scale probing impractical).
- MED-3: left as-is at my discretion (owner explicitly allowed) — one-time Cache-Control
  backfill for pre-§3 objects not implemented this round; risk stays bounded to legacy
  objects, GET-time override already closes the active exposure.
- MED-4: merged `origin/main` (PR #456 replaced raw `transactions` with the
  `nonDeletedTransactions` VIEW in `documents.service.ts`) — resolved the import-block
  conflict by UNION, keeping the VIEW-based import, not reverting to the raw table. Rebuilt
  stale `@crm/shared` dist (unrelated false-positive typecheck errors, not a merge problem).
- LOW: corrected the round-2 PR-body wording — of the 5 new
  `documents-team-scope.integration.spec.ts` test cases, only the archived-project one is a
  genuine RED→GREEN regression proof; the other 4 are regression coverage of already-correct
  behavior. Corrected in place, not left standing next to the original claim.
- Process note: caught a REAL test interaction (not a flake) via isolated stash-diff — my new
  resubmission-update integration tests shared the main `app` instance's throttle bucket with
  AC6/AC10, tripping `VACANCY_APPLY_LIMIT=5` and 429-ing AC10. Fixed by giving the new describe
  block its own `NestFastifyApplication` instance, mirroring the established F2/AC8 pattern.

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

## Quality gates (round 3 final)

- `@crm/api` unit: 2086/2086 passed
- `@crm/api` integration (`crm_qa`): 1039/1039 passed
- typecheck/lint: clean on every touched file (ESLint MCP, 0 warnings/errors)

## Next

Awaiting round-4 review (if any) or owner sign-off/merge. All previously-flagged product
decisions are now resolved by the owner directly (accountant matrix note recorded round 2;
resubmission-update decided and shipped round 3).
