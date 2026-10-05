# Rule: Git policy — commit hygiene & forbidden patterns

**Status:** Always-on
**Applies to:** All write-agents (Coder, AutoTest, DevOps), with applicable subset for Master / Architect / Reviewer when they touch git.
**Source:** Project hard requirement (CLAUDE.md + `.clauderules`) + 2026-06-02 RCA on `--no-verify` recurrence + 2026-05-23 dev-flow RCA (D3 = AC verification at push).

---

## Zero-tolerance patterns — the target action first, the prohibition second

> **Why in this order (2026-08-22).** Managing via prohibition drags the forbidden
> behaviour into context and makes it **more available**: negation is a weak modifier, a strongly
> activated concept overrides it. So the first column is what to **do**, and the prohibition
> follows as a hard guardrail, not as the only wording. The prior edition put
> the "Alternative" in the third column, i.e. the last thing read. Recurrences (`--no-verify`
> three times in the 2026-06-02 session, `git add .` on PR #22) are exactly the class where wording could
> have been part of the cause. The source of the technique — `mattpocock/skills`, `writing-for-agents` §Negation.

| Do it this way                                                     | Not this way                                                | Why                                                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finish the AC → an honest commit with `ac_verified:`               | `git push --no-verify`                                      | Bypasses the pre-push hook that checks `ac_verified:`. Real incidents 2026-06-02: 3× in a session.                                                 |
| Same                                                               | `git commit -n` / `git commit --no-verify`                  | Same.                                                                                                                                              |
| Same                                                               | `git -c core.hooksPath=/dev/null` (any form of hook bypass) | Same.                                                                                                                                              |
| Ask USER                                                           | `--no-gpg-sign` without an explicit USER request            | Bypasses signing.                                                                                                                                  |
| List the files explicitly from the task section "Concrete changes" | `git add .` / `git add -A` / `git add *` / `git add apps/`  | Sweeps up someone else's debug artifacts from the worktree (PR #22 round4 incident, see `.claude/agents/memory/coder/lessons.md` 2026-05-20 [P0]). |
| PR + label `merge-approved` → CI auto-merge                        | Push to `main` directly                                     | Branch protection — only via a PR.                                                                                                                 |
| On your own branches `--force-with-lease`                          | `git push --force` to `main` / `master`                     | Destroys history.                                                                                                                                  |
| `git stash` → restore                                              | `git reset --hard origin/main` without a warning            | Destroys local work.                                                                                                                               |
| Wait for green checks → squash via the label `merge-approved`      | `gh pr merge --admin`                                       | Bypasses branch protection (required checks).                                                                                                      |

CI hard block: `.github/workflows/check-no-skip-hooks.yml` fails on a PR if the string `--no-verify` appears in the diff. The reviewer issues `Verdict: BLOCK`. `merge-approved` is set only by Master/owner — and only on the owner's explicit "merge".

## Commit message format

```
<type>(<scope>): <subject>

<optional body>

ac_verified: 1,2,3,4,5        # AC numbers from the task file, comma-separated
vision: ✓ /team, /team/$teamId    # ONLY for UI tasks — affected routes
```

- If all AC are done — list all numbers: `ac_verified: 1,2,3,4,5`
- If some are not done — list the done ones + a comment: `ac_verified: 1,2,4 (3,5 — blocked, see .blocked.md)`
- If the task has no UI — omit the `vision:` line, `ac_verified:` is mandatory.

Pre-push gate (Claude PreToolUse:Bash hook `.claude/hooks/pre-bash-coder-push-gate.sh`, id `pre:bash:coder-push-gate`) blocks `git push` if the last commit **on any branch** does not contain an `ac_verified:` line. Do not bypass — finish the AC. Enforced at the harness level (PreToolUse), not via husky: in a fresh `isolation=worktree` worktree the husky hooks are silently skipped (`.husky/_/` gitignored, generated only on `pnpm install`).

**The gate closes everything but three exceptions (edit 2026-09-01).** Previously it listed the "catchable" prefixes — `feature|fix|infra|test` — and `feat/` did not make the list: 15 merged PRs passed the gate silently, and a coder noticed it, not the gate. The same audit found code on `perf/` (#474), `ci/` (#433) and `docs/` (#613 — 24 files under `apps/`, including the finance dialog). Enumeration breaks quietly, an exception breaks loudly, so the list was inverted.

Free from the mark are only: `main`/`master` (not a work branch), `architect/*` and `legal/*` (their tasks have no AC list in the task file; carried over from the old hook wording, not issued anew). The cost of each exception is spelled out in the hook's header — read it **before** adding a fourth.

A branch that honestly has nothing to verify (screenshots, notes) has two answers available, and both are an assertion, not a bypass: `wip:` in the commit subject or `ac_verified: n/a (<why>)`.

Test: `scripts/devops/tests/test-pre-bash-coder-push-gate.sh` (28 cases, by execution). Before 2026-09-01 the hook had no test at all, and the meta-guard `scripts/devops/check-guard-tests-exist.sh` could not report it — it read only `scripts/devops/check-*`. Now it takes the list of hooks from `.claude/settings.json` and requires a test with a negative case from every one that can refuse.

## Prettier pre-push gate (catch formatting BEFORE push)

**Status:** added 2026-06-21 (PR `fix(hooks): enforce prettier on pre-push`).

Claude PreToolUse:Bash hook `.claude/hooks/pre-bash-prettier-gate.sh` (id `pre:bash:prettier-gate`)
blocks `git push` if the files changed vs `origin/main` (`ts/tsx/js/jsx/json/md/yml`) did not
pass `prettier --check` — a local mirror of the CI gate `check-no-skip-hooks.yml`. Reason: in a fresh
worktree the pre-commit hook (lint-staged → `prettier --write`) is silently skipped (no husky/node_modules),
and unformatted code used to go to CI and redden the PR (#259/#261/#263). The hook resolves prettier
worktree-safe (local `.bin` → MAIN-repo `.bin` via git-common-dir → `pnpm exec`); if prettier
is unreachable — **fail-loud BLOCK** with the instruction `pnpm install`, not a silent skip. On a block it outputs the exact
fix command `prettier --write <files>`.

## WIP commits & chunking

The `wip:` prefix is a marker of incompleteness. The pre-push hook does NOT require `ac_verified:` on `wip:` commits (only on the final one).

- **`wip:` push after every 2 files** OR
- **`wip:` push after every 5 minutes** OR
- **`wip:` push before any operation > 1 min** (build, tests, migration)

The final commit — without `wip:`, with `ac_verified:`.

## Pushing feature branches: `DATABASE_URL=` empty (data-safety)

**Status:** added 2026-06-16 (ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` FM-6/FM-7).

ALWAYS push local feature branches as `DATABASE_URL= git push` (the variable empty).
The pre-push hook runs tests; without a scope the integration specs connect to the libpq default (the live `crm_db`!)
and may (a) fail on a missing QA fixture, (b) theoretically touch USER's UT data, (c) catch a
CPU timeout under load. An empty `DATABASE_URL` -> integration specs graceful-skip, the push is safe.

## Conventional commits scopes (for the project)

**Type** — from the Conventional Commits set (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
`perf`, `ci`, `style`, `build`) plus two of ours: `wip` (see the section above — a marker of incompleteness,
freeing from `ac_verified:`) and `infra` (changes to environment and plumbing that do not land in
the product).

**Scope** — the area the commit touches: a package (`api`, `web`, `shared`, `e2e`, `landing`),
a domain area (`finance`, `documents`, `auth`, `projects`, `teams`, `contracts`) or
an infrastructure zone (`infra`, `deploy`, `ci`, `hooks`, `agents`). The list is **not closed** —
take what describes the area more precisely.

The commit message body is in English (Conventional Commits standard). Assistant / agent output is
also English (see `.claude/rules/common/russian-language.md`); Russian — only in the owner's personal chat
with Claude.

> **Why the enumeration was removed (2026-09-02).** Here stood a closed list of eight types and
> ten scopes. A history rewrite showed it did not describe this codebase:
> `(reviewer)` was used **not once**, `(legal)` — once, while the four most frequent
> scopes (`finance` 277, `landing` 155, `infra` 139, `e2e` 119) were absent from the list. Of
> the types, `wip` was not listed — even though an adjacent section of this very file requires it —
> and neither were `infra` (15) and `style` (16).
>
> Nobody enforced the list (there is no `commitlint`, no `commit-msg` hook in the repository), so the
> divergence grew quietly for a year and a half and surfaced only at the review of PR #623, where DevOps noticed
> that `infra(deploy):` was formally "off the list", having ten precedents starting from PR #51.
>
> The lesson is the same one this file already learned on the pre-push gate a paragraph above: **enumeration breaks
> quietly**. A rule that enumerates the allowed goes stale with every new case and does not
> announce it; a rule that names a trait does not.

## Related rules

- `.claude/rules/common/zone-of-write.md` — which agent may write which paths (the reviewer issues BLOCK on violations).
- `.claude/rules/common/russian-language.md` — English in repo + agent output, commits English; Russian only in the owner chat.
- Phase 2.5 hook activation: `docs/architecture/2026-06-03-phase2.5-deliverable.md` (live `pre-bash-coder-push-gate.sh`).

## Sources

- CLAUDE.md + `.clauderules`
- `.claude/agents/memory/coder/lessons.md` 2026-05-20 [P0] git-add zero-tolerance
- `.claude/agents/memory/coder/lessons.md` 2026-06-02 [P0] `--no-verify` recurrence
- `docs/architecture/2026-05-23-dev-flow-rca.md` D3 (AC verification gate)
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.2.3 (pre-push hook).
