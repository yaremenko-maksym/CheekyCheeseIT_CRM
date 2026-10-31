# Rationale: zone-of-write

Rationale layer for `.claude/rules/common/zone-of-write.md`. Not auto-loaded — read on demand when
you need to know **why** a zone boundary runs where it does, or before moving one.

**Source:** Project hard requirement (CLAUDE.md zones + `.claude/agents/architect.md`
Zone-of-write) + Phase 2.5 hook activation (`pre-edit-write-zone-of-write.sh` live) + the revisions
below.

---

## The AutoTest zone was redrawn by file nature, not directory (owner decision 2026-08-22)

The prior wording gave AutoTest only `apps/e2e/**` and **explicitly forbade** `apps/api/**`,
`apps/web/**`, `packages/**` — i.e. **452 of 566 test files were outside its zone**, though there is
no one else to write them.

The divergence surfaced on PR #588, when an integration Vitest spec under `apps/api/src/**` was
assigned to AutoTest against the letter of the rule (backlog item 165).

The boundary now runs between the test and the product code. The danger the zone was created against
was never that AutoTest edits specs — it is that it edits **product code** to make a test go green,
and that remains forbidden under the new wording just as under the old.

## The Architect zone was reconciled with practice (PR #553, 2026-08-17, finding CR-L-1)

The prior edition allowed the Architect to touch `.claude/agents/<agent>.md` **only** within the ECC
migration (adding frontmatter, the skill table, trimming references), and did not mention
`.claude/RULES.md` and `.claude/settings*.json` at all. The ECC migration finished 2026-06-03 — and
since then the rule described not what happens.

Precedents, verified with `gh pr view` / `git log`, not from memory:

| Category                           | Precedents                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `.claude/settings*.json`           | **4 of 4:** #89, #264, #403, #487 — each added a hook registration. None was rejected            |
| `.claude/RULES.md`                 | #165, #281, #283, #317, #320, #321, #448                                                         |
| Golden rules in agent docs         | #271 (forbidding reviewers to set `merge-approved`), #366 (P0 "no background waits"), #530, #538 |
| agent snippets + `rules/common/**` | #403                                                                                             |

The rule diverged from practice systematically, across all four categories. Reconciled in favour of
practice, not the letter: **fifteen "exceptions" are a norm that was not written down.** Exactly the
class of defect that PR fixed in the working mechanics; leaving it in our own rules would have been
inconsistent.

Along the way an internal contradiction was removed: `.claude/hooks/**` stood in the Architect's row
**simultaneously** in "may" and "may not" (`legacy, until cleanup`). The cleanup was long done — the
"may not" column was cleaned out.

### The source of the divergence, so it does not recur

`.claude/agents/architect.md` §Zone-of-write **already** listed `.claude/settings*.json (hook
registration)` and golden rules — i.e. the agent doc was accurate, while the canonical rule file
lagged. Two descriptions of one zone diverged, and the agent reads both. The core rule now carries an
explicit "edit one — edit the second" note for this reason.

## Tests on hooks live in the DevOps directory — and this is not "how it turned out"

**Revision 2026-09-01 (PR #625, finding CR-M-2).** Hooks are the Architect's zone, while the tests on
them lie in `scripts/devops/tests/`, i.e. formally in the DevOps zone. The rule was silent on this,
PR #625 recorded six files from there into it, and without a written reason the next person would
decide anew — and would decide differently.

Reconciled by the same device as in August: **not a statement of practice, but an analysis of why the
alternative is worse.**

There is exactly one alternative — keep the tests on hooks in `.claude/hooks/tests/`, inside their
own zone. It loses on three verifiable points:

1. **Nobody runs that directory.** `run-guard-tests.sh` sweeps `scripts/devops/tests/test-*.sh`, and
   CI runs this runner **as a step inside a required check**. No workflow referenced
   `.claude/hooks/tests/` (`grep -rn cross-agent-hooks-smoke .github` — empty): 42 real cases CI
   never executed once. Putting new tests there would mean writing them and not running them.
2. **There is no harness there.** `assert_red` / `assert_green` / `guard_test_workspace` live in
   `scripts/devops/tests/lib/harness.sh`. A second set of assertions in another directory would be a
   second vocabulary for the same thing, and the meta-guard that looks for a negative case would have
   to understand both. One of them it would understand worse.
3. **The meta-guard would have to be touched anyway.** `check-guard-tests-exist.sh` is also
   `scripts/devops/`. The zone overlap does not vanish on moving the tests, it only becomes smaller
   while breaking points 1–2.

**The boundaries of the exception are narrow, and that is part of the exception.** The narrow list
(`check-guard-tests-exist.sh` + `tests/test-pre-*.sh`) is in the core rule. Everything else in
`scripts/devops/**` is DevOps: `mutation-gate.mjs`, the `deploy` plumbing, `check-*` about prod.

Why it is safe to write this exception down at all: a violation here is **loud**. A file in someone
else's directory is visible in the diff at first glance — unlike the class of defects for which the
zones were created (an agent edits prod code to make a test go green).

## Sources

- CLAUDE.md "Multi-Agent team" + zone hints in each agent doc.
- `.claude/agents/architect.md` Zone-of-write section.
- Phase 2.5 deliverable: `docs/architecture/2026-06-03-phase2.5-deliverable.md` (live `pre-edit-write-zone-of-write.sh`).
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.2.2 (zone-of-write hook).
- PR #553 (2026-08-17) — architect-zone reconciliation, finding CR-L-1.
- PR #588 + backlog item 165 — the AutoTest zone divergence.
- PR #625 (2026-09-01) — tests-on-hooks exception, finding CR-M-2.
- ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` FM-2 — the mandatory
  "verify MAIN is clean after each Coder" post-check (the hook does not catch absolute-path writes).

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

- **Why the corpus is listed** (added 2026-10-21, PR #1067): it is the input data of the hook
  tests — `test-pre-bash-*.sh`, plus `test-hook-command-corpus.sh` and `compare-hooks-to-ref.sh`,
  which read the same corpus and match no `test-pre-*` glob — and its own header requires rows to
  be added whenever the shared command analyzer is touched. Splitting the data from the tests that
  read it would put an Architect test in one PR and the rows it asserts against in someone else's.
  The original glob simply predates anyone noticing the data file — the question was asked and
  answered once, and is written down here so it is not re-answered differently next time. The two
  extra readers are named deliberately: an earlier edition of this line said "and nothing else",
  which was false and is the kind of claim that rots unnoticed.


---

> **The AutoTest boundary runs between the test and the product code, not between directories.** The
> danger was never that AutoTest edits specs — it is that it edits **product code** to make a test go
> green. That is what is forbidden.
>

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

- **Golden rules and `RULES.md`** — the Architect edits them when the inter-agent mechanics change (a
  new hook, a new always-on rule, a new mandatory startup step). This is not "the agent's business
  logic" but the contract of the environment in which the agent works.
- **`.claude/settings*.json`** — the Architect's zone **by necessity**: a hook that is not registered
  does not exist. Writing there is allowed **only** for hook registration; `permissions`,
  `enabledPlugins`, `env` — not his.


---

- **The Architect's diffs still go through review** — a zone extension changes what does not require
  `.blocked.md`, not what does not require review.
