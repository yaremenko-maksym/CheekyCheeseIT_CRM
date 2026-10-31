# Rule: Skills invocation policy (mandatory triggers)

**Status:** Always-on
**Applies to:** All agents (Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus ECC-imported agents) + Master (orchestrator)

> Rationale: `docs/architecture/rules-rationale/skills-invocation.md`

---

## The rule

If a **trigger applies** — the agent **must** invoke the skill via the `Skill` tool, not "remember"
the pattern. If the skill is absent from the environment — the `Skill` tool fails with an error, that
is an explicit failure (better than a silent skip).

In the final report — state which skills you invoked. Master checks.

**The mapping below is the source of truth for triggers**: it alone states trigger, skill and which agents it binds. `when_to_use` in each `SKILL.md` and the listing `description` mirror it — change a trigger in BOTH places. A `description` over `skillListingMaxDescChars` (300) is silently cut, so the listing cannot carry a full trigger.

Each entry reads `trigger → skill · agents it applies to`.

## Trigger → Skill mapping

- A session begins (any) → `superpowers:using-superpowers` · All
- A task starts; before a large read, long command output, or new code → `token-economy` · All
- Any creative task (feature / UI / behavior change) → `superpowers:brainstorming` · Master, Coder
- Multi-step task — before implementation → `superpowers:writing-plans` · Coder, DevOps
- Any feature / fix — before implementation → `superpowers:test-driven-development` · Coder
- Bug / test failure / unexpected behavior → `superpowers:systematic-debugging` · All
- Before PR / completion claim → `superpowers:verification-before-completion` · Coder, AutoTest, DevOps
- PR touches auth / finance / wallets / transactions / company-account → `security-review` · Coder, Reviewer
- The start of every review → `superpowers:requesting-code-review` · Reviewer
- Receiving review feedback → `superpowers:receiving-code-review` · Coder
- After writing code (cleanup) → `simplify` · Coder
- New page / complex UI component → `frontend-design:frontend-design` · Coder
- You write / edit text visible to a client or candidate → `copywriting` · Coder, ui-ux-designer, copy-reviewer
- Need isolated workspace (parallel work) → `superpowers:using-git-worktrees` · Master (Coder dispatch)
- Implementation plan execution → `superpowers:executing-plans` · Master, Coder
- Multi-task dispatch → `superpowers:dispatching-parallel-agents` · Master
- Branch ready to merge (a PR is being prepared) → `superpowers:finishing-a-development-branch` · Coder, Master
- Memory consolidation / dedup (after a merged PR) → `anthropic-skills:consolidate-memory` · Master
- A fork unsolvable from the task file (before `.blocked.md` / an owner question) → `decision-frontier` · All
- A bug resists / E2E flakes / a regression / "it's slow" → `diagnosing-bugs` · All
- Designing a module interface / choosing a seam / "no seam for a test" → `codebase-design` · Coder, Architect, code-reviewer
- Safely split a giant file/module (>800 lines, god file) — the seam is already chosen → `decomposing-large-code` · Coder, Architect
- A merge/rebase with a conflict is underway; a stack on a squashed base → `resolving-merge-conflicts` · Coder, Master, DevOps
- A design question is not settled on paper (how it looks / how it behaves) → `prototype` · Coder, ui-ux-designer
- The answer lies OUTSIDE the repository (a library / someone's API / a spec / a law) → `external-research` · All
- You write or clean a rule / an agent prompt / a SKILL.md / CLAUDE.md → `writing-for-agents` · Architect, Master

## Project-local skills

Project-local + imported skills under `.claude/skills/` (24 on disk). This catalog is machine-checked
against the disk by `scripts/architect/check-skill-registry.mjs` (CI workflow
`check-skill-registry.yml`) — a row here with no directory, or a directory with no row, fails CI.

| Skill                         | Trigger                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `playwright-patterns`         | Coder / AutoTest write a `.spec.ts` — strict-mode / Radix / retries / testids.                                             |
| `code-review-discipline`      | Reviewer formulates a Verdict / posts a review.                                                                            |
| `dev-flow-resilience`         | Long-running ops / MCP > 5s / silent termination / cross-session waits.                                                    |
| `ua-tax-compliance`           | Legal mode A / B / C on the topic of FOP / Diia City / CFC / banking caps.                                                 |
| `ua-crypto-compliance`        | Legal mode A / B on mention of USDT / VASP / AML.                                                                          |
| `ua-it-contract`              | Legal mode A / B on IT contract review (SENIOR / client).                                                                  |
| `legal-escalation-patterns`   | Cross-cutting Legal escalation (when to involve an external lawyer).                                                       |
| `claude-design-workflow`      | The orchestrator (Master / ui-ux-designer) drives Claude Design for a UI task / a handoff artifact (design-gate Tier 1/2). |
| `accessibility`               | UI/UX Designer / Coder: WCAG 2.2 AA — ARIA / focus / contrast / target size.                                               |
| `design-system`               | UI/UX Designer Mode B / C: 10-dimension visual audit + AI-slop detection.                                                  |
| `frontend-design-direction`   | UI/UX Designer Mode A: purpose / audience / tone / memorable detail.                                                       |
| `make-interfaces-feel-better` | UI/UX Designer Mode D / Coder polish: concentric radius / tabular-nums / motion / hit areas.                               |
| `codebase-audit`              | Master: read-only breadth-first audit of ≥3 independent modules (fan-out → synth).                                         |
| `security-review`             | security-reviewer (every dispatch) / Coder before writing an endpoint on auth-finance-RBAC paths.                          |
| `copywriting`                 | Any text for a client/candidate: headings, CTA, microcopy, vacancies. Multilingual en/uk/ru/es/pt.                         |
| `decision-frontier`           | A fork without the owner at the keyboard: a decision tree → extinguishing with facts → A1/A2/A3 classification.            |
| `diagnosing-bugs`             | A hard bug / flake / regression: the gate "no red command — no hypotheses".                                                |
| `codebase-design`             | A vocabulary of deep modules + the deletion test + "design it twice".                                                      |
| `resolving-merge-conflicts`   | A merge/rebase conflict: resolution by intent from the primary source, never `--abort`.                                    |
| `prototype`                   | A one-off prototype for one question: UI variants via `?variant=` or an HTML logic demo.                                   |
| `external-research`           | Reconnaissance outward by primary sources → a citable file in the repository with an expiry date.                          |
| `writing-for-agents`          | Writing and weeding documents that agents read.                                                                            |
| `token-economy`               | Every task start; before a large read / long output / new code: terse narration, bounded reads, bulk output to a file.     |
| `decomposing-large-code`      | A safe split of a giant (the seam chosen): Mikado + characterization tests, leaves bottom-up, behavior-preserving.         |

## Reconcile this table on every plugin update

A `<pack>:<skill>` row can become unfulfillable when an upstream pack changes composition, and
nothing binds the table to what lies on disk. CI cannot catch it (runners have no operator
`~/.claude/plugins`), so this is a **procedural** check — run it when editing this table or updating plugins:

Compare `ls` of the superpowers pack's `skills` dir (under `~/.claude/plugins`), `ls .claude/skills/`, and `grep -rn` of skill references in this file.

Reconcile line by line. Two catches (details: rationale file): the built-in `security-review` is a slash command, not a skill — `Skill('security-review')` resolves to the project-local one; `simplify` is a real bundled skill, so it stays prefix-less.

## Workflow surface policy

`commands/` is NOT used in this repo. Workflow knowledge lives in:

Workflow knowledge lives in `.claude/skills/<name>/SKILL.md` (invocable), `.claude/agents/<agent>.md` (workflow / golden rules) and `.claude/rules/common/*.md` (cross-cutting standards).

## Anti-patterns

- A mandatory table in `<agent>.md` needs an up-to-date trigger: check with `grep skill-name .claude/agents/*.md`.
- Invoke `Skill(name)` rather than "remembering" a pattern; skill content evolves.
- Create a SKILL.md only with ≥ 3 substantive patterns.

## Related rules

- `.claude/rules/common/mcp-first.md` — MCP catalog (some skills use MCP tools).
- `.claude/rules/common/zone-of-write.md` — which skills are available to whom (per-agent invocation).
