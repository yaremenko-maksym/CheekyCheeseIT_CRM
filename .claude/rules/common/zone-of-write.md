# Rule: Zone-of-write contract per agent

**Status:** Always-on (enforced by hook + Reviewer)
**Applies to:** All write-agents (Coder, AutoTest, DevOps, Architect, ui-ux-designer, manual-qa, legal) + Master (orchestrator). `code-reviewer` / `security-reviewer` — read-only to code.
**Source:** Project hard requirement (CLAUDE.md zones + `.claude/agents/architect.md` Zone-of-write) + Phase 2.5 hook activation (`pre-edit-write-zone-of-write.sh` live).

---

## The rule

Each agent may write ONLY in its own zone. The reviewer issues `Verdict: BLOCK` on a diff where an agent trampled someone else's files.

| Agent                     | May write                                                                                                                                                                                                                                                                                                                                                                                                 | May NOT                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coder**                 | `apps/api/**`, `apps/web/**`, `apps/landing/**`, `apps/e2e/**`, `packages/**`, `.claude/tasks/<my-task>.progress.md`, `.claude/tasks/<my-task>.blocked.md`                                                                                                                                                                                                                                                | `scripts/pm/**`, `scripts/devops/**`, `.claude/agents/**`, `docs/business/**`, `.github/workflows/**`, `.claude/hooks/**`, `.claude/settings*.json`, `.gitmessage`, others' task files |
| **AutoTest**              | **Any test file in the repository**, wherever it lies: `**/*.spec.ts(x)`, `**/*.test.ts(x)`, `__tests__/` directories, `__test-helpers__/`, all of `apps/e2e/**` (including `fixtures/`), test configs (`playwright.config.ts`, `vitest.config.*`), `.claude/tasks/<my-task>.blocked.md`                                                                                                                  | **Product code** — any non-test file in `apps/**` / `packages/**`. Also `docs/business/**`, `.claude/agents/**`, `.github/workflows/**`, `scripts/**`                                  |
| **DevOps**                | `.github/workflows/`, `docker-compose.yml`, `.env.example`, root `package.json` scripts (`dev:start`, etc.), `scripts/devops/**`                                                                                                                                                                                                                                                                          | `apps/**`, `packages/**`, `docs/business/**`, `.claude/agents/**`, `scripts/pm/**`                                                                                                     |
| **code-reviewer**         | `mcp__github__create_pull_request_review` / inline comments (read-only to code)                                                                                                                                                                                                                                                                                                                           | Any files in the repo                                                                                                                                                                  |
| **security-reviewer**     | `mcp__github__create_pull_request_review` / inline comments (read-only to code)                                                                                                                                                                                                                                                                                                                           | Any files in the repo                                                                                                                                                                  |
| **spec-reviewer**         | `mcp__github__create_pull_request_review` / inline comments (read-only to code)                                                                                                                                                                                                                                                                                                                           | Any files in the repo — the second review axis edits neither the diff nor the task                                                                                                     |
| **copy-reviewer**         | `mcp__github__create_pull_request_review` / inline comments (read-only to code)                                                                                                                                                                                                                                                                                                                           | Any files in the repo — text edits are made by the task author, not the reviewer                                                                                                       |
| **Master (orchestrator)** | `.claude/tasks/`, `.claude/briefs/`, `docs/business/` (when resolving blockers), `.claude/agents/memory/<agent>/lessons.md` (append), `scripts/pm/**`                                                                                                                                                                                                                                                     | `apps/**`, `packages/**`, `apps/e2e/**`, `.github/workflows/**`, `.claude/agents/<X>.md` (except memory)                                                                               |
| **Architect**             | `docs/architecture/**`, `.claude/rules/**`, `.claude/hooks/**`, `.claude/skills/**`, `.claude/agents/<agent>.md` (frontmatter + golden rules), `.claude/RULES.md`, `.claude/settings*.json` (hook registration), `scripts/architect/**`, `.github/workflows/**` (additive process gates), `scripts/devops/check-guard-tests-exist.sh` + `scripts/devops/tests/test-pre-*.sh` (tests on hooks — see below) | `apps/**`, `packages/**`, `docs/business/**`, `.claude/briefs/**`, `.claude/knowledge/legal/**`, `.claude/tasks/<others' active>` (Master owns)                                        |
| **ui-ux-designer**        | `apps/web/**` + `apps/landing/**` (cosmetic: classNames / tokens / layout / motion), `docs/design/**`, `.claude/tasks/<my-task>.blocked.md`                                                                                                                                                                                                                                                               | `apps/api/**`, `packages/**`, business logic in `.tsx`, `.github/workflows/**`, `.claude/agents/**`                                                                                    |
| **manual-qa**             | `apps/web/**` + `apps/landing/**` (ONLY cosmetic fixes: text / padding / class), `.claude/tasks/<my-task>.blocked.md`                                                                                                                                                                                                                                                                                     | `apps/api/**`, `packages/**`, business logic, `apps/e2e/**`, `.github/workflows/**`, `.claude/agents/**`                                                                               |
| **legal**                 | `.claude/tasks/task-legal-*`, `docs/legal/**`, `.claude/knowledge/legal/**`                                                                                                                                                                                                                                                                                                                               | `apps/**`, `packages/**`, `.claude/agents/**`, prod code, `.github/workflows/**`                                                                                                       |

> **The AutoTest zone — by the nature of the file, not by directory (owner decision 2026-08-22).** The prior
> wording gave it only `apps/e2e/**` and **explicitly forbade** `apps/api/**`, `apps/web/**`,
> `packages/**` — i.e. 452 of 566 test files were outside its zone, though there is no one else to
> write them. The divergence surfaced on PR #588, when an integration Vitest spec under
> `apps/api/src/**` was assigned to AutoTest against the letter of the rule (backlog item 165).
> **The boundary runs between the test and the product code, not between directories.** The danger
> was never that AutoTest edits specs — it is that it edits **product code**
> to make a test go green. That is exactly what is forbidden.
>
> **Notes on zones:** `ui-ux-designer` ↔ `manual-qa` both write cosmetic in `apps/web/**` / `apps/landing/**` — the designer per the design spec (Mode B/D conformance/polish), manual-qa fixes what is found on a live pass; the delineation is in `contracts.md §3.1/§3.2`. `architect` and `legal` are launched **USER / Master ad-hoc** — intentionally (strategic / on-request roles), not a gap.

## Enforcement

### Active hook

`.claude/hooks/pre-edit-write-zone-of-write.sh` (live since Phase 2.5) blocks a Coder from the main repo on an attempt to `Edit` / `Write` / `MultiEdit` / `NotebookEdit` in `apps/**` / `packages/**` if Master did not allow it.

### Worktree caveat

In a worktree the block is lifted — the Coder _technically_ can overwrite anything. But this is a zone-of-write violation → the reviewer will issue `Verdict: BLOCK`.

### Verify MAIN is clean after each Coder (MANDATORY)

**Status:** added 2026-06-16 (ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` FM-2).

A Coder in `isolation=worktree` on the first Write sometimes writes into the MAIN repo by an absolute path
(it copies main-repo paths from codegraph / the task file). `pre-edit-write-zone-of-write.sh` does NOT catch this case.
So Master MUST, after EACH finished Coder, verify that the MAIN checkout is clean:

```bash
git -C <main-repo> status --porcelain apps/ packages/   # empty = OK; lines present = contamination, roll back
```

In the Coder's dispatch prompt — an explicit block: "ALL Edit/Write INSIDE your own worktree; after the first edit
check `git -C <worktree> status`; do NOT write to main-repo absolute paths".

### If the task requires leaving the zone

1. Create `<task>.blocked.md` describing why.
2. Do NOT do it unilaterally.
3. Exception: Master explicitly stated in the task file "update `docs/business/modules/<X>.md`" — allowed.

## Architect-specific notes

**Revision 2026-08-17 (PR #553, finding CR-L-1).** The prior edition allowed
the Architect to touch `.claude/agents/<agent>.md` **only** within the ECC migration
(adding frontmatter, the skill table, trimming references), and did not mention `.claude/RULES.md`
and `.claude/settings*.json` at all. The ECC migration finished 2026-06-03 —
and since then the rule described not what happens. Precedents (verified with
`gh pr view` / `git log`, not from memory):

- **`.claude/settings*.json` — 4 of 4:** #89, #264, #403, #487, each added
  a hook registration. None was rejected.
- **`.claude/RULES.md`:** #165, #281, #283, #317, #320, #321, #448.
- **Golden rules in agent docs:** #271 (forbidding reviewers to set
  `merge-approved`), #366 (P0 "no background waits"), #530, #538 — i.e.
  exactly what the old wording allowed "only during the ECC migration".
- **agent snippets + `rules/common/**`:\*\* #403.

The rule diverged from practice systematically, across all four categories.

Reconciled in favour of practice, not the letter: **fifteen "exceptions" are
a norm that was not written down.** Exactly the class of defect this PR fixes in
the working mechanics; leaving it in our own rules would be inconsistent.

Along the way an internal contradiction was removed: `.claude/hooks/**` stood in the Architect's
row **simultaneously** in "may" and "may not" (`legacy, until cleanup`).
The cleanup is long done — the "may not" column has been cleaned out.

Boundaries of the new wording:

- **Golden rules and `RULES.md`** — the Architect edits them when the inter-agent
  mechanics change (a new hook, a new always-on rule, a new mandatory startup step).
  This is not "the agent's business logic" but the contract of the environment in which the agent works.
- **`.claude/settings*.json`** — the Architect's zone **by necessity**: a hook
  that is not registered does not exist. Writing there is allowed **only**
  for hook registration; `permissions`, `enabledPlugins`, `env` — not his.
- **`.github/workflows/**`** — only **additive\*\* process gates. Everything that
  touches deploy, build, or prod secrets stays DevOps.
- **The Architect still does NOT rewrite** task setup / a task's business logic
  (Master's zone via `.claude/tasks/`).
- **The Architect's diffs still go through review** — a zone extension changes what
  does not require `.blocked.md`, not what does not require review.

If an edit goes beyond these boundaries too — `.blocked.md`, like everyone.

### Tests on hooks live in the DevOps directory — and this is not "how it turned out"

**Revision 2026-09-01 (PR #625, finding CR-M-2).** Hooks are the Architect's zone, while the tests
on them lie in `scripts/devops/tests/`, i.e. formally in the DevOps zone. The rule
was silent on this, PR #625 recorded six files from there into it, and without this note
the next one will decide anew — and will decide differently.

Reconciled by the same device as in August: **not a statement of practice,
but an analysis of why the alternative is worse.**

There is exactly one alternative — keep the tests on hooks in `.claude/hooks/tests/`, inside
their own zone. It loses on three verifiable points:

1. **Nobody runs that directory.** `run-guard-tests.sh` sweeps
   `scripts/devops/tests/test-*.sh`, and CI runs this runner **as a step inside
   a required check**. No workflow referenced `.claude/hooks/tests/`
   (`grep -rn cross-agent-hooks-smoke .github` — empty): 42 real cases
   CI never executed once. Putting new tests there would mean writing
   them and not running them.
2. **There is no harness there.** `assert_red` / `assert_green` / `guard_test_workspace`
   live in `scripts/devops/tests/lib/harness.sh`. A second set of assertions in another
   directory — a second vocabulary for the same thing, and the meta-guard that looks for
   a negative case would have to understand both. One of them it would understand worse.
3. **The meta-guard would have to be touched anyway.** `check-guard-tests-exist.sh` is
   also `scripts/devops/`. The zone overlap does not vanish on moving the tests, it
   only becomes smaller while breaking points 1–2.

**The boundaries of the exception are narrow, and that is part of the exception:**

- The Architect writes in `scripts/devops/` **only** `check-guard-tests-exist.sh`
  (the meta-guard over his own hooks) and `tests/test-pre-*.sh` (the tests on
  the hooks he owns). Everything else in `scripts/devops/**` — DevOps:
  `mutation-gate.mjs`, the `deploy` plumbing, `check-*` about prod.
- The reverse does **not** hold: DevOps does not edit `.claude/hooks/**`.
- The diff still goes through review. The exception changes what does not require
  `.blocked.md`, not what does not require review.

Why it is safe to write this down at all: a violation here is **loud**. A file in someone else's
directory is visible in the diff at first glance — unlike the class of defects
for which the zones were created (an agent edits prod code to make a test go green).

**The source of the divergence, so it does not recur.** `.claude/agents/architect.md`
§Zone-of-write **already** listed `.claude/settings*.json (hook registration)` and
golden rules — i.e. the agent doc was accurate, while the canonical rule file (this one)
lagged. Two descriptions of one zone diverged, and the agent reads both. Now they are
synchronized by an explicit note in both; **edit one — edit the second.**

## Related rules

- `.claude/rules/common/git-policy.md` — `git add .` zero-tolerance protects against accidental cross-zone commits.
- `.claude/rules/common/skills-invocation.md` — which skills belong to whose zone.

## Sources

- CLAUDE.md "Multi-Agent team" + zone hints in each agent doc.
- `.claude/agents/architect.md` Zone-of-write section.
- Phase 2.5 deliverable: `docs/architecture/2026-06-03-phase2.5-deliverable.md` (live `pre-edit-write-zone-of-write.sh`).
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.2.2 (zone-of-write hook).
