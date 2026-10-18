# Rules rationale — the justification layer behind `.claude/rules/common/`

**This directory is deliberately NOT auto-loaded.**

`.claude/rules/common/*.md` files without a `paths:` frontmatter block are injected into **every**
request of every session and every subagent. Files in `docs/**` are not injected at all. That is the
whole mechanism behind this split, and it is why the rationale lives here rather than in a `detail/`
subdirectory of the rules tree: the rules loader recurses into subdirectories, so a nested
`detail/` would have been auto-loaded unless every file carried a never-matching `paths:` block —
a quirk too fragile to rest a context budget on.

## What lives where

| Layer                    | Location                                      | Loaded     | Contains                                                                                                                                                                   |
| ------------------------ | --------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mechanism** (the rule) | `.claude/rules/common/<rule>.md`              | **always** | What to obey: hook ids and refusal predicates, gates, mandatory report lines, zero-tolerance patterns, commit format, exact pins, tables, classifiers, reconciliation rows |
| **Rationale** (this dir) | `docs/architecture/rules-rationale/<rule>.md` | on demand  | Why it says that: incidents and dates, precedent lists, rejected alternatives, root-cause analyses, measurement narratives, `Sources`                                      |

Each core rule carries a single pointer line near the top, of the form:

```
> Rationale, <what specifically>: docs/architecture/rules-rationale/<rule>.md
```

## When to read a rationale file

- **Before changing a rule.** Most of these files exist because someone already tried the obvious
  alternative and it failed in a specific, recorded way. `version-pins.md` and `git-policy.md` are the
  two most expensive to re-learn.
- **When a rule looks arbitrary or over-strict.** The narrow exceptions
  (`WORKTREE-OPAQUE`, the architect's `scripts/devops/` carve-out, the three pre-push gate exemptions)
  all have a written cost-benefit that explains the scope.
- **When deciding whether to add a mechanical gate.** `review-findings-transfer.md` and
  `model-routing.md` both record a deliberate _decision not to_ build a CI check, with the condition
  under which to reconsider.

## Index

- `agent-isolation.md` — the seven collision incidents, the cwd-reset verification run, the false-positive cost doctrine
- `autonomy-levels.md` — the pre-rule scatter of human checkpoints, provenance of the frontier and brief mechanics
- `doc-durability.md` — the coordinate-rot cost, why task files are excluded
- `git-policy.md` — the `--no-verify` recurrence, why the gate allowlist was inverted, why the scope list was removed
- `light-track.md` — the zombie-devserver incident, the three unbounded-wait incidents
- `live-db-access.md` — why the absolute prohibition was replaced rather than tightened; the 2026-08-18 wipe
- `model-routing.md` — the price table, the reviewer-tier reversal, the 2026-09-21 token measurement, a stale table removed
- `orchestration-routing.md` — the 15× cost figures, why the anchor is an artifact, why the pipeline is not a workflow
- `phase-boundaries.md` — provenance, and why this rule was barely cut
- `review-findings-transfer.md` — the PR #504 lost finding, the full no-CI-gate argument
- `russian-language.md` — the 2026-10-05 flip, why the filename no longer matches the rule
- `skills-invocation.md` — the 2026-07-28 table-drift incident, why the trigger list must stay whole, catalog provenance
- `stream-watchdog.md` — the seven cuts of 2026-10-17, why prevention is a rule and recovery stays a skill
- `version-pins.md` — the two peer-matched pairs people actually break, Lingui 6 upgrade preconditions
- `zone-of-write.md` — the AutoTest redraw, the 2026-08-17 precedent audit, tests-on-hooks reasoning

Rules with no file here (`mcp-first.md`) had no justification layer to separate — they are catalog and
mechanism throughout.

## Related

- `.claude/RULES.md` — the TOC over the always-on layer.
- `.claude/skills/writing-for-agents/SKILL.md` — the progressive-disclosure doctrine this split implements.
