# Rule: A long-lived record describes behaviour, not coordinates

**Status:** Always-on
**Applies to:** Everyone who writes to the backlog, `.out-of-scope/`, an ADR, `memory/*/lessons.md`, the body of a closed issue.
**Source:** Study of `mattpocock/skills` (`triage/AGENT-BRIEF.md`, "durability over precision"). ADR: `docs/architecture/2026-08-22-afk-pipeline-migration.md` item 9.

---

## Why

A record with a lifespan of months, written as "`mutation-gate.mjs:154`", stops being
true before anyone gets to it, and **does not announce it**. Verification costs more than
the original finding: part of the 2026-08-17 session went to live re-reading of `origin/main` to answer
"which backlog coordinates are still correct".

The error is not in precision but in the **choice of carrier for precision**: a path and a line number are a property
of the working copy at the moment of writing, not a property of the finding.

## The rule

A record with a lifespan of **more than one day** describes:

- **behaviour** — what the system does now and what it should do;
- **interfaces and types** — symbol names, signatures, the shape of config;
- **a verification condition** — how to confirm the finding is still alive.

and does **not** describe:

- file paths as the sole address of a finding;
- line numbers — never, in any form;
- the current implementation structure as a given.

**A symbol instead of a coordinate.** `resolveDropShare` is found with grep and survives a file move;
`finance.service.ts:412` does not. If a finding has no stable symbol at all, that is a sign
the finding is phrased about a place, not about behaviour: rephrase it.

## Where it applies

| Carrier                              | Lifespan            | Rule applies |
| ------------------------------------ | ------------------- | ------------ |
| `.claude/tasks/BACKLOG-followups.md` | months              | **yes**      |
| `.out-of-scope/*.md`                 | forever             | **yes**      |
| `docs/architecture/**` (ADR)         | forever             | **yes**      |
| `.claude/agents/memory/*/lessons.md` | until consolidation | **yes**      |
| Body of a closed issue / PR          | forever             | **yes**      |
| `.claude/tasks/task-<slug>.md`       | hours               | **no**       |
| agent dispatch prompt                | minutes             | **no**       |
| review comment on a live PR          | days                | **no**       |

## Why task files are deliberately excluded

They are read the same day, and the orchestrator's coordinator discipline **requires** concrete paths and
line numbers: it is proof that Master synthesized the finding himself rather than offloading the understanding onto
the executor. Forbidding them there would mean fixing one rule with another.

The boundary runs along lifespan, not along document type.

## How we know it is violated

```bash
# a line number in a long-lived record
grep -nE '\.(ts|tsx|mjs|js|sql|sh|md):[0-9]+' .claude/tasks/BACKLOG-followups.md .out-of-scope/*.md docs/architecture/*.md
```

A match is a finding. There is exactly one exception: a **historical fact**, where the coordinate is the whole point
("the incident reproduced on line X of version Y"), and it is marked as historical.

## Related rules

- `.claude/rules/common/light-track.md` — what even gets into the backlog.
- `.claude/agents/contracts.md` — Master task orchestration: why coordinates are mandatory in task files (coordinator discipline).
- `CONTEXT.md` — stable names of concepts in which behaviour is phrased.
