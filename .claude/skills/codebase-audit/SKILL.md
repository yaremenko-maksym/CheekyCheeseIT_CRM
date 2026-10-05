---
name: codebase-audit
description: Read-only breadth-first audit of ≥3 independent repository modules via parallel fan-out (N × haiku explore → opus synthesis → adversarial check). Use when the orchestrator needs a wide sweep that exceeds one context window.
when_to_use: "Use when Master launches a breadth-first read-only audit of ≥3 independent modules, the material exceeds one context window, with NO code writes (Decision 2 of orchestration-routing). Examples: 'RBAC sweep of all controllers', 'find dead code across the whole repo', 'security surface across all modules', 'how X works across the whole codebase', 'dependency/secrets audit', 'inventory before a refactor'."
---

# Codebase Audit — read-only breadth-first fan-out

**When:** only when `orchestration-routing.md` **Decision 2** matched — ≥3 independent
modules/controllers, material > one context window, **read-only** (agents write nothing to code).
This is the ONLY case where parallel fan-out carries new value over Master's direct dispatch.

**When NOT to launch (→ ordinary single-agent pipeline):**

- < 3 modules, or the areas overlap → one agent is cheaper and without context-thrash.
- Code WRITE is needed (fix/refactor) → that is Master's ordinary pipeline (coder → review), not an audit.
- The question fits one context ("how does this one service work") → read it directly via `codegraph`/Read.

## Shape (fan-out → synth → verify)

```
RECON (1 cheap pass)       → build the map: list of modules/files, split into N disjoint slices
   │
FAN-OUT (waves ≤ 3-4)      → N × explore agent (model=haiku), each OWNS its slice,
   │                          returns a STRUCTURED result (not prose) on a fixed schema
SYNTH (1 agent, opus)      → gather all slices into one report with prioritization (H/M/L)
   │
VERIFY (opt., fresh)       → adversarial check of the top findings (refute-prompt), cull false-positives
```

The engine is the **Workflow tool** (`parallel`/`pipeline` with a `schema` output) OR
`superpowers:dispatching-parallel-agents`. The Workflow script is preferable when there are many slices
and deterministic collection is needed; dispatching-parallel-agents — for ad-hoc 3-5 agents.

## Rules (what makes this audit reliable)

1. **Each worker OWNS a non-overlapping slice** (explicit list of files/paths in the prompt) — otherwise
   agents duplicate work and return overlaps. Disjoint = cheaper and more complete.
2. **Structured schema output, not prose.** A worker returns a typed object (for example
   `{ slice, findings: [{ issue, evidence: "file:line", severity }], coverage }`). Synth branches
   on machine fields, does not parse the narrative.
3. **Workers are `model=haiku`** (read-only recon, `model-routing.md` downgrade). Synth is `opus`
   (judgment-heavy prioritization). No writes: the read-only gate is mandatory.
4. **Waves ≤ 3-4 concurrent** (`light-track.md` "Concurrency ceiling"): 5+ starts in one
   message → 529/CPU-starvation. Dispatch in waves, stagger. After completed waves —
   sweep zombie dev-ports if the workers brought anything up (for read-only usually not needed).
5. **Adversarial verify of the top findings** with a fresh agent (scope = "try to refute"), so that
   plausible-but-wrong findings do not survive into the report. Precedent — both phases of this audit and
   the `review-branch` logic.
6. **Evidence is mandatory:** each finding carries `file:line` or a quote. "There seems to be a problem"
   without proof → culled at synth.

## Anti-patterns

- **Fan-out on 1-2 modules / overlapping areas** — over-spawn (~15× tokens), one agent is better.
- **Writing code during the audit** — the audit is read-only; fixes go as a separate task in Master's pipeline.
- **Prose instead of a schema** — synth cannot aggregate deterministically; it will "drift apart".
- **One giant worker over the whole repo** — the point of fan-out is lost; either it fits one context (then
  fan-out is not needed), or it does not (then disjoint slices are needed).
- **Open loop without a cap** — fix the number of waves/workers in advance (effort-scaling: a survey = 2-4,
  a deep audit = more in waves); not "spawn until bored".

## Tracking

Launching an audit → `routing_decision` in the task file / Master's notes (`track: "audit-fanout"`, `reason`) —
as in `orchestration-routing.md`. This makes the launch auditable (a non-standard track is recorded explicitly).

## Related

- `.claude/rules/common/orchestration-routing.md` — Decision 2 (when to launch audit-fanout at all).
- `.claude/rules/common/model-routing.md` — haiku for read-only recon, opus for synth.
- `.claude/rules/common/light-track.md` — concurrency ceiling (waves ≤ 3-4) + zombie-port sweep.
- `superpowers:dispatching-parallel-agents` — alternative engine for ad-hoc 3-5 workers.
