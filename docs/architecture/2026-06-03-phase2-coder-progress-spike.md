# Phase 2 spike: `coder-progress-marker.sh` vs ECC `continuous-learning` observer

**Date:** 2026-06-03
**Author:** Migration Architect
**Scope:** ADR `2026-05-31-ecc-migration-design.md` §2.2.4 deferred decision
**Branch:** `architect/phase-2-hooks-migration`

---

## Question

ECC v2.0.0-rc.1 ships a `pre:observe:continuous-learning` and
`post:observe:continuous-learning` hook pair (matcher `*`, async,
timeout 10s; see `hooks/hooks.json` lines 38–49 & 211–222) that captures
every tool invocation for pattern extraction / skill discovery.

**Does the ECC observer cover what our `coder-progress-marker.sh` does**,
so we can delete the project-specific hook in Phase 2?

---

## Side-by-side comparison

| Dimension                          | Our `coder-progress-marker.sh`                                                                               | ECC `pre:observe`/`post:observe:continuous-learning`                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Trigger                            | PostToolUse on `Edit\|Write\|MultiEdit\|NotebookEdit`                                                        | PreToolUse + PostToolUse on `*` (every tool, both sides)                                                              |
| Scope filter                       | Hard gate: only inside `.claude/worktrees/**` (PM/user edits in main repo are ignored)                       | No scope filter — captures everything from every session                                                              |
| Sink                               | `<main-repo>/.claude/coder-activity.log` (TSV, shared across worktrees, 1 MB rotation → `.log.old`)          | ECC internal observation store (`scripts/hooks/observe-runner.js` → pattern-extraction queue, not human-readable TSV) |
| Record format                      | `<ISO ts>\t<tool>\t<branch>\t<cwd>\t<file>` — append-only, atomic single-line write                          | Internal serialized observation record for the `continuous-learning` skill miner                                      |
| Consumer                           | PM agent: `tail -n N .claude/coder-activity.log` for silent-termination detection (C1 fix from dev-flow-rca) | ECC's continuous-learning skill, optimized for cross-session pattern → skill suggestions                              |
| Latency on hot path                | Synchronous bash, ~10–30 ms                                                                                  | Async, 10 s timeout, fire-and-forget                                                                                  |
| Read-side query model              | `grep`/`awk` on TSV: `grep $branch coder-activity.log \| tail -50`                                           | Internal API only; no public CLI; format not stable yet (rc.1)                                                        |
| Cross-worktree visibility          | YES — single log file in main repo, shared by all `.claude/worktrees/*` checkouts                            | Tied to ECC's own per-session state; cross-worktree merging not documented in rc.1                                    |
| Survives session crash             | YES — file is fsync'd append-only on every write                                                             | Likely YES (async still writes), but durability semantics undocumented                                                |
| Coupling to ECC version            | Zero                                                                                                         | Tight — rc.1 internal format may change in rc.2                                                                       |
| PM recovery contract (C1 dev-flow) | Documented & lessons.md-anchored: PM reads tail to detect Coder silent termination, then rescues worktree    | Not designed for PM-side polling; ECC observer is producer-only                                                       |

---

## Verdict

**ADAPT** (keep our hook, port to ECC stable-id convention only). Do NOT delete in Phase 2.

ECC `continuous-learning` is a producer for ECC's own skill-mining pipeline.
Our `coder-progress-marker.sh` is a producer for **our PM agent's recovery
contract** (C1 from `docs/architecture/2026-05-23-dev-flow-rca.md`). They look
similar — both observe edits — but the consumers, durability guarantees,
and read-side formats are fundamentally different.

Killing our hook in Phase 2 would silently break PM's silent-termination
recovery; replacing it with the ECC observer would require reverse-engineering
rc.1's internal store format and rewriting `pm.md` Mode 2 recovery code.

---

## Justification (5 points)

1. **Consumer mismatch.** ECC observer feeds pattern extraction; our hook
   feeds PM's worktree-recovery `tail` loop. PM does not speak ECC's
   internal observation format and rc.1 doesn't expose a public read API.

2. **Documented PM contract.** `coder-activity.log` is referenced by name in
   `docs/agents/pm.md`, `docs/agents/memory/pm/lessons.md`, and
   `docs/architecture/2026-05-23-dev-flow-rca.md` C1 fix. Removing the file
   without replacing the contract breaks documented recovery behavior.

3. **Format stability.** Our TSV is a frozen interface (grep-friendly,
   diff-friendly, human-readable). ECC observation records are rc.1
   internal — format may change in rc.2/rc.3 without notice.

4. **Performance non-issue.** Our hook adds ~10–30 ms per Edit/Write inside
   worktrees only. ECC `pre:observe` already adds the same magnitude on
   every tool call (matcher `*`). Keeping ours doesn't materially worsen
   the hot path.

5. **Low cost to keep, high cost to lose.** Hook is 63 lines, zero
   dependencies, zero maintenance burden. The data it produces is load-
   bearing for PM recovery. Asymmetric trade.

---

## Re-evaluation trigger

Re-open this decision **in Phase 5** if ECC v2.0.0-rc.2+ exposes:

- A public, documented read API for the observation store, AND
- Cross-worktree aggregation semantics, AND
- A format-stability commitment (semver guarantees).

Until then: keep `coder-progress-marker.sh`.

---

## Phase 2 action

- `coder-progress-marker.sh` is **included** in `.claude/hooks-ecc-draft.json`
  under stable id `post:edit-write:coder-progress`.
- Script body is **reused as-is** from `.claude/hooks/coder-progress-marker.sh`
  (no rewrite — the bash is fine, only the ID/registration changes).
- No removal in `_removed_in_phase_2` block.

---

## Confidence

**HIGH** — comparison is grounded in source-of-truth (ECC `hooks/hooks.json`
lines 38–49 & 211–222 + ECC `hooks/README.md`) and our own dev-flow-rca
C1 anchor. Risk of being wrong: low — even if ECC observer secretly does
cover our needs, keeping our hook costs 63 LoC of bash; removing it without
proof costs PM recovery breakage in the next silent-termination incident.
