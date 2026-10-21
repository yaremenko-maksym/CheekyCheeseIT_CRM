# Task: Review Gate — a required check that makes reviewers mandatory for non-owner PRs

## Model: opus

## SCOPE CHANGE 2026-10-21 (owner, via Master) — LITE gate supersedes "What to build" below

The original design (owner-account verdicts on the head sha, security-review requirement for
critical paths, owner-author exemption, label-actor check, auto-merge changes) and the hardening
rounds built on it (commit/pusher identity, event sender, check-name spoofing, renames) are
**dropped**. They remain in this branch's history only. The gate that ships:

- applies to **all** authors, the owner included;
- PASS if the diff is docs-only (every changed path `*.md` or under `.claude/`);
- PASS if some review's verdict line is `Verdict: APPROVE` and no `Verdict: BLOCK` review was
  submitted after it;
- PASS if label `skip-review` AND a PR-body line `Skip-Review-Reason: <text>` (key
  case-insensitive, reason ≥ 10 chars); the reason is echoed in the job summary;
- otherwise FAIL: "No reviewer verdict. Run code-reviewer (and security-reviewer on critical
  paths), or set label `skip-review` and add `Skip-Review-Reason: <why>` to the PR body."
- triggers: `pull_request_target` [opened, synchronize, reopened, labeled, unlabeled, edited,
  ready_for_review] + `pull_request_review` [submitted, dismissed]; never check out PR code;
- `skip-review` declared in `.github/labels.yml`; `auto-merge-on-label.yml` is NOT changed.

Revised acceptance criteria:

1. `review-gate.yml` exists, uses `pull_request_target` (+ `pull_request_review`), never checks
   out PR code.
2. `review-gate.mjs` implements the lite decision as a pure function.
3. Unit tests: docs-only pass; verdict pass; BLOCK after APPROVE fail; label without reason fail;
   reason without label fail; label + reason pass; nothing fail. The run prints a non-zero pass count.
4. (dropped — no auto-merge change)
5. Docs: `contracts.md` §4.1 and a line in `project-state.md` describe the lite gate + the owner
   follow-up command.
6. `actionlint` / `prettier --check` clean on touched files.

Assumptions (A1, recorded):

- A verdict is recognised on a line of its own (markdown decoration tolerated), the first marker
  line of a review — not a substring anywhere. Stricter than "body contains", so a quoted or
  mid-sentence verdict cannot count. Matches the first-line contract in §4.
- A DISMISSED approval does not count; a BLOCK counts even if dismissed; PENDING reviews ignored.
- `skip-review` + reason passes even after a BLOCK — the recorded skip is the owner's escape hatch.

Architect, static tier. Process-governance gate on the merge path (critical: it decides what can
reach `main`).

## Why (audit of 2026-10-21)

All 5 PRs merged by the second collaborator `kstroevsky` (write role) went to `main` with **zero
reviews** — no code-reviewer, no security-reviewer, although every one touched a critical-path zone
(`contracts.md` §2.1: finance, Drizzle migrations, webhooks, deploy workflows):

| PR   | Touches                                          | How it merged                                               |
| ---- | ------------------------------------------------ | ----------------------------------------------------------- |
| #795 | finance, 2 migrations, `deploy.yml`              | merged by hand by the author, no label; hook-bypass warning |
| #809 | finance (custom tx dates)                        | author set `merge-approved` himself → bot squash            |
| #865 | +13.7k LOC, migration, `ci.yml` + `deploy.yml`   | auto-merge refused (workflow files) → author merged by hand |
| #866 | salary index migration                           | author set `merge-approved` 18 s after opening              |
| #867 | finance UTC fix, empty PR body                   | author set `merge-approved` himself                         |

Root cause, measured: branch protection on `main` has `required_pull_request_reviews: null`; required
checks are only Typecheck/E2E/Integration/Mutation. `merge-approved` is honoured from anyone with
write access, and a write-role user can merge by hand once the four checks are green. The review
requirement exists only as procedure inside the owner's Master pipeline, which a collaborator using
another harness (branch `codex/...`) never runs.

Native GitHub required reviews do not fit: `enforce_admins` is true and the owner cannot approve his
own PRs (owner == author on ~495 PRs), so it would block the owner's whole flow.

## What to build

A new workflow `.github/workflows/review-gate.yml`, job/check name **`Review Gate`**, plus its logic
in `scripts/architect/review-gate.mjs` (pure function over PR data, unit-testable; the workflow only
fetches data and calls it).

### Trigger and trust

- `pull_request_target` on `[opened, synchronize, reopened, labeled, unlabeled, ready_for_review]`,
  branches `[main]`. `pull_request_target` runs the **base-branch** definition, so a PR cannot weaken
  the gate that judges it. **Never check out or execute PR code** (checkout `main` only, as
  `auto-merge-on-label.yml` already does for its guard script).
- Do NOT use `pull_request_review` as a trigger (it runs the PR's version of the workflow — a tamper
  path). Re-evaluation after a review happens when the owner applies `merge-approved` (a `labeled`
  event), which is already the owner's step in the flow. Document this in the workflow header.
- `permissions:` minimal (`contents: read`, `pull-requests: read`, `issues: read`).

### Decision (pure function)

Input: PR author login, repo owner login, head sha, changed file paths, reviews (author, state,
body, commit_id, submitted_at), label events for `merge-approved` (actor, time).

1. **Author is the repo owner** → PASS (owner PRs go through the Master pipeline; extending the gate
   to them is a separate owner decision, see Assumptions).
2. Otherwise all of the following, else FAIL with a message naming every missing item:
   - a review **by the repo owner account** whose body contains `Verdict: APPROVE`, with
     `commit_id == head sha`;
   - no owner-account review with `Verdict: BLOCK` submitted after that approve;
   - if any changed path is in a critical-path zone → additionally an owner-account review on head
     with `Security Review: APPROVE`. Critical-path globs (derived from `contracts.md` §2.1, keep the
     list in one constant with a comment pointing there): `apps/api/src/**/auth/**`,
     `apps/api/src/**/finance/**`, `apps/api/src/**/transactions/**`, `apps/api/src/**/wallet*/**`,
     `apps/api/src/**/company-account/**`, `apps/api/src/**/rbac/**`, `**/*.guard.ts`,
     `**/drizzle/**`, `**/migrations/**`, `**/schema.ts`, `**/webhook*`, `.github/workflows/**`.
     Verify the real directory names in the repo before fixing the list — do not guess.
   - the **latest** `merge-approved` labeled event was made by the repo owner (if the label is
     present). A collaborator labelling his own PR → FAIL with an explicit message.
3. Output: a job summary + `::error::` lines listing what is missing. Exit non-zero on FAIL.

Owner login comes from `github.repository_owner`, never hardcoded.

### Auto-merge interaction

`auto-merge-on-label.yml` reads required contexts from branch protection, so once `Review Gate` is
required it waits for it automatically. Additionally, in `auto-merge-on-label.yml`: skip (with an
explanatory PR comment, matching the existing "Explain why" style) when the `merge-approved` label
actor (`github.event.sender.login`) is not `github.repository_owner`. Additive change only.

### Tests

`scripts/architect/review-gate.test.mjs` (node:test, no new deps) — cases at least:
owner author → pass; collaborator, no reviews → fail; approve on old sha → fail; approve on head →
pass for non-critical paths; critical path without security approve → fail; with it → pass; BLOCK
after APPROVE → fail; label set by collaborator → fail; review "Verdict: APPROVE" posted by the
collaborator himself → does not count. Wire the test into an existing CI job or a small workflow step
so it actually runs (state the artifact: the case count it printed).

## Out of scope (owner actions, do NOT do)

- Adding `Review Gate` to branch protection required checks — owner does it after merge (the context
  must exist first). Put the exact `gh api` command in the PR body.
- Retroactive review of #795/#809/#865/#866/#867 — separate task.

## Acceptance criteria

1. `review-gate.yml` exists, uses `pull_request_target`, never checks out PR code.
2. `review-gate.mjs` implements the decision above; owner login is not hardcoded.
3. Unit tests cover the cases listed; the run prints a non-zero passed count.
4. `auto-merge-on-label.yml` refuses a `merge-approved` label applied by a non-owner, with a PR comment.
5. Docs: a short section in `contracts.md` §4 (or the nearest merge-gating section) and a line in
   `.claude/agents/project-state.md` naming the gate and the owner follow-up command.
6. `actionlint` (if available) / `prettier --check` clean on touched files.

## Assumptions

- A1: owner-authored PRs are exempt from the gate in this iteration (their review is enforced by the
  Master pipeline procedurally). Extending to owner PRs with a docs-only exemption is a separate
  owner decision.
- A1: re-evaluation after a review is triggered by the owner's `merge-approved` label, not by a
  `pull_request_review` event (tamper-safety over convenience).

---

# SCOPE v3 (2026-10-21, owner) — SUPERSEDES everything above, including the "lite" chat message

Owner intent, verbatim in substance: **the project's development harness is the default for everyone
(owner, collaborator, any harness — Claude, Codex, manual), and skipping any step must be deliberate:
an explicit, named skip with a reason.** No hardening against a malicious write-role user
(commit-author checks, spoofing detection, label-actor checks, head-sha binding) — drop all of it.

## Deliverable: `Flow Gate` (rename `Review Gate` → check/job name `Flow Gate`)

`.github/workflows/flow-gate.yml` (`pull_request_target`, base definition, never checks out PR code;
triggers: opened, synchronize, reopened, edited, labeled, unlabeled, ready_for_review, plus
`pull_request_review: [submitted, dismissed]`) + pure logic `scripts/architect/flow-gate.mjs` +
`node:test` tests, wired into CI so they actually run.

> **Amended by Master (2026-10-21, answer to open question 1):** the `pull_request_review` trigger
> is DROPPED (it runs the PR's own copy of the workflow). Re-evaluation comes from push / label /
> body edit; the PR template says "after a review lands, re-run via a body edit or label".
> Also: the stale-red-run vs auto-merge race is recorded as a known limitation in `contracts.md`
> (no auto-merge change); the `skip-review` label and the `.github/labels.yml` change are dropped;
> the lite-round A1 decisions (verdict on its own line, dismissed-review semantics, a recorded skip
> passes even after a BLOCK) apply per step.

### Applies to ALL authors. One exemption: docs-only diff (every path `*.md` or under `.claude/`) → PASS.

### Steps — each is either satisfied by evidence, or skipped by a PR-body line `Skip-<Step>: <reason>`

Reason: non-empty, ≥ 10 chars, key case-insensitive. Every skip (step + reason) is echoed into the
job summary. No labels needed (the body line IS the flag + reason).

| Step key          | Required when                                                                 | Evidence that satisfies it                                                       |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Task`            | always (non-docs)                                                             | PR body line `Task: <path or issue link>` (task files are gitignored — declared, not verified) |
| `Plan`            | always (non-docs)                                                             | PR body line `Plan: <where>` (e.g. "in task file", a docs path)                  |
| `Tests`           | diff changes non-test product code in `apps/**` / `packages/**`              | diff also contains `*.spec.ts(x)` / `*.test.ts(x)` / `__tests__/` / `apps/e2e/**` |
| `Review`          | always (non-docs)                                                             | a PR review body with `Verdict: APPROVE`, no `Verdict: BLOCK` after it           |
| `Security-Review` | diff touches critical-path globs (`contracts.md` §2.1; verify real dir names) | review body `Security Review: APPROVE`, no `Security Review: BLOCK` after it     |
| `Spec-Review`     | a `Task:` line is present                                                     | review body `Spec Review: PASS`                                                  |
| `Copy-Review`     | diff touches i18n catalogs (`packages/shared/src/i18n/locales/**`) or landing dictionaries | review body `Copy Review: PASS`                                       |
| `QA`              | diff touches non-test UI code in `apps/web/**` / `apps/landing/**`           | review/comment body `QA Verdict: PASS`                                           |
| `Design-Review`   | same as `QA`                                                                  | review/comment body `Design Review: APPROVE` (check the real verdict wording in `ui-ux-designer.md`) |
| `AC`              | always (non-docs)                                                             | the PR's last non-`wip:` commit message contains `ac_verified:`                   |

Fail message lists EVERY unsatisfied step with its two ways out, e.g.
`Review — no "Verdict: APPROVE" review. Run code-reviewer, or add "Skip-Review: <why>" to the PR body.`

### Make the default visible to every harness
- `.github/pull_request_template.md` with a `## Flow` block: `Task:`, `Plan:` and commented
  `<!-- Skip-<Step>: reason -->` lines for every step, one-line explanation each.
- `AGENTS.md` at repo root (read by Codex and other harnesses): short — the flow is the default,
  Flow Gate enforces it, how to skip a step honestly; points to `CLAUDE.md` / `contracts.md`.
- `manual-qa.md` and `ui-ux-designer.md` agents: post their verdict to the PR as a review/comment with
  the marker line above (code/security/spec/copy reviewers already do — verify).
- Docs: `contracts.md` (merge gating), `project-state.md`, `light-track.md` (docs-only exemption +
  light-track PRs use `Skip-*` lines with reason "light-track: <why>").

### Owner action after merge (Master does it, authorized)
Add `Flow Gate` to `main` branch protection required checks — exact `gh api` command in PR body.
Remove anything about `Review Gate` / `skip-review` label.

### Tests (minimum)
docs-only pass · nothing declared fail (lists all steps) · each step: evidence pass / skip-with-reason
pass / skip-with-short-reason fail · BLOCK after APPROVE fail · Security-Review required only on
critical paths · Tests required only when product code changes · QA/Design only on UI paths ·
Spec-Review only when Task declared · AC from last non-wip commit.

### v3 amendments from Master during implementation (2026-10-21)

1. **Docs-only means markdown only.** `isDoc(p) = p.endsWith('.md')`. Non-markdown `.claude/` files go
   through the steps, and `.claude/hooks/**` plus `.claude/settings*.json` are critical paths.
   Unit cases: `.claude/hooks/x.sh` alone is not docs-only and requires Security-Review;
   `.claude/rules/x.md` alone is docs-only.
2. **Renames:** fetch `{filename, previous_filename, status}` and classify both names. A rename or
   deletion of a non-`.md` path is never docs-only.
3. **Association:** verdicts count only from `OWNER` / `MEMBER` / `COLLABORATOR`, positive and
   negative alike. The PR author is not excluded.
4. **Completeness:** listed files and commits must equal the PR's `changed_files` / `commits`.
   The check also fails at or above 3000 files / 250 commits, with a "could not read the whole PR"
   message.
5. **Not done:** binding verdicts to the head sha. Recorded as a known limitation in `contracts.md`
   §4.1.
6. **CI wiring fix:** `node --test 'scripts/architect/*.test.mjs'` (quoted glob). A bare directory
   argument fails on Node 22 in CI.

### Assumptions (A1, made while implementing v3)

- `Copy-Review` evidence is read from reviews **and** PR comments, because `copy-reviewer.md` says
  "the first line of the PR comment". Review, Security and Spec read reviews only, as the table says.
- `Design-Review` accepts `PASS` (the real wording in `ui-ux-designer.md`) and `APPROVE` (the
  table's wording). `POLISH-REQUESTED` counts as negative.
- `QA` marker: `QA Verdict: PASS | FAIL`. `manual-qa.md` now posts it as a PR comment.
- `Tests` evidence counts `.js`/`.mjs` test files too, and treats `.md` under `apps/` / `packages/`
  as not product code. `AC` skips merge commits (parents > 1) as well as `wip` commits.
- Root `AGENTS.md` was gitignored (#1033: turbo appends a managed block when an AI agent is
  detected). Measured: turbo 2.11.7 **appends** its block to an existing file and keeps our
  content. The ignore line is removed, and the file is committed with turbo's block, as turbo
  itself advises. `.gitignore` and `.github/pull_request_template.md` are outside the Architect
  write zone; both changes were requested by the owner through Master.

