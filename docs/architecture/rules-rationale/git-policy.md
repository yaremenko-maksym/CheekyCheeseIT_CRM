# Rationale: git-policy

Rationale layer for `.claude/rules/common/git-policy.md`. Not auto-loaded — read on demand.

**Source:** Project hard requirement (CLAUDE.md + `.clauderules`) + 2026-06-02 RCA on `--no-verify`
recurrence + 2026-05-23 dev-flow RCA (D3 = AC verification at push).

---

## Why the zero-tolerance table puts the target action first

Managing via prohibition drags the forbidden behaviour into context and makes it **more available**:
negation is a weak modifier, and a strongly activated concept overrides it. So the first column is
what to **do**, and the prohibition follows as a hard guardrail rather than as the only wording.

The prior edition put the "Alternative" in the third column — i.e. the last thing read. The
recurrences are exactly the class where wording could have been part of the cause:

- `--no-verify` three times in the 2026-06-02 session;
- `git add .` on PR #22 (round 4), which swept another agent's debug artifacts into the commit.

Technique source: `mattpocock/skills`, `writing-for-agents` §Negation.

## Why the pre-push gate's allowlist was inverted (2026-09-01)

The gate used to list the "catchable" branch prefixes — `feature|fix|infra|test`. `feat/` did not
make the list, so **15 merged PRs passed the gate silently**, and a coder noticed it, not the gate.

The same audit found code shipped on branches the list also missed:

| Branch prefix | Example | Note                                                 |
| ------------- | ------- | ---------------------------------------------------- |
| `perf/`       | #474    |                                                      |
| `ci/`         | #433    |                                                      |
| `docs/`       | #613    | 24 files under `apps/`, including the finance dialog |

**Enumeration breaks quietly, an exception breaks loudly**, so the list was inverted: the gate now
closes everything except `main`/`master`, `architect/*` and `legal/*`. The two agent-branch
exemptions were carried over from the old hook wording, not issued anew — their tasks have no AC list
in the task file.

Before 2026-09-01 the hook had **no test at all**, and the meta-guard
`scripts/devops/check-guard-tests-exist.sh` could not report it, because it read only
`scripts/devops/check-*`. It now takes the list of hooks from `.claude/settings.json` and requires a
test with a negative case from every hook that can refuse.

## Why the scopes enumeration was removed (2026-09-02)

The file used to carry a **closed** list of eight types and ten scopes. A history rewrite showed it did
not describe this codebase:

| Finding                               | Detail                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| Listed but never used                 | `(reviewer)` — **0 uses**; `(legal)` — 1                                              |
| Used heavily but absent from the list | `finance` 277, `landing` 155, `infra` 139, `e2e` 119                                  |
| Types missing from the list           | `wip` (required by an adjacent section of the same file!), `infra` (15), `style` (16) |

Nobody enforced the list (there is no `commitlint`, no `commit-msg` hook in the repository), so the
divergence grew quietly for a year and a half and surfaced only at the review of PR #623, where DevOps
noticed that `infra(deploy):` was formally "off the list" — having ten precedents starting from PR #51.

The lesson is the same one the pre-push gate learned a month earlier: **a rule that enumerates the
allowed goes stale with every new case and does not announce it; a rule that names a trait does not.**

## Provenance of two sections

- **The prettier pre-push gate** was added 2026-06-21 by the PR titled
  `fix(hooks): enforce prettier on pre-push`.
- **`DATABASE_URL=` empty when pushing feature branches** comes from ADR
  `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` FM-6 / FM-7.

## Why the AC gate is a PreToolUse hook rather than husky

In a fresh `isolation=worktree` worktree the husky hooks are silently skipped: `.husky/_/` is
gitignored and generated only on `pnpm install`. A gate that silently does not exist in exactly the
environment where agents work is not a gate. The same reasoning produced the prettier gate — the
pre-commit `lint-staged → prettier --write` is skipped in a fresh worktree, which is how unformatted
code reached CI and reddened #259 / #261 / #263.

## Sources

- CLAUDE.md + `.clauderules`
- `.claude/agents/memory/coder/lessons.md` 2026-05-20 [P0] git-add zero-tolerance
- `.claude/agents/memory/coder/lessons.md` 2026-06-02 [P0] `--no-verify` recurrence
- `docs/architecture/2026-05-23-dev-flow-rca.md` D3 (AC verification gate)
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.2.3 (pre-push hook)
- Phase 2.5 hook activation: `docs/architecture/2026-06-03-phase2.5-deliverable.md`
- PR #623 — the `infra(deploy):` scope divergence.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

 It is a PreToolUse hook rather than husky because
in a fresh `isolation=worktree` worktree the husky hooks are silently skipped (`.husky/_/` gitignored,
generated only on `pnpm install`).


---

 Same reason as above:
in a fresh worktree the pre-commit `lint-staged → prettier --write` is silently skipped.
