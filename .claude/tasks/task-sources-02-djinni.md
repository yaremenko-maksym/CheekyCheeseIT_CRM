# task-sources-02-djinni — Djinni postings are stored (employer withheld at the source)

## Agent: coder
## Status: ready (dispatch when a wave-1 slot frees; rebase on WWR PR if it merged first)
## Model: claude-opus-5 medium (jev T2 0.95); security-reviewer on the PR (data contract)
## Branch: feat/sources-02-djinni-employer-withheld
## Source: `~/.claude/handoffs/sources-connect-2026-11-19/task-02-djinni-employer-withheld.md`

## Context
- Prod: `djinni.rss.python`, `djinni.rss.rust`: 77 runs, HTTP 200, `received 0`, nothing stored.
- Cause: Djinni RSS has no employer field (withheld until a candidate applies). Adapter
  `apps/api/src/job-sourcing/providers/sources/djinni.provider.ts` sets `companyName: null`;
  `apps/api/src/job-sourcing/normalize/observation.ts:279` quarantines `MISSING_COMPANY`.
- Storage facts (check before designing): `job_opportunities.employer_name` / `employer_key` are
  already nullable and there is `employer_verified` (`apps/api/src/database/schema/job-opportunities.ts:266`).
  Legacy `job_postings.company_name` is NOT NULL (`schema/job-sourcing.ts:431`). Find where the
  reporting ledger persists observations and whether its company column is nullable. Prefer a
  representation that needs no DDL; if DDL is unavoidable, follow manual-staged rules and stop to
  report before writing it.
- Owner 2026-11-19: Djinni is trusted, MUST work; an anonymous posting IS worth a senior's
  attention (answers backlog 309's owner question).
- Backlog 309 in `.claude/tasks/BACKLOG-followups.md`.

## Design (A1, decided; escalate only if it touches RBAC or money)
- "Employer withheld at the source" is a third explicit state, distinct from present and
  failed-to-parse. Never a guess, never the string "Djinni".
- Only a source type that declares "employer withheld by design" (manifest/adapter capability) may
  produce it. `MISSING_COMPANY` stays a quarantine for every other adapter.
- Dedup: when another source names the same posting with an employer, the disclosed employer wins.
- Per-senior company exclusions vs unknown employer: not excluded by a company rule; keyword
  exclusions still apply. UI shows the employer as not disclosed.
- Relevance and suggestions: same path as any posting.

## Acceptance criteria
1. A Djinni-shaped item produces a stored posting whose employer is explicitly "withheld at the
   source"; other adapters still quarantine a missing employer (test both).
2. Dedup and exclusion behave as decided above, with tests.
3. UI shows "employer not disclosed" in `uk` + `en` (Lingui macros, `i18n:extract`), existing
   component, no new design.
4. No DDL, or DDL via manual-staged rules after reporting to Master.
5. (Master, after deploy) Djinni runs store postings (created > 0); backlog 309 narrowed/closed.

## Assumptions
- (A1) Design block above.

## Master note (2026-11-19, after WWR PR #1428)
- Prod `job_sources.namespace` is '' for both enabled DJINNI_RSS rows (also WWR x2, DOU x1). WWR's 0-stored
  cause was `normalizeNamespace('')` -> null -> `INVALID_NAMESPACE` quarantine. Djinni items will hit the same
  quarantine once `MISSING_COMPANY` is solved: check it before claiming AC 5 can pass.
