# Rule: Skills invocation policy (mandatory triggers)

**Status:** Always-on
**Applies to:** All agents (Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus ECC-imported agents) + Master (orchestrator)
**Source:** ECC AGENTS.upstream §"Workflow Surface Policy" (skills as canonical surface) + Phase 4 deliverable (skills lifted from lessons.md) + superpowers framework expectations.

---

## The rule

If a **trigger applies** — the agent **must** invoke the skill via the `Skill` tool, not "remember" the pattern. If the skill is absent from the environment — the `Skill` tool fails with an error, that is an explicit failure (better than a silent skip).

In the final report — state which skills you invoked. Master checks.

## `when_to_use` is duplicated in the skills themselves

Each `.claude/skills/<name>/SKILL.md` now carries `when_to_use:` in the frontmatter
(Anthropic's skillify schema: leak `skills/bundled/skillify.ts`). This field is a reflection
of the table below, so the skill-loader can auto-invoke by trigger phrases. **The source of truth is
the "Trigger → Skill mapping" table in this file**; `when_to_use` in the skills mirrors it.
When changing a trigger, edit BOTH: the row in the table and `when_to_use` in the skill
(see `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` D2).

## Trigger → Skill mapping

| Trigger                                                                              | Skill                                        | Agents                               |
| ------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------ |
| A session begins (any)                                                               | `superpowers:using-superpowers`              | All                                  |
| Any creative task (feature / UI / behavior change)                                   | `superpowers:brainstorming`                  | Master, Coder                        |
| Multi-step task — before implementation                                              | `superpowers:writing-plans`                  | Coder, DevOps                        |
| Any feature / fix — before implementation                                            | `superpowers:test-driven-development`        | Coder                                |
| Bug / test failure / unexpected behavior                                             | `superpowers:systematic-debugging`           | All                                  |
| Before PR / completion claim                                                         | `superpowers:verification-before-completion` | Coder, AutoTest, DevOps              |
| PR touches auth / finance / wallets / transactions / company-account                 | `security-review`                            | Coder, Reviewer                      |
| The start of every review                                                            | `superpowers:requesting-code-review`         | Reviewer                             |
| Receiving review feedback                                                            | `superpowers:receiving-code-review`          | Coder                                |
| After writing code (cleanup)                                                         | `simplify`                                   | Coder                                |
| New page / complex UI component                                                      | `frontend-design:frontend-design`            | Coder                                |
| You write / edit text visible to a client or candidate                               | `copywriting`                                | Coder, ui-ux-designer, copy-reviewer |
| Need isolated workspace (parallel work)                                              | `superpowers:using-git-worktrees`            | Master (Coder dispatch)              |
| Implementation plan execution                                                        | `superpowers:executing-plans`                | Master, Coder                        |
| Multi-task dispatch                                                                  | `superpowers:dispatching-parallel-agents`    | Master                               |
| Branch ready to merge (a PR is being prepared)                                       | `superpowers:finishing-a-development-branch` | Coder, Master                        |
| Memory consolidation / dedup (after a merged PR)                                     | `anthropic-skills:consolidate-memory`        | Master                               |
| A fork unsolvable from the task file (before `.blocked.md` / an owner question)      | `decision-frontier`                          | All                                  |
| A bug resists / E2E flakes / a regression / "it's slow"                              | `diagnosing-bugs`                            | All                                  |
| Designing a module interface / choosing a seam / "no seam for a test"                | `codebase-design`                            | Coder, Architect, code-reviewer      |
| Safely split a giant file/module (>800 lines, god file) — the seam is already chosen | `decomposing-large-code`                     | Coder, Architect                     |
| A merge/rebase with a conflict is underway; a stack on a squashed base               | `resolving-merge-conflicts`                  | Coder, Master, DevOps                |
| A design question is not settled on paper (how it looks / how it behaves)            | `prototype`                                  | Coder, ui-ux-designer                |
| The answer lies OUTSIDE the repository (a library / someone's API / a spec / a law)  | `external-research`                          | All                                  |
| You write or clean a rule / an agent prompt / a SKILL.md / CLAUDE.md                 | `writing-for-agents`                         | Architect, Master                    |

## Project-local skills (Phase 4 lift)

Project-local + imported skills under `.claude/skills/` (16 on disk; Phase 4 laid down 7):

| Skill                         | Trigger                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright-patterns`         | Coder / AutoTest write a `.spec.ts` — strict-mode / Radix / retries / testids.                                                                     |
| `code-review-discipline`      | Reviewer formulates a Verdict / posts a review.                                                                                                    |
| `dev-flow-resilience`         | Long-running ops / MCP > 5s / silent termination / cross-session waits.                                                                            |
| `ua-tax-compliance`           | Legal mode A / B / C on the topic of FOP / Diia City / CFC / banking caps.                                                                         |
| `ua-crypto-compliance`        | Legal mode A / B on mention of USDT / VASP / AML.                                                                                                  |
| `ua-it-contract`              | Legal mode A / B on IT contract review (SENIOR / client).                                                                                          |
| `legal-escalation-patterns`   | Cross-cutting Legal escalation (when to involve an external lawyer).                                                                               |
| `claude-design-workflow`      | The orchestrator (Master / ui-ux-designer) drives Claude Design for a UI task / a handoff artifact (design-gate Tier 1/2).                         |
| `accessibility`               | UI/UX Designer / Coder: WCAG 2.2 AA — ARIA / focus / contrast / target size. **(origin: ECC)**                                                     |
| `design-system`               | UI/UX Designer Mode B / C: 10-dimension visual audit + AI-slop detection. **(origin: ECC)**                                                        |
| `frontend-design-direction`   | UI/UX Designer Mode A: purpose / audience / tone / memorable detail. **(origin: community)**                                                       |
| `make-interfaces-feel-better` | UI/UX Designer Mode D / Coder polish: concentric radius / tabular-nums / motion / hit areas. **(origin: community)**                               |
| `codebase-audit`              | Master: read-only breadth-first audit of ≥3 independent modules (fan-out → synth). **(project-local, 2026-06-22)**                                 |
| `security-review`             | security-reviewer (every dispatch) / Coder before writing an endpoint on auth-finance-RBAC paths. **(project-local, 2026-07-28)**                  |
| `copywriting`                 | Any text for a client/candidate: headings, CTA, microcopy, vacancies. Multilingual en/uk/ru/es/pt. **(project-local, 2026-08-04)**                 |
| `decision-frontier`           | A fork without the owner at the keyboard: a decision tree → extinguishing with facts → A1/A2/A3 classification. **(project-local, 2026-08-22)**    |
| `diagnosing-bugs`             | A hard bug / flake / regression: the gate "no red command — no hypotheses". **(origin: mattpocock/skills, 2026-08-22)**                            |
| `codebase-design`             | A vocabulary of deep modules + the deletion test + "design it twice". **(origin: mattpocock/skills, 2026-08-22)**                                  |
| `resolving-merge-conflicts`   | A merge/rebase conflict: resolution by intent from the primary source, never `--abort`. **(origin: mattpocock/skills, 2026-08-22)**                |
| `prototype`                   | A one-off prototype for one question: UI variants via `?variant=` or an HTML logic demo. **(origin: mattpocock/skills, 2026-08-22)**               |
| `external-research`           | Reconnaissance outward by primary sources → a citable file in the repository with an expiry date. **(project-local, 2026-08-22)**                  |
| `writing-for-agents`          | Writing and weeding documents that agents read. **(origin: mattpocock/skills, 2026-08-22)**                                                        |
| `decomposing-large-code`      | A safe split of a giant (the seam chosen): Mikado + characterization tests, leaves bottom-up, behavior-preserving. **(project-local, 2026-10-05)** |

Phase 4 laid down 7 (`playwright-patterns` … `legal-escalation-patterns`); later added/imported:
`claude-design-workflow` (2026-06-22) and 4 design/a11y skills
(`accessibility`/`design-system` — origin ECC; `frontend-design-direction`/`make-interfaces-feel-better` —
origin community); `codebase-audit` (project-local, 2026-06-22 — read-only audit-fanout, see
`orchestration-routing.md` Decision 2); `security-review` (project-local, 2026-07-28 — see below);
seven AFK-migration skills 2026-08-22 (`decision-frontier`, `external-research` — project-local;
`diagnosing-bugs`, `codebase-design`, `resolving-merge-conflicts`, `prototype`,
`writing-for-agents` — adapted from `mattpocock/skills`, see
`docs/architecture/2026-08-22-afk-pipeline-migration.md`).
**Total 23 on disk** (`ls .claude/skills/`; the PM dispatch skill was removed 2026-10-05 along with the PM agent; `decomposing-large-code` added 2026-10-05); the table above is the
source of truth. Each — in `.claude/skills/<name>/SKILL.md`. Phase 4 deliverable: `docs/architecture/2026-06-03-phase4-deliverable.md`.

## Table drift relative to the installed packs (check on plugin updates)

**Incident 2026-07-28.** The trigger table prescribed `superpowers:security-review`
and `superpowers:simplify`. Both skills are **absent** from the installed `superpowers@6.0.3`
(the pack carries 14 others). I.e. a mandatory trigger was unfulfillable precisely on the PRs
(finance / auth) it is meant to protect: `Skill` failed with "not found", and by the
rule above that is an explicit failure — but in fact agents simply continued without it.
The broken references managed to spread across 7 working files (`RULES.md` + 4 agent
docs + this file).

**Root cause:** the table was written in Phase 4 (2026-06-03) against the pack composition
of the time. An upstream-pack update silently invalidates rows — nothing binds
the table to what actually lies on disk.

**How it was fixed:** `superpowers:security-review` → project-local `security-review`
(a project delta over OWASP, the patterns confirmed by incidents #110 / #159-#161 / #164);
`superpowers:simplify` → the prefix-less `simplify` (built-in, exists).

**Check on every plugin update** (and in general when editing this table):

```bash
# what the superpowers pack actually carries
ls "$(find ~/.claude/plugins -maxdepth 6 -type d -path '*superpowers*' -name skills | head -1)"
# what lies project-local
ls .claude/skills/
# all skill references in working files
grep -rn '`[a-z-]*:\?[a-z-]*`' .claude/rules/common/skills-invocation.md
```

Reconcile line by line. Account for two catches:

1. **A skill may exist but not fit.** The built-in `security-review`
   is a **slash command** `/security-review` (in the Claude Code source —
   `commands/security-review.ts`), not a bundled skill. Its prompt runs
   `git diff origin/HEAD...` and fails
   (`fatal: ambiguous argument 'origin/HEAD...'`) in the agent environment where
   `origin/HEAD` is not configured — verified by an actual call from a subagent.
   **There is no name collision:** slash commands and `Skill(<name>)` are different invocation
   registries, so `Skill('security-review')` resolves unambiguously to our
   project-local `.claude/skills/security-review/`. For comparison, `simplify`
   from the table row — on the contrary, a real bundled skill
   (`skills/bundled/simplify.ts`), so referencing it is allowed.
2. **CI will not catch this.** Runners do not have the operator's `~/.claude/plugins`, so a
   guard script (in the spirit of `check-e2e-shard-coverage.py`) could verify only
   project-local references, not `<pack>:<skill>`. Hence — a procedural check, not a gate.

## Workflow surface policy (ECC alignment)

Per ECC `AGENTS.upstream.md` §"Workflow Surface Policy":

> `skills/` is the canonical workflow surface. New workflow contributions should land in `skills/` first. `commands/` is a legacy slash-entry compatibility surface and should only be added or updated when a shim is still required for migration or cross-harness parity.

In our repo: `commands/` is NOT used. Workflow knowledge lives in:

1. `.claude/skills/<name>/SKILL.md` — invocable knowledge primitives.
2. `.claude/agents/<agent>.md` — per-agent workflow / golden rules / mandatory tables.
3. `.claude/rules/common/*.md` — cross-cutting standards (this file and its neighbours).

## Anti-patterns

- **A mandatory table in `<agent>.md` without an up-to-date trigger** — the skill becomes "discoverable in theory" but never invoked. Master during an agent review checks: `grep skill-name .claude/agents/*.md`.
- **A "remember" pattern instead of `Skill(name)`** — each skill's content evolves; sessions without invocation work with stale knowledge.
- **Creating a SKILL.md with < 3 substantive patterns** — the Phase 4 deliverable filtered 3 candidate skills as SKIP. Do not create empty shells.

## Related rules

- `.claude/rules/common/mcp-first.md` — MCP catalog (some skills use MCP tools).
- `.claude/rules/common/zone-of-write.md` — which skills are available to whom (per-agent invocation).

## Sources

- ECC `docs/architecture/ecc-reference/AGENTS.upstream.md` §"Workflow Surface Policy"
- Phase 4 deliverable: `docs/architecture/2026-06-03-phase4-deliverable.md`
- Phase 4 viability recon: `docs/architecture/2026-06-03-phase4-skills-viability.md`
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.4 (lessons → skills)
- Superpowers framework: `~/.claude/plugins/cache/claude-plugins-official/superpowers/`
