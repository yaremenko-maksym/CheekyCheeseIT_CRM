---
name: security-review
description: 'Project-local security-review for the CRM: recurring classes of leaks that a generic OWASP checklist does not catch — a NO-OP RolesGuard, RBAC in the service body, denylist masking, mocked-E2E over global guards, prod-DDL without SSH, tokens in CI. A DELTA on top of the OWASP/secrets/npm-audit in security-reviewer.md — it does not duplicate them. Each pattern is confirmed by a real incident with a PR number.'
when_to_use: "Use when a PR touches auth / RBAC / finance / wallets / transactions / company-account, or when a Coder is about to write an endpoint or DTO on those paths. Examples: 'PR touches finance — what to check', 'adding a field to the profile, who will see it', 'a new junior-facing screen reuses a DTO', 'endpoint behind a global guard', 'need to apply DDL on prod', 'review of CI/workflow with tokens'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__ast-grep__find_code
  - mcp__postgres__query
  - mcp__github__get_pull_request_files
---

# Security review — the project delta (CRM)

**This is NOT a replacement** for OWASP Top 10 / secrets-detection / npm audit — they are already spelled out
step by step in `.claude/agents/security-reviewer.md` (Steps 2-4). Here — only those
classes on which the project **actually got burned**, and which the generic checklist misses.
Each pattern cites an incident: if you doubt that it matters — open it.

## When to invoke

- security-reviewer: on EVERY dispatch (the PR touches auth / finance / RBAC / wallets / transactions / company-account).
- Coder: BEFORE writing an endpoint / DTO / masking on these paths — cheaper than a round-trip review.
- code-reviewer: only to understand whether a separate security-reviewer is needed. Findings on these classes — his zone, not yours.

---

## Patterns

### 1. `RolesGuard` — NO-OP without `@Roles()`

`JwtAuthGuard` is **global** (`APP_GUARD` in `app.module.ts`) — every route is
authenticated unless there is a `@Public()`. But `RolesGuard` is opt-in and **protects
nothing on its own**: `@UseGuards(RolesGuard)` without `@Roles(...)` = a dud.

You see `@UseGuards(RolesGuard)` — look for `@Roles(...)` next to it. It is absent → the route is open
to everyone authenticated, regardless of how convincing the decorator looks.

**Incident:** RBAC-sweep of 21 controllers (2026-06-10) — 3 clusters of leaks: #159
(HR cross-team write-IDOR on projects create/update/addMember), #160 (HR sees
all company salaries + IDOR in payout-request getById), #161 (over-projection in
`buildProfileView`).

### 2. RBAC lives in the service body — the controller does not show the truth

A significant part of authorization in this project is inside service methods
(`svc.method(user)`), not in decorators. **You cannot judge a leak by the controller.**
Open the service body and look at what the filtering by
`viewer` actually does.

Review practice: for each affected endpoint — "who is looking → whose data
they see", as an explicit line. The role matrix is too complex to keep in your head:
five roles (`ADMIN`, `SENIOR`, `JUNIOR`, `HR`, `ACCOUNTANT`) plus `DROP` routing
on top of them.

### 3. Projection — allow-list only, never denylist

Masking by "let's list what to hide" is a game of whack-a-mole that always
loses at the next field addition.

**Incident:** junior masking of projects (#164). The first attempt was a denylist:
finances were hidden, but **the senior's and the drop's identity — not**. It was caught only by a
field-by-field audit + manual-qa. The result: `mapProject(viewerRole==='JUNIOR')`
nulled out `seniorId/seniorName/dropId/dropName/dropSharePercent/rate/currency/
seniorSharePercent*/paymentType/salaryReview/notesGeneral`, `members → []`,
`effectiveTeam → undefined` — the last especially: it carried the identities
of senior/drop/HR/accountant **together with the email**.

The rules that follow from this:

- `buildProfileView` (`apps/api/src/users/users.service.ts:1440`) — an explicit
  allow-list projection. **Never regress into `{ ...target }`.** This is exactly
  what is written in the comment at the spot: "use an explicit field list rather than
  `{ ...target }` so that future DB columns do NOT leak automatically".
- A new sensitive column in `User` is gated in TWO places: in the projection **and**
  by a flag in `getViewPermissions` — and that one is in ANOTHER file,
  `apps/api/src/users/users-access.service.ts` (the flags `realContacts` / `fopPii` /
  `adminNote` / `legalName`). Editing only one of the two places — a typical leak.
- Any new surface reusing a management DTO for a less-privileged
  viewer is masked by an allow-list — both on the list path (`findAll`) and on the
  detail path (`findOne`). Forgetting one path — a typical mistake.

### 4. A mocked E2E knows nothing about global guards

A mocked Playwright spec returns what **the developer expected**, not what
the backend serves. So it is structurally blind to the interaction with global
guards.

**Incident (recurrence ×3, the first — PR #110, 2026-06-04):** `preview-rendered`
403'd behind the global `OnboardingGuard` (it was not in the bypass-list). The mocked E2E
mocked it as 200 and passed **green**. Both reviewers — code and security —
put APPROVE, because they looked at authz at the controller level, not
the interaction with the global guard. Caught only by Manual QA on the live stack.

What to require in review: for an endpoint behind a global guard — **an integration spec against
the real guard-chain** (`*.integration.spec.ts`, a real DB), checking 200/403
without mocks. A green mocked-E2E is not proof.

The diagnostic move, if "it works in tests, not in the browser": check `APP_GUARD`
in `app.module.ts` and the bypass-list of the corresponding guard.

### 5. Verification = a real-DB integration test for each sensitive field

For any masking/RBAC edit require a spec that, on a real DB, asserts
**null for each** sensitive field for an unprivileged viewer
(model: `projects-junior-masking.rbac.integration.spec.ts`, cases MASK-1..10,
including a regression-guard on `effectiveTeam`).

The absence of such a spec on a PR with masking is a standalone finding, not a
nitpick: without it the next added field will leak silently.

### 6. Prod DB: DDL only via `deploy.yml`, there is no SSH

The orchestrator **has no SSH to the VPS** (the first deploy's key was one-time). The only
path to the prod DB is the manual-SQL steps in `deploy.yml`
(`psql -v ON_ERROR_STOP=1 < file`).

Hence two requirements for review:

- A file `apps/api/drizzle/manual/*.sql` appeared — check that it is **wired** into
  `deploy.yml`. Drift of these two zones has already brought prod down to a 500
  (vacancy-i18n DDL, 2026-07-25); there is now a CI guard
  `scripts/devops/check-prod-ddl-wiring.py`, but the guard checks the fact of the reference, not the meaning.
- A one-off data-fix is idempotent and fail-loud (`RAISE` when verify ≠ expected),
  applied once, then the step is **removed** from `deploy.yml` (de-wiring).

### 7. CI / workflow — a separate attack surface

To check on PRs touching `.github/workflows/**`:

- **Untrusted input in `run:`** — commit subject / PR title / branch name.
  Only via `env:` and `"$VAR"`, never direct interpolation of `${{ }}`.
- **Token scope.** The repo default is `read`, and a job-level `permissions:`
  **replaces** it, not supplements. `contents: write` in a workflow with the trigger
  `pull_request` = a self-merge vector: for this repo's branches the version of the
  workflow from the merge-ref executes, i.e. the branch can rewrite its own condition
  (incident 2026-06-21, #271; the `auto_merge` job was removed for this reason, #446).
- **Reviving a trigger wakes the subscribers.** Before fixing a non-working
  trigger — look at who else listens to this event (`workflow_run`, `push`) and what
  it does with permissions (#446: post-merge CI woke a watchdog that pushed to main
  under an owner-PAT).
- **Secret: check validity, not presence.** A stale PAT is a non-empty
  string; `[ -n "$PAT" ]` will accept it, `gh` will return 401, `set -e` will crash the script —
  and the alert will vanish into silence.

---

## Anti-patterns

- **"The controller looks right" as grounds for APPROVE.** See pattern 2 — read the service.
- **Putting APPROVE because the mocked E2E is green** on a PR with a guard surface. See pattern 4: that is exactly how #110 passed.
- **Duplicating the OWASP checklist here.** It is in `security-reviewer.md` Step 2. This file is only about what THIS project got burned on.
- **Touching the `merge-approved` label.** It is placed only by Master/the owner on an explicit "merge" — regardless of the verdict (incident #271).

## References

- `.claude/agents/security-reviewer.md` — OWASP Top 10, secrets, npm audit, USDT patterns, the verdict format.
- `.claude/rules/common/skills-invocation.md` — the trigger table (this line).
- `.claude/skills/code-review-discipline/SKILL.md` — how to formulate and post the verdict.
- `.claude/agents/project-state.md` — the current RBAC matrix and the enforcement model.
