# Skills catalog — project-local skills and the reconcile procedure

> Moved out of the always-on `.claude/rules/common/skills-invocation.md` (2026-11-08) to cut
> per-request tokens. The trigger → skill mapping stays there; it is still the source of truth for
> triggers. Read this file when you add, rename or remove a skill, change a trigger, or update plugins.
> `scripts/architect/check-skill-registry.mjs` reads the "Project-local skills" section below.

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

```bash
# what the superpowers pack actually carries
ls "$(find ~/.claude/plugins -maxdepth 6 -type d -path '*superpowers*' -name skills | head -1)"
# what lies project-local
ls .claude/skills/
# all skill references in working files
grep -rn '`[a-z-]*:\?[a-z-]*`' .claude/rules/common/skills-invocation.md
```

Reconcile line by line. Two catches (details: `docs/architecture/rules-rationale/skills-invocation.md`): the built-in `security-review` is a slash command, not a skill — `Skill('security-review')` resolves to the project-local one; `simplify` is a real bundled skill, so it stays prefix-less.
